#!/usr/bin/env python3
"""轮询订单状态直到终态；或轮询批量解析任务直到完成并落盘结果。

两种模式：
  订单：poll.py --order <id> --token <t> [--terminal resolved|credited]
        退出码 0=resolved/credited  2=超时pending  3=失败/退款/过期
  批量：poll.py --batch <batch_id> [--out <结果文件>]
        钱包 token 自动取 ~/.config/sph/user_token（同 wallet.py）；
        轮询到 done 后把逐条结果（含直链/标题/体积/元数据）写入结果文件，退出码
        0=完成（全部或部分成功）  2=超时仍在跑  3=批不存在/鉴权失败

节流：订单 3s 一次（前 30s）、之后 5s；批量 10s。均带 ±20% 抖动。
429 自动退避 15s 起翻倍（上限 60s），无需人工介入。
"""
import argparse, json, os, random, sys, time, urllib.error, urllib.request

API_BASE = os.environ.get("SPH_API_BASE", "https://sph.yes-tek.com")  # 后者=生产内置；本地联调可覆盖
TIMEOUT = 300             # 订单轮询上限（秒）
BATCH_TIMEOUT = 1800      # 批量轮询上限（秒）：100 条 × 逐条解析 ~5-10s
RATE_LIMIT_BACKOFF = 15   # 首次命中 429 的退避（秒），连续命中翻倍
RATE_LIMIT_MAX = 60       # 退避上限（秒）
TOKEN_PATH = os.path.expanduser("~/.config/sph/user_token")


def interval(elapsed, base):
    return base * random.uniform(0.8, 1.2)


def get_json(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "sph-poll/3", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def read_user_token():
    try:
        return open(TOKEN_PATH).read().strip()
    except OSError:
        sys.exit(f"找不到钱包 token（{TOKEN_PATH}）：先跑 wallet.py ensure 开户")


def poll_batch(batch_id, out_path):
    token = read_user_token()
    url = f"{API_BASE}/api/resolve/batch/{batch_id}"
    start = time.time()
    hits_429 = 0
    while True:
        elapsed = time.time() - start
        sleep_for = interval(elapsed, 10.0)
        try:
            j = get_json(url, {"x-user-token": token})
        except urllib.error.HTTPError as e:
            if e.code == 429:
                hits_429 += 1
                sleep_for = min(RATE_LIMIT_BACKOFF * (2 ** (hits_429 - 1)), RATE_LIMIT_MAX)
                print(f"[{int(elapsed):>4}s] 429 限流（连续 {hits_429} 次），退避 {sleep_for}s", file=sys.stderr, flush=True)
            elif e.code in (401, 404):
                sys.exit(f"批任务不可用（{e.code}）：{batch_id}")
            else:
                print(f"查询失败: {e}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"查询失败: {e}", file=sys.stderr, flush=True)
        else:
            hits_429 = 0
            done = j.get("resolved_count", 0) + j.get("failed_count", 0) + j.get("skipped_count", 0)
            print(f"[{int(elapsed):>4}s] {j.get('status')} — 进度 {done}/{j.get('total')}"
                  f"（成功 {j.get('resolved_count')} / 失败返还 {j.get('failed_count')} / 跳过 {j.get('skipped_count')}）", flush=True)
            if j.get("status") == "done":
                os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(j, f, ensure_ascii=False, indent=1)
                ok = [i for i in j.get("items", []) if i.get("cdn_url")]
                print(f"BATCH_DONE: {len(ok)} 条成功，结果已写入 {out_path}"
                      f"{'' if not j.get('skipped_count') else '；' + str(j['skipped_count']) + ' 条因额度不足跳过'}")
                sys.exit(0)

        if elapsed > BATCH_TIMEOUT:
            print(f"超时（{BATCH_TIMEOUT}s）仍在跑；稍后可用同命令重查（服务端断点续跑，已扣费不重扣）。")
            sys.exit(2)
        time.sleep(sleep_for)


def poll_order(order_id, token, terminal):
    url = f"{API_BASE}/api/order/{order_id}/status?token={token}"
    start = time.time()
    status = "unknown"
    hits_429 = 0
    while True:
        elapsed = time.time() - start
        sleep_for = interval(elapsed, 3.0 if elapsed < 30 else 5.0)
        try:
            j = get_json(url)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                hits_429 += 1
                sleep_for = min(RATE_LIMIT_BACKOFF * (2 ** (hits_429 - 1)), RATE_LIMIT_MAX)
                print(f"[{int(elapsed):>3}s] 429 限流（连续 {hits_429} 次），退避 {sleep_for}s", file=sys.stderr, flush=True)
            else:
                print(f"查询失败: {e}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"查询失败: {e}", file=sys.stderr, flush=True)
        else:
            hits_429 = 0
            status = j.get("status")
            print(f"[{int(elapsed):>3}s] {status} — {j.get('message', '')}", flush=True)
            if status == terminal or (status == "credited" and terminal == "resolved"):
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--order", help="订单模式：订单 id")
    p.add_argument("--token", help="订单模式：order_token")
    p.add_argument("--terminal", default="resolved",
                   help="成功终态：单视频订单 resolved（默认）；资源包订单 credited")
    p.add_argument("--batch", help="批量模式：batch_id（结果落 --out 文件）")
    p.add_argument("--out", help="批量模式结果文件路径（默认 ./sph-downloads/batch-<id>.json）")
    a = p.parse_args()

    if a.batch:
        out = a.out or f"./sph-downloads/batch-{a.batch}.json"
        poll_batch(a.batch, out)
    elif a.order and a.token:
        poll_order(a.order, a.token, a.terminal)
    else:
        p.error("需要 --order+--token（订单模式）或 --batch（批量模式）")


if __name__ == "__main__":
    main()
