# 后端 API 契约速查

Base：`$SPH_API`（环境变量或 skill 目录 config.json）

## POST /api/preview
```bash
curl -X POST "$SPH_API/api/preview" -H 'content-type: application/json' -d '{"url":"<原始链接>"}'
```
- 200 `{order_id, order_token, amount_cents, code_url, expire_at, preview:{title,author,avatar,cover,description,created_at,likes,content_id}}`
  - 下单前会做**解析预检**（真实跑一次解析，结果丢弃）：预检通过才创建订单+发起微信下单，响应会慢 3~6s，属正常
- 400 `{error:'bad_link'|'bad_request'}`；export/objectId 输入返回 `{error:'unsupported_link'}`（仅短链可下单）
- 503 `{error:'resolve_unavailable'}` 解析预检未通过（通道故障或链接失效），未创建订单，可稍后重试
- 429 频率受限（5 次/分钟/IP）
- ⚠️ 响应永远不含下载 url/密钥

## GET /api/order/:id/status?token=
- 200 `{status, message, poll_after_ms}`，status: pending|paid|resolving|resolved|failed|refunded|expired
- 403 bad_token / 404 order_not_found

## GET /api/order/:id/deliver?token=
- 200（仅 resolved）`{url, key_b64, enc_len, file_size, title}`
  - `key_b64` 为空 / `enc_len` 为 0（常态）：`url` 是**明文 MP4 直链**，直接下载即可
  - `key_b64` 非空（历史加密订单）：`url` 前 `enc_len` 字节 XOR 加密，需 decrypt.py 解密
- 409 not_ready 或终态非 resolved
- 可重复调用；超 20h 自动刷新 CDN url（仅新版短链订单；历史 export/objectId 订单无刷新能力）

## POST /api/wxpay/notify（微信服务器调用，非 skill 使用）

## GET /healthz
`{ok, mock, price_cents}`
