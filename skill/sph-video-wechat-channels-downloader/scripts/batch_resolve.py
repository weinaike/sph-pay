#!/usr/bin/env python3
"""批量短链→直链（额度通道 /api/resolve）。

逐条顺序处理（每条解析 3~6s，服务端限频 10 条/min/token，串行节奏刚好）：
  成功        → 记录 {url, title, file_size}，结果文件每条即时落盘（中断后 --skip 续跑）
  单条解析失败 → 服务端已自动返还该条额度，标记 failed 继续下一条
  402 额度不足  → 中断（未处理条目标记 skipped），退出码 2 —— 按剩余条数购套餐后续跑
  429          → 自动退避重试（15s 起翻倍上限 60s）
  401          → 钱包 token 失效，退出码 3

用法：
  batch_resolve.py urls.txt                       # 每行一条 weixin.qq.com/sph/ 短链
  batch_resolve.py urls.txt --skip prev.json      # 跳过上次已成功的条目（断点续跑）
  batch_resolve.py urls.txt --out r.json          # 结果文件（默认 ./sph-downloads/.batch/<时间戳>.json）

退出码：0=全部处理完（个别失败看输出） 2=额度不足中断 3=致命错误（钱包/参数）
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API_BASE = os.environ.get("SPH_API_BASE", "https://sph.yes-tek.com")  # 后者=生产内置；本地联调可覆盖
WALLET_FILE = os.path.join(os.path.expanduser("~"), ".config", "sph", "user_token")
RATE_BACKOFF = 15
RATE_MAX = 60


def read_token():
    try:
        with open(WALLET_FILE, encoding="utf-8") as f:
            t = f.read().strip()
        if t:
            return t
    except OSError:
        pass
    print("尚无钱包，先运行 wallet.py ensure", file=sys.stderr)
    sys.exit(3)


def resolve_one(token, url):
    """→ (state, payload)：state ∈ ok | quota | failed | auth"""
    data = json.dumps({"url": url}).encode()
    req = urllib.request.Request(
        API_BASE + "/api/resolve", data=data,
        headers={"Content-Type": "application/json", "X-User-Token": token, "User-Agent": "sph-batch/1"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return "ok", json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except Exception:
            body = {}
        if e.code == 402:
            return "quota", body
        if e.code == 401:
            return "auth", body
        if e.code == 503:
            return "failed", body
        raise  # 400 等参数错：链接本身有问题，抛给上层按 failed 处理


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("urls_file", help="每行一条短链；'-' 读 stdin")
    ap.add_argument("--out", default="")
    ap.add_argument("--skip", default="", help="上次结果文件：跳过其中 ok 的条目")
    a = ap.parse_args()

    raw = sys.stdin.read() if a.urls_file == "-" else open(a.urls_file, encoding="utf-8").read()
    urls = [u.strip() for u in raw.splitlines() if u.strip().startswith("https://weixin.qq.com/sph/")]
    if not urls:
        print("输入中没有 weixin.qq.com/sph/ 短链", file=sys.stderr)
        return 3

    done = set()
    if a.skip:
        try:
            prev = json.load(open(a.skip, encoding="utf-8"))
            done = {t for t, v in prev.get("results", {}).items() if v.get("state") == "ok"}
        except Exception as e:
            print(f"--skip 文件读取失败（忽略）：{e}", file=sys.stderr)

    out_dir = os.path.join(".", "sph-downloads", ".batch")
    out_path = a.out or os.path.join(out_dir, f"batch-{int(time.time())}.json")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    token = read_token()
    results = {}
    quota_exhausted = False
    hits_429 = 0

    def flush():
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"results": results, "out": out_path}, f, ensure_ascii=False, indent=1)

    for i, url in enumerate(urls, 1):
        if url in done:
            print(f"[{i}/{len(urls)}] 跳过（上次已成功） {url}")
            continue
        while True:  # 429 重试环
            try:
                state, body = resolve_one(token, url)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    hits_429 += 1
                    wait = min(RATE_BACKOFF * (2 ** (hits_429 - 1)), RATE_MAX)
                    print(f"[{i}/{len(urls)}] 429 限流，退避 {wait}s", file=sys.stderr, flush=True)
                    time.sleep(wait)
                    continue
                state, body = "failed", {"error": f"HTTP {e.code}"}
            except Exception as e:
                state, body = "failed", {"error": str(e)}

            if state == "ok":
                hits_429 = 0
                results[url] = {"state": "ok", "url": body.get("url"), "title": body.get("title"),
                                "file_size": body.get("file_size"), "charged": body.get("charged")}
                print(f"[{i}/{len(urls)}] ✓ {body.get('title', '')[:36]} "
                      f"({(body.get('file_size') or 0) // 1048576}MB"
                      f"{'' if body.get('charged') else '，24h内免重扣'})", flush=True)
            elif state == "quota":
                results[url] = {"state": "skipped_quota"}
                quota_exhausted = True
                print(f"[{i}/{len(urls)}] ✗ 额度不足中断：{body.get('message', '')[:80]}", flush=True)
            elif state == "auth":
                print(f"钱包 token 失效（{body.get('message', '')}）：重新开户会失去原余额，"
                      f"请先确认 {WALLET_FILE} 是否被误删", file=sys.stderr)
                flush()
                return 3
            else:
                hits_429 = 0
                results[url] = {"state": "failed", "error": (body or {}).get("error"),
                                "message": (body or {}).get("message", "")[:120]}
                print(f"[{i}/{len(urls)}] ✗ 解析失败（额度已自动返还） "
                      f"{(body or {}).get('message', '')[:60]}", flush=True)
            break

        flush()
        if quota_exhausted:
            break
        if i < len(urls):
            time.sleep(6.5)  # 服务端 10 条/min/token 限频；每条解析本身还要 3~6s，此间隔保证不触限

    ok = sum(1 for v in results.values() if v["state"] == "ok")
    failed = sum(1 for v in results.values() if v["state"] == "failed")
    skipped = len(urls) - ok - failed
    print(f"\n完成：成功 {ok} / 失败 {failed} / 未处理（额度不足或跳过） {skipped}")
    print(f"结果文件：{os.path.abspath(out_path)}（重试用 --skip 该文件）")
    if quota_exhausted:
        print("额度不足：购资源包后 --skip 续跑（档位与价格见 render_order.py --dump-packages，勿凭记忆报价）")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
