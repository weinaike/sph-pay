# sph-pay —— 视频号付费下载系统

Claude Code skill + 云后端：用户贴一个视频号分享链接，先看到视频预览信息，微信扫码支付后，系统才解析出下载直链并保存为本地 mp4。

```
用户 ── skill(sph-download) ──► 后端(:8787) ──► 微信免登录接口（预览元数据）
                                  │
用户扫码支付 ◄── 微信支付 APIv3 Native ──┘
                                  │ 回调验签(AES-256-GCM) → paid（回调丢失时 sweeper 查单对账兜底）
                                  ▼
                        解析（自有服务 sph.yes-tek.com
                              /api/scraper/* → CDN 明文直链，只落库）
                                  │
用户 ◄── deliver(校验已支付) ─────┘
  └─ curl 下载（明文直链即完整 MP4；历史加密订单另需 XOR 解密）
```

**核心安全不变量**：下载直链与解密密钥在支付完成前绝不下发（preview/status 响应走 zod 白名单序列化）。

## 功能

- 支持三种输入：`weixin.qq.com/sph/<短码>`、`channels.weixin.qq.com/finder-preview/...` 分享链接、`export/UzFf...` id（**下单仅支持含短码的前两种**，export-only 直接拒绝；支付前另有解析预检，预检不过不创建订单——从根上避免退款）
- 支付前免登录预览：标题 / 作者 / 封面 / 点赞数（来自微信公开接口）
- 微信支付 APIv3 Native 扫码：回调验签、幂等、查单对账、15 分钟未付自动关单
- 解析失败自动重试 3 次 → 全额自动原路退款（out_refund_no 固定幂等）
- 订单状态机 `pending→paid→resolving→resolved` / `expired` / `refunded`，sweeper 每分钟对账兜底（pending 超 60s 主动查单，回调丢失也能推进）
- CDN 直链超 20h 自动重新解析刷新；下载支持 Range 断点续传
- 解析服务隔离层（`src/sph/`）：自有解析 API 的客户端与输入归一化，schema 探测显式报错不产生脏数据

## 快速开始

### Docker（生产）

```bash
cp deploy/sph.env.example deploy/sph.env   # 填微信商户参数（MOCK_PAY=0）
mkdir certs && cp apiclient_key.pem pub_key.pem certs/   # 商户私钥 + 微信支付公钥
docker compose up -d --build               # 默认国内源加速
docker compose logs -f                     # healthcheck 通过即就绪
```

微信回调 `WX_NOTIFY_URL` 必须是公网 HTTPS：宿主机 nginx（见 `deploy/nginx.conf.example`）或 `docker compose --profile tls up -d`。

### 本地开发（模拟支付，无需商户配置）

```bash
cd server
npm ci --registry=https://registry.npmmirror.com
MOCK_PAY=1 npm start
# 联调闭环（单视频）：
# curl -X POST localhost:8787/api/order -H 'content-type: application/json' -d '{"url":"<视频号链接>"}'
# curl -X POST localhost:8787/api/dev/mock-pay/<order_id>     # 模拟支付成功（走与真实回调相同的落账路径）
# 轮询 /api/order/<id>/status 到 resolved → /api/order/<id>/deliver
# 联调闭环（资源包）：
# curl -X POST localhost:8787/api/user                                 # 匿名开户拿 user_token
# curl -X POST localhost:8787/api/package -H 'x-user-token: <token>' -H 'content-type: application/json' -d '{"package":"B"}'
# curl -X POST localhost:8787/api/dev/mock-pay/<order_id>              # 到账 credited
# curl localhost:8787/api/user/me -H 'x-user-token: <token>'           # link_quota=100, search_credits=10
```

## 安装 Claude Code skill

```bash
cp -r skill/ ~/.claude/skills/sph-download/
echo '{"api":"https://<你的后端地址>"}' > ~/.claude/skills/sph-download/config.json
pip install --user qrcode pillow -i https://mirrors.aliyun.com/pypi/simple/
```

