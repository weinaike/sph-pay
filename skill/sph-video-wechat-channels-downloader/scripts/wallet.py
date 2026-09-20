#!/usr/bin/env python3
"""匿名钱包（user_token）管理：余额/已购/购买资源包的唯入口。

token 是余额凭证：落盘 ~/.config/sph/user_token（0600），丢失即丢余额——开户后提醒用户备份此文件。

用法（一律用 ensure_deps.py --python 输出的解释器调用）：
  wallet.py ensure          # 读 token；无则 POST /api/user 匿名开户并落盘；打印 token
  wallet.py me              # 查余额/已购（X-User-Token）
  wallet.py buy A|B|C       # 购买资源包 → {order_id, order_token, code_url, amount_cents, granted, notice}
                            # code_url 给 qr.py 渲染支付码；支付后用 poll.py --terminal credited 轮询到账
"""
import argparse
import json
import os
import stat
import sys
import urllib.error
import urllib.request

API_BASE = os.environ.get("SPH_API_BASE", "https://sph.yes-tek.com")  # 后者=生产内置；本地联调可覆盖
WALLET_DIR = os.path.join(os.path.expanduser("~"), ".config", "sph")
WALLET_FILE = os.path.join(WALLET_DIR, "user_token")


def _read_token():
    try:
        with open(WALLET_FILE, encoding="utf-8") as f:
            t = f.read().strip()
        return t or None
    except OSError:
        return None


def _save_token(token):
    os.makedirs(WALLET_DIR, mode=0o700, exist_ok=True)
    with open(WALLET_FILE, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    try:
        os.chmod(WALLET_FILE, stat.S_IRUSR | stat.S_IWUSR)  # 余额凭证，只留属主读写
    except OSError:
        pass


def _req(method, path, token=None, body=None):
    headers = {"Content-Type": "application/json", "User-Agent": "sph-wallet/1"}
    if token:
        headers["X-User-Token"] = token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API_BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": "bad_response"}


def cmd_ensure():
    token = _read_token()
    if token:
        print(token)
        return 0
    status, j = _req("POST", "/api/user")
    if status != 201 or "user_token" not in j:
        print(f"开户失败 HTTP {status}: {json.dumps(j, ensure_ascii=False)}", file=sys.stderr)
        return 1
    _save_token(j["user_token"])
    print(j["user_token"])
    print(f"已开户并保存到 {WALLET_FILE}（此文件是余额凭证，丢失无法找回，请提醒用户备份）",
          file=sys.stderr)
    return 0


def cmd_me():
    token = _read_token()
    if not token:
        print("尚无钱包，先运行 wallet.py ensure", file=sys.stderr)
        return 1
    status, j = _req("GET", "/api/user/me", token=token)
    print(json.dumps(j, ensure_ascii=False, indent=2))
    return 0 if status == 200 else 1


def cmd_buy(pkg):
    token = _read_token()
    if not token:
        print("尚无钱包，先运行 wallet.py ensure", file=sys.stderr)
        return 1
    status, j = _req("POST", "/api/package", token=token, body={"package": pkg})
    print(json.dumps(j, ensure_ascii=False, indent=2))
    if status != 200:
        return 1
    print(f"\n下一步：qr.py 渲染 code_url → 用户扫码 → poll.py --order {j['order_id']} "
          f"--token {j['order_token']} --terminal credited", file=sys.stderr)
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ensure")
    sub.add_parser("me")
    b = sub.add_parser("buy")
    b.add_argument("package", choices=["A", "B", "C"])
    a = p.parse_args()
    return {"ensure": cmd_ensure, "me": cmd_me, "buy": lambda: cmd_buy(a.package)}[a.cmd]()


if __name__ == "__main__":
    sys.exit(main())
