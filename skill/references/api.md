# 后端 API 契约速查

Base：`$SPH_API`（环境变量或 skill 目录 config.json）

## POST /api/preview
```bash
curl -X POST "$SPH_API/api/preview" -H 'content-type: application/json' -d '{"url":"<原始链接>"}'
```
- 200 `{order_id, order_token, amount_cents, code_url, expire_at, preview:{title,author,avatar,cover,description,created_at,likes,content_id}}`
- 400 `{error:'bad_link'|'bad_request'}`
- 429 频率受限（5 次/分钟/IP）
- ⚠️ 响应永远不含下载 url/密钥

## GET /api/order/:id/status?token=
- 200 `{status, message, poll_after_ms}`，status: pending|paid|resolving|resolved|failed|refunded|expired
- 403 bad_token / 404 order_not_found

## GET /api/order/:id/deliver?token=
- 200（仅 resolved）`{url, key_b64, enc_len, file_size, title}`
- 409 not_ready 或终态非 resolved
- 可重复调用；超 20h 自动刷新 CDN url

## POST /api/wxpay/notify（微信服务器调用，非 skill 使用）

## GET /healthz
`{ok, mock, price_cents}`
