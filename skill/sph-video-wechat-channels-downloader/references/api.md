# 后端 API 契约速查

## POST /api/order（创建订单 · 单视频按次 ¥1，以 /healthz 的 price_cents 为准）
```bash
curl -X POST "https://sph.yes-tek.com/api/order" -H 'content-type: application/json' -d '{"url":"<原始链接>"}'
```
- 200 `{order_id, order_token, amount_cents, code_url, expire_at, page_url, preview:{title,author,avatar,cover,description,created_at,likes,content_id,file_size,duration_s,width,height}}`
  - 下单前做**解析预检**（真实解析 + HEAD 探大小 + mp4 头元数据），慢 3~8s 属正常
  - **`page_url` = 托管订单页**（唯一需要交给用户的字段）：自含信息/支付码/倒计时/套餐价目，状态自动推进；手机微信内打开可点按直接拉起支付
  - `duration_s`/`width`/`height` 可能为 null（探测失败），展示需兜底
- 400 `{error:'bad_link'|'bad_request'}`；export/objectId 输入返回 `{error:'unsupported_link'}`（仅短链可下单）
- 503 `{error:'resolve_unavailable'}` 预检未通过（未创建订单）；429 频率受限（5 次/分钟/IP）
- ⚠️ 响应永远不含下载 url/密钥

## GET /api/order/:id/status?token=
- 200 `{status, message, poll_after_ms}`，status: pending|paid|resolving|resolved|**credited**|failed|refunded|expired
  - `credited` = 资源包订单支付到账（终态；poll.py 加 `--terminal credited`）
- 403 bad_token / 404 order_not_found。**未返回 CORS 头**：只有托管页（同源）能轮询，本地 HTML 轮不了

## GET /api/order/:id/deliver?token=
- 200（仅 resolved）`{url, key_b64, enc_len, proxy_url, file_size, duration_s, width, height, title}`
  - `key_b64` 为空（常态）：`url` 是**明文 MP4 直链**，直接下载
  - `key_b64` 非空（历史加密订单）：**下载 `proxy_url`**（服务端流式解密代理，支持 Range 断点续传），不要再下 `url`
  - `duration_s`/`width`/`height` 可能 null
- 409 not_ready 或终态非 resolved；套餐订单恒 409 `package_order`
- 可重复调用；超 20h 自动刷新 CDN url（仅新版短链订单）

## GET /api/order/:id/file?token=（历史加密订单的解密代理）
- 流式返回解密后的完整 MP4；`Range`/`206` 支持断点续传；`cache-control: no-store`
- 非加密订单 409 `not_encrypted`；状态非 resolved 409

## GET /p/:id?t=（托管订单页，浏览器打开）
- 服务端渲染单页：视频信息 + 支付码（白底黑码）+ 倒计时 + **小程序码免费通道** + 套餐三档（可**页面直购**）+ 同达人 Top10（懒加载）；同源轮询 `/status` 自推进（pending→paid→resolved/credited 全自动）
- noindex；封面/头像走 `/p/:id/cover|avatar` 代理（腾讯 CDN 有防盗链，直连会白图）
- 套餐订单同一页面：pending 显示权益卡与支付码，支付后显示到账态

## GET /p/:id/finder?t=（同达人 Top10，页面懒加载用）
- 200 `{nickname, username, total, items:[{title, share_url, created_at, duration, size}]}`（标题已净化；免费档，finder_cache 24h）
- 无作者/无精确匹配 `{items:[], reason}`；通道故障 503 `finder_unavailable`（页面静默移除该卡）
- skill 一般不用此端点（批量走 finder.md：finder/search + finder/videos）

## POST /p/:id/package（页面直购套餐；skill 不使用，用户在页面上点「直接购买」）
- body `{package:'A|B|C', token:<订单 token>, user_token:<页面钱包，可选>}` → `{order_id, order_token, package, amount_cents, expire_at, code_url, qr_data, user_token, granted, notice}`
- 权益落在**页面钱包**（浏览器 localStorage）；到账后页面展示钱包码，用户粘回对话 → 见 finder.md 第 7 节的写入流程

## POST /api/user（匿名开户）· GET /api/user/me（余额）
```bash
curl -X POST "https://sph.yes-tek.com/api/user"                          # → 201 {user_token, link_quota:0, search_credits:0,...}
curl "https://sph.yes-tek.com/api/user/me" -H "x-user-token: <token>"    # → {link_quota, search_credits, total_paid_cents, purchases:[...]}
```
- token 是余额凭证（丢失即丢余额）；额度类调用统一带 `X-User-Token`。10 次/min/IP
- 401 `no_user_token` / `bad_user_token`