之后在任意会话里贴一个视频号链接并说"下载这个视频"，skill 会依次：展示预览与价格 → 终端渲染微信支付码 → 轮询支付 → 下载（明文直链直接成 mp4，历史加密订单另走解密）→ ffprobe 汇报。订单信息落盘 `./sph-downloads/.orders/`，中断可恢复续传。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/order` | 提交链接 → 预览信息 + 订单 + 支付 code_url（IP 限流 5 次/分钟） |
| POST | `/api/user` | 匿名开户 → `user_token`（余额/已购挂它，丢失即丢余额；10 次/min/IP） |
| GET | `/api/user/me` | `X-User-Token` → 余额（直链额度/百条机会）+ 已购套餐 |
| POST | `/api/package` | `X-User-Token` + `{package:'A'\|'B'\|'C'}` → 资源包订单（A ¥5/10 条；B ¥30/100 条+10 次百条；C ¥50/200 条+20 次百条；**售出不退**，支付后即时到账） |
| POST | `/api/finder/search` | `{keyword}` → 达人 Top10（免费匿名，10 次/min/IP） |
| POST | `/api/finder/videos` | `{username}` → 前 10 条短链列表（免费匿名）；`{username, full:true}` + `X-User-Token` → 前 100 条（扣 1 次百条机会，同达人 24h 缓存代内免重扣；总数 ≤10 自动免扣；可用交付 <10 条全额返还） |
| POST | `/api/resolve` | `X-User-Token` + `{url}` → 短链转直链，扣 1 条直链额度（同短链 24h 免重扣；解析失败自动返还；不足 402） |
| GET | `/api/order/:id/status?token=` | 轮询订单状态（套餐单终态 `credited`） |
| GET | `/api/order/:id/deliver?token=` | **已支付才返回** `{url, key_b64, enc_len, file_size, title}`（套餐单 409） |
| POST | `/api/wxpay/notify` | 微信支付回调（raw body 验签） |
| GET | `/healthz` | 健康检查 |

完整契约见 `skill/references/api.md`。

## 配置（deploy/sph.env）

| 变量 | 说明 |
|---|---|
| `WX_APPID` / `WX_MCHID` / `WX_SERIAL` | 公众号 appid / 商户号 / 证书序列号 |
| `WX_PRIVATE_KEY_PATH` | 商户 API 私钥（容器内 `/app/certs/apiclient_key.pem`） |
| `WX_PUB_KEY_PATH` / `WX_PUB_KEY_ID` | 微信支付公钥模式：公钥文件 + 公钥ID（2024 后新商户默认） |
| `WX_APIV3KEY` | APIv3 密钥（32 字符，回调解密用） |
| `WX_NOTIFY_URL` | 支付回调地址（公网 HTTPS） |
| `PRICE_CENTS` / `ORDER_TTL_SECONDS` | 单价（分）/ 未付过期秒数 |
| `SPH_BASE` | 自有解析服务地址（默认 `https://sph.yes-tek.com`） |
| `SPH_REQUEST_TIMEOUT_MS` / `SPH_POLL_INTERVAL_MS` / `SPH_RESOLVE_TIMEOUT_MS` | 解析单请求超时 / 轮询间隔 / 总超时（默认 10s / 1.5s / 90s） |
| `MOCK_PAY` | 1=模拟支付（挂载 `/api/dev/*`），生产必须 0 |

## 测试与验证

```bash
cd server && npm test                          # 单元测试
node test/manual-resolve.js '<视频号链接>'       # 风险前置：自有解析服务全链路
```

已验证路径：MOCK 全状态机（含失败→自动退款）、真实链接解析、CDN 明文直链下载（`ftyp` 校验 + ffprobe）、Docker 容器重启订单持久化。

## 风险与合规

- **解析单点**：自有服务 sph.yes-tek.com（受控；依赖其 `.tencent.com` cookie 新鲜度，CookieCloud 链失效即解析失败——自动退款兜底），排查看 `docs/runbook.md`
- **资质合规**：微信商户号挂"视频下载"类虚拟服务存在类目风险；页面/交互保留"仅供个人学习备份"与侵权投诉通道
- 订单库（`server/data/orders.db`）含下载密钥，注意权限（已 chmod 600）与备份边界

## 目录

```
server/   云后端（Express + sqlite + 微信支付 APIv3）
  src/sph/          解析隔离层（normalize.js 输入归一化 + resolverClient.js 自有解析服务客户端）
skill/    Claude Code skill（SKILL.md + qr/poll/decrypt 脚本；decrypt 仅历史加密订单需要）
deploy/   systemd / nginx / env 模板
docs/     runbook（部署、解析服务故障排查、故障处置）
```
