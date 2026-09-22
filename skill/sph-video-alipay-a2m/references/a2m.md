# A2M（AI 按量付费 · 支付宝）契约速查

服务端实现：`server/src/routes/a2m.js` + `server/src/a2m/`（协议纯函数/配置/SDK/artifacts 产物流水线）。
协议依据：支付宝「AI 按量付费」402 协议（alipay-aipay skill `aipay-interface-contract.md`）。

¥1/次**打包交付**：视频 MP4 直链（即时）+ 音频 M4A + ASR 文字稿 TXT/SRT（异步产物，轮询获取）。

## GET /api/a2m/resolve?url=<视频号分享短链>

单一资源端点，两种返回：

- **无 `Payment-Proof` Header → 402**：`Payment-Needed` Header = Base64URL(JSON 账单)。
  响应体仅调试用（`{code:'Payment-Needed', out_trade_no, amount, currency, goods_name, resource_id, pay_before}`），**不含直链**。
  - 账单 `protocol`：`out_trade_no / amount / currency=CNY / resource_id / pay_before(ISO8601带时区) / seller_signature(RSA2) / seller_sign_type / seller_unique_id`
  - 账单 `method`：`seller_name / seller_id / seller_app_id / goods_name / seller_unique_id_key='seller_id' / service_id`
  - 出账单前有**真实解析预检**：预检不过 503 `resolve_unavailable`（不建单不扣费）；export/objectId 输入 400 `unsupported_link`（仅短链）；视频超时长上限（默认 2 小时，`A2M_MAX_DURATION_S`）400 `video_too_long`；429 = 10 次/分钟/IP
- **带 `Payment-Proof` Header → 200 交付**（验付+履约确认通过后）：

```json
{
  "resource_id": "/api/a2m/resolve?url=https://weixin.qq.com/sph/<短码>",
  "out_trade_no": "a2m_...", "trade_no": "2026...",
  "already_fulfilled": false, "fulfillment_confirmed": true,
  "content": {"share_url": "...", "title": "...", "author": "...", "cdn_url": "https://...mp4",
              "file_size": 123, "duration_s": null, "width": null, "height": null,
              "audio": {"status": "processing"},
              "transcript": {"status": "processing"},
              "generated_at": "..."}
}
```

  - 响应 Header `Payment-Validation` = Base64URL(JSON `{trade_no, out_trade_no, validated:true, resource_id}`)，客户端校验 resource_id 一致
  - Proof 无效/未付/过期 → 再次 402（重新出账单）；履约确认暂时失败 → 502 `FULFILLMENT_CONFIRM_FAILED`（**同一 Proof 重试即可，别重新支付**）
- `resource_id` 由规范短链构造：同一视频任意原文格式 → 同一 resource_id

### 音频/文字稿产物（content.audio / content.transcript）

- 首次交付即返回 `cdn_url`；音频提取（ffmpeg 抽 AAC → M4A）与 ASR（火山豆包单向流式识别）在服务端**异步流水线**生成，status：`pending → processing → ready`（终态：`ready / failed / skipped / expired`）。
- **轮询 = 用同一 Payment-Proof 重调 deliver**（幂等重放，`already_fulfilled: true`），每次响应带最新 status；a2m.py deliver 内置 5s 轮询、900s 超时。
- ready 后：`audio` = `{status, url, file_size}`；`transcript` = `{status, text, srt, url, srt_url, json_url, duration_ms}`（text/srt 内联，几 KB；utterances 词级时间轴在 json_url）。
- 产物下载 `GET /api/a2m/artifact/<out_trade_no>/<kind>?token=...`（kind ∈ audio.m4a / transcript.txt / transcript.srt / transcript.json；token 随交付响应下发，60 次/分钟/IP）。产物服务端保留约 48 小时（`A2M_ARTIFACT_TTL_HOURS`），过期 `expired` 且不自动重跑。
- 降级语义：`transcript: skipped/failed`（未配 ARK_API_KEY / 视频无语音 / ASR 出错）不影响视频与音频交付，原因在 `error` 字段；音频失败同理。

## 客户端三步（a2m.py 内置）

1. **取账单**：GET → 402 → 解码 `Payment-Needed`
2. **支付**（两种模式）：
   - **生产（默认）**：交给用户侧**支付宝官方支付 skill**（`npx -y @alipay/agent-payment@latest install`，github.com/alipay/payment-skills，支持 HTTP 402 协议）——自动完成 402→用户支付宝授权→获取 Payment-Proof→重试。**商户侧不存在生产收银下单接口**。
   - **沙箱联调**：账单 snake→camel；补 `method.buyerUniqueIdKey="buyerExternalId"`、`protocol.buyerUniqueId=<买家2088>`、`signature={buyerExternalId, buyerSignature, timestamp}`；POST 收银接口 → `payScheme`（拼付款链接）+ `protocol.tradeNo`
     - 沙箱收银模拟器：`http://aicashier.dl.alipaydev.com/openclawpay/agent/v1/pay`（**仅沙箱联调**）
     - 付款链接前缀：`https://render.alipay.com/p/yuyan/180020010001290755/pay.html?schema=<urlencode(payScheme)>`
3. **Proof 重试**：用户支付后，`Payment-Proof` = Base64(JSON `{protocol:{payment_proof, trade_no}, method:{client_session}})`；`client_session` = Base64(JSON `{externalId, signature, timestamp(ms)}`)；生产 `payment_proof` 值由官方支付 skill 提供（`deliver --payment-proof` 传入）

## 沙箱与生产差异（服务端 `server/src/a2m/config.js`）

| | 沙箱 | 生产 |
|---|---|---|
| 配置来源 | `server/.alipay-sandbox.json`（alipay-aipay skill 快速沙箱创建） | env `ALIPAY_APP_ID/APP_PRIVATE_KEY(_PATH)/PUBLIC_KEY(_PATH)/SELLER_ID/SERVICE_ID/GATEWAY` 全齐 |
| service_id | 固定 `api_mock_service_id`（收银按 ¥0.01 试算，自动完成支付） | 服务市场真实 serviceId（当前生产：`API_9F6C5FDE1FCB4A61`） |
| 网关 | `openapi-sandbox.dl.alipaydev.com` | `openapi.alipay.com`（必须显式给，禁静默落沙箱） |
| payment_proof | mock 服务自动支付，脚本本地 sha256 兜底即可通过验付 | 真实支付后由支付侧签发，`--payment-proof` 传入；缺字段响应**不**兜底 |

沙箱买家 2088 从 `server/.alipay-sandbox.json` 的 `sandboxAccounts.buyer.userId` 读取（勿硬编码）。

## 订单状态机（a2m_orders 表）

`PENDING_PAYMENT →（验付成功 bindTrade）PAID →（交付物落位）PENDING_CONFIRM →（履约确认）FULFILLED`；未付过期懒转 `EXPIRED`。`trade_no` 全表 UNIQUE：同一平台交易号只允许履约一次；已 FULFILLED 的订单同 Proof 重试直接回放结果（幂等）。产物状态在 `a2m_artifacts` 表（audio_status/asr_status 独立推进），随重放响应实时合并。
