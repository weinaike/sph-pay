#!/usr/bin/env python3
"""AI 按量付费（A2M/402 协议，支付宝）客户端：出账单 → 收银下单 → Payment-Proof 重试 → 交付。

流程对齐支付宝官方五语言示例与 alipay-aipay skill 联调脚本（local_402_sandbox_pay.py）：
  1. GET /api/a2m/resolve?url=<短链> → 402 + Payment-Needed Header（Base64URL 账单）
  2. 账单 snake→camel，补买家字段，POST 收银下单接口 → payScheme（付款链接）+ tradeNo
  3. 用户在付款链接完成支付后，构造 Payment-Proof Header 重试原请求 → 200 + 交付物 + Payment-Validation

状态落盘 ./sph-downloads/.a2m/<out_trade_no>.json（cwd 记绝对路径，供跨会话恢复）。

用法（python3 直跑，仅标准库）：
  a2m.py bill --url <视频号分享短链> [--buyer <买家2088>]          # 沙箱联调：出账单+收银下单 → 付款链接
  a2m.py bill --no-cashier --url <视频号分享短链>                   # 生产：仅出账单（支付由用户侧官方支付
                                                                    #  skill npx -y @alipay/agent-payment 完成）
  a2m.py deliver <state.json> [--payment-proof <proof>]            # Proof 重试 → 交付（音频/文字稿未就绪时
                                                                    #  自动用同一 Proof 轮询到终态）
  a2m.py transcript <delivery.json> [--out-dir ./sph-downloads]    # 交付 JSON 里的文字稿落盘 <标题>.txt/.srt
环境变量：SPH_API_BASE（默认 https://sph.yes-tek.com）、A2M_PAY_ENDPOINT（沙箱收银下单接口）、
          A2M_PAY_URL_PREFIX（付款链接前缀）、A2M_BUYER_ID（默认买家）、A2M_BUYER_SIGNATURE。
注意：收银下单端点只有沙箱模拟器（生产支付在用户侧官方支付 skill 内完成，商户侧无此接口）。
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API_BASE = os.environ.get("SPH_API_BASE", "https://sph.yes-tek.com").rstrip("/")
# 收银下单接口：沙箱为 alipaydev 域名；生产以支付宝 AI 付平台提供的确切地址为准（勿猜）
PAY_ENDPOINT = os.environ.get(
    "A2M_PAY_ENDPOINT", "http://aicashier.dl.alipaydev.com/openclawpay/agent/v1/pay"
)
PAY_URL_PREFIX = os.environ.get(
    "A2M_PAY_URL_PREFIX",
    "https://render.alipay.com/p/yuyan/180020010001290755/pay.html?schema=",
)
DEFAULT_BUYER = os.environ.get("A2M_BUYER_ID", "")
DEFAULT_BUYER_SIGNATURE = os.environ.get("A2M_BUYER_SIGNATURE", "-")
STATE_DIR_NAME = ".a2m"
UA = "sph-a2m/1"

# 账单必含字段（缺失即协议异常，不猜测）
BILL_REQUIRED = (
    ("protocol", "out_trade_no"), ("protocol", "amount"), ("protocol", "currency"),
    ("protocol", "resource_id"), ("protocol", "pay_before"), ("protocol", "seller_signature"),
    ("protocol", "seller_sign_type"), ("protocol", "seller_unique_id"),
    ("method", "seller_name"), ("method", "seller_id"), ("method", "seller_app_id"),
    ("method", "goods_name"), ("method", "seller_unique_id_key"), ("method", "service_id"),
)


def _b64url_decode(s):
    pad = (4 - len(s) % 4) % 4
    return base64.urlsafe_b64decode(s + "=" * pad)


def _snake_to_camel(key):
    if "_" not in key:
        return key
    first, *rest = key.split("_")
    return first + "".join(p[:1].upper() + p[1:] for p in rest if p)


def _camel_keys(value):
    if isinstance(value, list):
        return [_camel_keys(v) for v in value]
    if isinstance(value, dict):
        return {_snake_to_camel(str(k)): _camel_keys(v) for k, v in value.items()}
    return value


def _http(method, url, headers=None, body=None, timeout=60):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, dict(r.headers.items()), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers.items()), e.read()


def _now_ms():
    return str(int(time.time() * 1000))


def _state_path(out_trade_no):
    return os.path.join(STATE_DIR_NAME, f"{out_trade_no}.json")


def _save_state(state):
    os.makedirs(STATE_DIR_NAME, exist_ok=True)
    state["cwd"] = os.getcwd()
    with open(_state_path(state["out_trade_no"]), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def _load_state(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fetch_bill(resource_url):
    """GET 资源端点 → 期望 402 + Payment-Needed；返回 (bill_dict, debug_body_dict)。"""
    status, headers, raw = _http("GET", resource_url, headers={"User-Agent": UA})
    try:
        body = json.loads(raw)
    except Exception:
        body = {}
    if status == 200:  # 已带有效凭证才会 200；裸请求 200 视为服务端异常
        raise SystemExit(f"unexpected 200（未带凭证不应直接交付）: {body}")
    if status == 503:
        raise SystemExit(f"resolve_unavailable（解析预检未通过，未出账单未扣费，稍后再试）: {body}")
    if status == 400:
        raise SystemExit(f"bad_link: {body}")
    if status == 429:
        raise SystemExit("rate_limited（1 分钟后再试）")
    if status != 402:
        raise SystemExit(f"HTTP {status}: {body}")
    needed = None
    for k, v in headers.items():
        if k.lower() == "payment-needed":
            needed = v
            break
    if not needed:
        raise SystemExit("402 但缺 Payment-Needed Header（服务端协议异常）")
    try:
        bill = json.loads(_b64url_decode(needed.strip()).decode("utf-8"))
    except Exception as e:
        raise SystemExit(f"Payment-Needed 解码失败: {e}")
    missing = [f"{a}.{b}" for a, b in BILL_REQUIRED
               if not str(bill.get(a, {}).get(b) or "").strip()]
    if missing:
        raise SystemExit(f"账单缺字段: {', '.join(missing)}")
    return bill, body


def cashier_order(bill, buyer_id, buyer_signature):
    """收银下单：camelCase 账单 + 买家标识 → (pay_url, trade_no)。"""
    converted = _camel_keys(bill)
    method = dict(converted.get("method") or {})
    protocol = dict(converted.get("protocol") or {})
    method["buyerUniqueIdKey"] = "buyerExternalId"
    protocol["buyerUniqueId"] = buyer_id
    out_trade_no = str(protocol.get("outTradeNo") or "")
    m = re.search(r"(\d{10,})$", out_trade_no)
    payload = {
        "method": method,
        "protocol": protocol,
        "signature": {
            "buyerExternalId": buyer_id,
            "buyerSignature": buyer_signature,
            "timestamp": m.group(1) if m else _now_ms(),
        },
    }
    status, _headers, raw = _http(
        "POST", PAY_ENDPOINT,
        headers={"Content-Type": "application/json", "User-Agent": UA},
        body=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
    )
    try:
        resp = json.loads(raw)
    except Exception:
        resp = {}
    pay_scheme = resp.get("payScheme")
    if not pay_scheme:
        raise SystemExit(f"收银下单失败 HTTP {status}: {json.dumps(resp, ensure_ascii=False)[:400]}")
    trade_no = (resp.get("protocol") or {}).get("tradeNo") or (resp.get("protocol") or {}).get("tradeCoreTradeNo")
    if not trade_no:
        raise SystemExit(f"收银响应缺 tradeNo: {json.dumps(resp, ensure_ascii=False)[:400]}")
    return PAY_URL_PREFIX + urllib.parse.quote(str(pay_scheme), safe=""), str(trade_no)


def cmd_bill(args):
    resource_url = f"{API_BASE}/api/a2m/resolve?url={urllib.parse.quote(args.url, safe='')}"
    bill, _debug = fetch_bill(resource_url)
    p, m = bill["protocol"], bill["method"]
    state = {
        "url": resource_url, "out_trade_no": p["out_trade_no"], "resource_id": p["resource_id"],
        "amount": p["amount"], "currency": p["currency"], "goods_name": m["goods_name"],
        "pay_before": p["pay_before"], "created_at": int(time.time()),
    }
    out = {
        "out_trade_no": p["out_trade_no"], "amount": p["amount"], "currency": p["currency"],
        "goods_name": m["goods_name"], "pay_before": p["pay_before"],
        "state": os.path.abspath(_state_path(p["out_trade_no"])),
    }
    if args.no_cashier:
        # 生产模式：支付由用户侧官方支付 skill（@alipay/agent-payment，402 协议）完成
        out["payment"] = "交给用户侧官方支付 skill（npx -y @alipay/agent-payment@latest install）"
    else:
        buyer = args.buyer or DEFAULT_BUYER
        if not buyer:
            raise SystemExit("缺买家标识：--buyer <买家2088> 或环境变量 A2M_BUYER_ID（或生产模式加 --no-cashier）")
        pay_url, trade_no = cashier_order(bill, buyer, args.buyer_signature or DEFAULT_BUYER_SIGNATURE)
        state.update({"pay_url": pay_url, "trade_no": trade_no,
                      "buyer_id": buyer, "buyer_signature": args.buyer_signature or DEFAULT_BUYER_SIGNATURE})
        out["pay_url"] = pay_url
    _save_state(state)
    print(json.dumps(out, ensure_ascii=False, indent=2))


def build_proof_header(buyer_id, trade_no, payment_proof, buyer_signature):
    """Payment-Proof = Base64(JSON{protocol.payment_proof/trade_no, method.client_session})。"""
    ts = _now_ms()
    proof = payment_proof or hashlib.sha256(f"{trade_no}|{buyer_id}|{ts}".encode()).hexdigest()
    client_session = base64.b64encode(json.dumps(
        {"externalId": buyer_id, "signature": buyer_signature, "timestamp": ts},
        ensure_ascii=False, separators=(",", ":")).encode()).decode()
    body = {"protocol": {"payment_proof": proof, "trade_no": trade_no},
            "method": {"client_session": client_session}}
    return base64.b64encode(json.dumps(body, separators=(",", ":")).encode()).decode()


def cmd_deliver(args):
    state = _load_state(args.state)
    proof_header = build_proof_header(
        str(state["buyer_id"]), str(state["trade_no"]),
        args.payment_proof, str(state.get("buyer_signature") or DEFAULT_BUYER_SIGNATURE))

    def deliver_once():
        status, headers, raw = _http("GET", state["url"], headers={
            "User-Agent": UA, "Payment-Proof": proof_header}, timeout=args.http_timeout)
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        if status == 402:
            raise SystemExit(f"凭证未通过（未支付或已过期，重新 a2m.py bill 出账单）: {body}")
        if status == 502:
            raise SystemExit(f"履约确认暂时失败（用同一 state 稍后重试 deliver，不要重新支付）: {body}")
        if status >= 500:
            raise SystemExit(f"服务端暂时异常 HTTP {status}（用同一 state 稍后重试 deliver，不要重新支付）: {body}")
        if status != 200:
            raise SystemExit(f"HTTP {status}: {body}")
        if body.get("resource_id") != state["resource_id"]:
            raise SystemExit(f"resource_id 不一致: {body.get('resource_id')} != {state['resource_id']}")
        return body

    body = deliver_once()
    # ¥1 打包含音频提取/ASR 文字稿：异步产物用同一 Proof 轮询（幂等重放）到终态
    deadline = time.time() + args.wait_timeout
    poll = "settled"
    while not args.no_wait and _artifacts_pending(body) and time.time() < deadline:
        time.sleep(args.poll_interval)
        body = deliver_once()
    if _artifacts_pending(body):
        poll = "timeout"

    delivery_path = _state_path(state["out_trade_no"]).replace(".json", ".delivery.json")
    os.makedirs(STATE_DIR_NAME, exist_ok=True)
    with open(delivery_path, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    c = body.get("content") or {}
    audio, transcript = c.get("audio") or {}, c.get("transcript") or {}
    print(json.dumps({
        "out_trade_no": body.get("out_trade_no"), "trade_no": body.get("trade_no"),
        "already_fulfilled": body.get("already_fulfilled"), "title": c.get("title"),
        "file_size": c.get("file_size"), "duration_s": c.get("duration_s"),
        "width": c.get("width"), "height": c.get("height"),
        "audio_status": audio.get("status"), "audio_file_size": audio.get("file_size"),
        "transcript_status": transcript.get("status"),
        "transcript_chars": len(transcript.get("text") or ""),
        "poll": poll,
        "delivery": os.path.abspath(delivery_path),  # cdn_url/audio.url 在 delivery 文件里，不打印
    }, ensure_ascii=False, indent=2))


def _artifacts_pending(body):
    """音频/文字稿是否仍有未到终态（pending/processing）的"""
    c = body.get("content") or {}
    return any((c.get(k) or {}).get("status") in ("pending", "processing")
               for k in ("audio", "transcript"))


def _sanitize_stem(title):
    """与视频文件同款净化：去尾部 #话题，去路径非法字符，60 字符上限"""
    stem = re.sub(r"(?:#\S+\s*)+$", "", str(title or "").strip()) or "sph_video"
    stem = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", stem).strip("_ ")
    return stem[:60] or "sph_video"


