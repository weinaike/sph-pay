#!/usr/bin/env python3
"""轮询订单状态直到终态。

退出码：0=resolved  2=超时pending  3=失败/退款/过期

节流：3s 一次（前 30s）、之后 5s，带 ±20% 抖动。
若服务端仍返回 429（源站 nginx 限流），自动退避 15s，连续命中翻倍（上限 60s），无需人工介入。
"""
import argparse, json, os, random, sys, time, urllib.error, urllib.request

API_BASE = os.environ.get("SPH_API_BASE", "https://sph.yes-tek.com")  # 后者=生产内置；本地联调可覆盖
TIMEOUT = 300            # 轮询上限（秒）
RATE_LIMIT_BACKOFF = 15  # 首次命中 429 的退避（秒），连续命中翻倍
RATE_LIMIT_MAX = 60      # 退避上限（秒）


def interval(elapsed):
    base = 3.0 if elapsed < 30 else 5.0
    return base * random.uniform(0.8, 1.2)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--order", required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--terminal", default="resolved",
                   help="成功终态：单视频订单 resolved（默认）；资源包订单 credited")
    a = p.parse_args()

    url = f"{API_BASE}/api/order/{a.order}/status?token={a.token}"
    start = time.time()

    status = "unknown"
    hits_429 = 0
    while True:
        elapsed = time.time() - start
        sleep_for = interval(elapsed)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sph-poll/2"})
            with urllib.request.urlopen(req, timeout=10) as r:
                j = json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                hits_429 += 1
                sleep_for = min(RATE_LIMIT_BACKOFF * (2 ** (hits_429 - 1)), RATE_LIMIT_MAX)
                print(f"[{int(elapsed):>3}s] 429 限流（连续 {hits_429} 次），退避 {sleep_for}s",
                      file=sys.stderr, flush=True)
            else:
                print(f"查询失败: {e}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"查询失败: {e}", file=sys.stderr, flush=True)
        else:
            hits_429 = 0
            status = j.get("status")
            print(f"[{int(elapsed):>3}s] {status} — {j.get('message', '')}", flush=True)
            if status == a.terminal or (status == "credited" and a.terminal == "resolved"):
                # 默认模式下 credited（套餐到账）也视为成功终态，防误判超时
                print("CREDITED" if status == "credited" else "RESOLVED")
                sys.exit(0)
            if status in ("refunded", "failed", "expired"):
                print(j.get("message", status))
                sys.exit(3)

        if elapsed > TIMEOUT:
            print(f"超时（{TIMEOUT}s），当前状态 {status}。二维码有效期内付款后可随时重新轮询。")
            sys.exit(2)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
