# 后端 API 契约速查

## POST /api/order（创建订单 · 单视频按次 ¥1）
```bash
curl -X POST "https://sph.yes-tek.com/api/order" -H 'content-type: application/json' -d '{"url":"<原始链接>"}'
```
- 200 `{order_id, order_token, amount_cents, code_url, expire_at, preview:{title,author,avatar,cover,description,created_at,likes,content_id}}`
  - 下单前做**解析预检**：预检通过才创建订单+发起微信下单，响应慢 3~6s 属正常
- 400 `{error:'bad_link'|'bad_request'}`；export/objectId 输入返回 `{error:'unsupported_link'}`（仅短链可下单）
- 503 `{error:'resolve_unavailable'}` 解析预检未通过（通道故障或链接失效），未创建订单，可稍后重试
- 429 频率受限（5 次/分钟/IP）
- ⚠️ 响应永远不含下载 url/密钥

## GET /api/order/:id/status?token=
- 200 `{status, message, poll_after_ms}`，status: pending|paid|resolving|resolved|**credited**|failed|refunded|expired
  - `credited` = 资源包订单支付到账（终态；poll.py 加 `--terminal credited`）
- 403 bad_token / 404 order_not_found

## GET /api/order/:id/deliver?token=
- 200（仅 resolved）`{url, key_b64, enc_len, file_size, title}`
  - `key_b64` 为空 / `enc_len` 为 0（常态）：`url` 是**明文 MP4 直链**，直接下载即可
  - `key_b64` 非空（历史加密订单）：`url` 前 `enc_len` 字节 XOR 加密，需 decrypt.py 解密
- 409 not_ready 或终态非 resolved；套餐订单恒 409 `package_order`
- 可重复调用；超 20h 自动刷新 CDN url（仅新版短链订单；历史 export/objectId 订单无刷新能力）

## POST /api/user（匿名开户）· GET /api/user/me（余额）
```bash
curl -X POST "https://sph.yes-tek.com/api/user"                          # → 201 {user_token, link_quota:0, search_credits:0,...}
curl "https://sph.yes-tek.com/api/user/me" -H "x-user-token: <token>"    # → {link_quota, search_credits, total_paid_cents, purchases:[...]}
```
- token 是余额凭证（丢失即丢余额）；后续额度类调用统一带 `X-User-Token` 头。10 次/min/IP
- 401 `no_user_token` / `bad_user_token`

## POST /api/package（购买资源包）
```bash
curl -X POST "https://sph.yes-tek.com/api/package" -H 'content-type: application/json' \
  -H "x-user-token: <token>" -d '{"package":"A"}'
```
- 200 `{order_id, order_token, package, amount_cents, code_url, expire_at, granted:{link_quota,search_credits}, notice}`
  - A ¥5=10 条；B ¥30=100 条+10 次百条；C ¥50=200 条+20 次百条。**售出不退、即时到账、永久有效**（notice 字段原样转达用户）
- 到账后状态 `credited`，余额实时累加；未付 15min 过期同普通订单。5 次/min/IP

## POST /api/finder/search（达人检索，免费）
```bash
curl -X POST "https://sph.yes-tek.com/api/finder/search" -H 'content-type: application/json' -d '{"keyword":"人民日报"}'
```
- 200 `{items:[{username,nickname,avatar,signature}]}`（Top10；username=v2_xxx@finder 是后续操作身份）
- 503 `{error:'finder_unavailable'}` 检索通道不可用；429 限频 10 次/min/IP

## POST /api/finder/videos（达人作品列表）
```bash
curl -X POST "https://sph.yes-tek.com/api/finder/videos" -H 'content-type: application/json' \
  -d '{"username":"v2_xxx@finder"}'                      # 免费：前 10 条（含 share_url）
curl ... -H "x-user-token: <token>" \
  -d '{"username":"v2_xxx@finder","full":true}'          # 百条：扣 1 次百条机会（同达人 24h 免重扣；总数≤10 免费放行）
```
- 200 `{username, total(达人作品总数), count, charged, refunded?, truncated, cache_hit, items:[{object_id,title,share_url,created_at,duration,width,height,size}]}`
  - `share_url` 可能个别为 null（生成失败，计费阈值口径已含）
- 402 `no_search_credits`（full 且机会不足）；503 `finder_unavailable`；免费 6 次/min/IP、full 3 次/min/token

## POST /api/resolve（额度直链 · 单条）
```bash
curl -X POST "https://sph.yes-tek.com/api/resolve" -H 'content-type: application/json' \
  -H "x-user-token: <token>" -d '{"url":"https://weixin.qq.com/sph/xxxx"}'
```
- 200 `{url, file_size, title, charged}` —— 扣 1 条直链额度；同短链 24h 内 `charged:false` 免重扣
- 402 `no_link_quota`（message 含三选项引导：套餐 / 单条 ¥1 / 小程序免费）
- 503 `resolve_failed` **额度已自动返还**；400 `unsupported_link`（仅短链）
- 限频 15 次/min/IP + 10 次/min/token（批量串行每条间隔 ≥6.5s；batch_resolve.py 已内置节奏与 429 自动退避）

## POST /api/wxpay/notify（微信服务器调用，非 skill 使用）

## GET /healthz
`{ok, price_cents}`