## GET /api/package（价目查询）· POST /api/package（购买资源包）
```bash
curl -sS "https://sph.yes-tek.com/api/package"    # → {price_cents, notice, packages:{A:{amount_cents,link_quota,search_credits},...}}
curl -X POST "https://sph.yes-tek.com/api/package" -H 'content-type: application/json' \
  -H "x-user-token: <token>" -d '{"package":"A"}'
```
- POST 200 `{order_id, order_token, package, amount_cents, code_url, expire_at, page_url, granted:{link_quota,search_credits}, notice}`
  - **价目以 GET 为准（服务端单一事实源），不要凭记忆报价**
  - `page_url` 给用户扫码支付（同订单页）；到账后状态 `credited`；未付 15min 过期。GET 30/min/IP、POST 5/min/IP

## POST /api/finder/search（达人检索，免费）
```bash
curl -X POST "https://sph.yes-tek.com/api/finder/search" -H 'content-type: application/json' -d '{"keyword":"人民日报"}'
```
- 200 `{items:[{username,nickname,avatar,signature}]}`（Top10；username=v2_xxx@finder 是后续操作身份）
- 503 `{error:'finder_unavailable'}`；429 限频 10 次/min/IP

## POST /api/finder/videos（达人作品列表）
```bash
curl -X POST "https://sph.yes-tek.com/api/finder/videos" -H 'content-type: application/json' -d '{"username":"v2_xxx@finder"}'                       # 免费：前 10 条（含 share_url）
curl ... -H "x-user-token: <token>" -d '{"username":"v2_xxx@finder","full":true}'    # 百条：扣 1 次百条机会（同达人 24h 免重扣；总数≤10 免费）
```
- 200 `{username, total, count, charged, refunded?, truncated, cache_hit, items:[{object_id,title,share_url,created_at,duration,width,height,size}]}`
  - `share_url` 可能个别为 null
- 402 `no_search_credits`；503 `finder_unavailable`；免费 6 次/min/IP、full 3 次/min/token

## POST /api/resolve（额度直链 · 单条）
```bash
curl -X POST "https://sph.yes-tek.com/api/resolve" -H 'content-type: application/json' \
  -H "x-user-token: <token>" -d '{"url":"https://weixin.qq.com/sph/xxxx"}'
```
- 200 `{url, file_size, title, author, duration_s, width, height, charged}` —— 扣 1 条直链额度；同短链 24h 内 `charged:false` 免重扣；`author`=达人昵称（上游缺省 `''`）；`duration_s/width/height` 可能 null
- 402 `no_link_quota`（message 含三选项引导）；503 `resolve_failed`（**额度已自动返还**）；400 `unsupported_link`
- 限频 15 次/min/IP + 10 次/min/token（**批量请走 /api/resolve/batch，不要循环打单条**）

## POST /api/resolve/batch（批量直链 · 服务端批处理）
```bash
curl -X POST "https://sph.yes-tek.com/api/resolve/batch" -H 'content-type: application/json' \
  -H "x-user-token: <token>" -d '{"urls":["https://weixin.qq.com/sph/a","https://weixin.qq.com/sph/b"]}'
# → {batch_id, total, status:'running', poll_after_ms, message}
```
- ≤100 条/批，**自动去重**；任一非短链**整批 400** `unsupported_link`（message 列出坏下标）
- 服务端逐条：24h 免重扣 → 原子扣 1 条 → 解析；**单条失败自动返还并继续**；额度耗尽余条 `skipped`
- 进程重启自动续跑（已扣费条目不重扣）；创建 5 次/min/IP+token

## GET /api/resolve/batch/:id（批量进度/结果）
```bash
curl "https://sph.yes-tek.com/api/resolve/batch/<batch_id>" -H "x-user-token: <token>"
```
- 200 `{batch_id, status:'running'|'done', total, resolved_count, failed_count, skipped_count, pending_count, poll_after_ms, items:[{url,status,title,file_size,duration_s,width,height,cdn_url?,error?}]}`
  - `cdn_url` 只随 `status:'resolved'` 条目出现（属主鉴权；**不进对话**，下载动作用）
  - `status:'refunded'` = 该条解析失败已返还；`'skipped'` = 额度不足未处理
- 404 `batch_not_found`（含非属主）；轮询 60/min/IP + 30/min/token（poll.py --batch 已带节奏）

## POST /api/wxpay/notify（微信服务器调用，非 skill 使用）

## GET /healthz
`{ok, price_cents}`