def cmd_transcript(args):
    """交付 JSON 内联文字稿落盘：<标题>.txt + <标题>.srt（内容在 delivery.json，无需再请求）"""
    with open(args.delivery, encoding="utf-8") as f:
        body = json.load(f)
    c = body.get("content") or {}
    transcript = c.get("transcript") or {}
    if transcript.get("status") != "ready":
        raise SystemExit(f"文字稿未就绪（status={transcript.get('status')}，先 deliver 轮询到 ready）")
    stem = _sanitize_stem(c.get("title"))
    os.makedirs(args.out_dir, exist_ok=True)
    txt_path = os.path.join(args.out_dir, f"{stem}.txt")
    srt_path = os.path.join(args.out_dir, f"{stem}.srt")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(transcript.get("text") or "")
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(transcript.get("srt") or "")
    print(json.dumps({"txt": os.path.abspath(txt_path), "srt": os.path.abspath(srt_path)}, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser(description="sph A2M（支付宝 AI 按量付费）客户端")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bill", help="出账单（沙箱另做收银下单 → 付款链接）")
    b.add_argument("--url", required=True, help="视频号分享短链（weixin.qq.com/sph/...）")
    b.add_argument("--buyer", help="买家 2088 标识（或 A2M_BUYER_ID）")
    b.add_argument("--buyer-signature", help="买家签名（沙箱可缺省）")
    b.add_argument("--no-cashier", action="store_true",
                   help="生产模式：仅出账单，支付交给用户侧官方支付 skill")
    d = sub.add_parser("deliver", help="Proof 重试 → 交付（音频/文字稿自动轮询到终态）")
    d.add_argument("state", help="bill 输出的 state 文件路径")
    d.add_argument("--payment-proof", help="支付凭证（真实支付场景由支付侧给出；沙箱 mock 可缺省）")
    d.add_argument("--poll-interval", type=float, default=5.0, help="产物轮询间隔秒（默认 5）")
    d.add_argument("--wait-timeout", type=float, default=900.0, help="产物等待总超时秒（默认 900；超时返回当前状态）")
    d.add_argument("--http-timeout", type=float, default=60.0, help="单次 HTTP 超时秒（默认 60）")
    d.add_argument("--no-wait", action="store_true", help="不等产物，拿到交付即返回（自行稍后重跑 deliver）")
    t = sub.add_parser("transcript", help="交付 JSON 内联文字稿落盘 <标题>.txt/.srt")
    t.add_argument("delivery", help="deliver 输出的 .delivery.json 路径")
    t.add_argument("--out-dir", default="./sph-downloads", help="输出目录（默认 ./sph-downloads）")
    args = ap.parse_args()
    if args.cmd == "bill":
        cmd_bill(args)
    elif args.cmd == "transcript":
        cmd_transcript(args)
    else:
        cmd_deliver(args)


if __name__ == "__main__":
    main()
