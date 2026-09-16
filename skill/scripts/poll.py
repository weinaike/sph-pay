#!/usr/bin/env python3
"""轮询订单状态直到终态。退出码：0=resolved 2=超时pending 3=失败/退款/过期 4=参数或网络错误"""
import argparse, json, sys, time, urllib.request

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--api", required=True)
    p.add_argument("--order", required=True)
    p.add_argument("--token", required=True)
    a = p.parse_args()

    url = f"{a.api.rstrip('/')}/api/order/{a.order}/status?token={a.token}"
    start = time.time()
    while True:
        elapsed = time.time() - start
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                j = json.loads(r.read())
        except Exception as e:
            print(f"查询失败: {e}", file=sys.stderr)
            time.sleep(5); continue
        status = j.get("status")
        left = 300 - elapsed
        print(f"[{int(elapsed):>3}s] {status} — {j.get('message','')}", flush=True)
        if status == "resolved":
            print("RESOLVED"); sys.exit(0)
        if status in ("refunded", "failed", "expired"):
            print(j.get("message", status)); sys.exit(3)
        if elapsed > 300:
            print(f"超时（5min），当前状态 {status}。二维码有效期内付款后可随时重新轮询。"); sys.exit(2)
        time.sleep(3 if elapsed < 30 else 5)
        _ = left

if __name__ == "__main__":
    main()
