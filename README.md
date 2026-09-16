# sph-pay —— 视频号付费下载系统

Claude Code skill + 云后端：用户贴一个视频号分享链接，先看到视频预览信息，微信扫码支付后，系统才解析出下载直链并解密保存为本地 mp4。

```
用户 ── skill(sph-download) ──► 后端(:8787) ──► 微信免登录接口（预览元数据）
                                  │
用户扫码支付 ◄── 微信支付 APIv3 Native ──┘
                                  │ 回调验签(AES-256-GCM) → paid
                                  ▼
                        解析（playwright 常驻页执行上游 AlgoSign 签名
                              → quick 接口 → CDN 直链 + XOR 密钥，只落库）
                                  │
用户 ◄── deliver(校验已支付) ─────┘
  └─ curl 下载 → 前 131072 字节 XOR 解密 → 完整 MP4
```

**核心安全不变量**：下载直链与解密密钥在支付完成前绝不下发（preview/status 响应走 zod 白名单序列化）。

## 功能

- 支持三种输入：`weixin.qq.com/sph/<短码>`、`channels.weixin.qq.com/finder-preview/...` 分享链接、`export/UzFf...` id
- 支付前免登录预览：标题 / 作者 / 封面 / 点赞数（来自微信公开接口，自动把 content_id 升级为 `dynamicExportId`）
- 微信支付 APIv3 Native 扫码：回调验签、幂等、查单对账、15 分钟未付自动关单
- 解析失败自动重试 3 次 → 全额自动原路退款（out_refund_no 固定幂等）
- 订单状态机 `pending→paid→resolving→resolved` / `expired` / `refunded`，sweeper 每分钟对账兜底
- CDN 直链超 20h 自动重新解析刷新；下载支持 Range 断点续传
- 上游站点隔离层（`src/sph/`）：改版影响收敛在单目录，schema 探测显式报错不产生脏数据

## 快速开始

### Docker（生产）

```bash
cp deploy/sph.env.example deploy/sph.env   # 填微信商户参数（MOCK_PAY=0）
mkdir certs && cp apiclient_key.pem pub_key.pem certs/   # 商户私钥 + 微信支付公钥
docker compose up -d --build               # 默认国内源加速
docker compose logs -f                     # [browserPool] ready 即就绪
```

微信回调 `WX_NOTIFY_URL` 必须是公网 HTTPS：宿主机 nginx（见 `deploy/nginx.conf.example`）或 `docker compose --profile tls up -d`。

### 本地开发（模拟支付，无需商户配置）

```bash
cd server
npm ci --registry=https://registry.npmmirror.com
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium
MOCK_PAY=1 npm start
# 联调闭环：
# curl -X POST localhost:8787/api/preview -H 'content-type: application/json' -d '{"url":"<视频号链接>"}'
# curl -X POST localhost:8787/api/dev/mock-pay/<order_id>     # 模拟支付成功
# 轮询 /api/order/<id>/status 到 resolved → /api/order/<id>/deliver
```

## 安装 Claude Code skill

```bash
cp -r skill/ ~/.claude/skills/sph-download/
echo '{"api":"https://<你的后端地址>"}' > ~/.claude/skills/sph-download/config.json
pip install --user qrcode pillow -i https://mirrors.aliyun.com/pypi/simple/
```

之后在任意会话里贴一个视频号链接并说"下载这个视频"，skill 会依次：展示预览与价格 → 终端渲染微信支付码 → 轮询支付 → 下载解密 → ffprobe 汇报。订单信息落盘 `./sph-downloads/.orders/`，中断可恢复续传。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/preview` | 提交链接 → 预览信息 + 订单 + 支付 code_url（IP 限流 5 次/分钟） |
| GET | `/api/order/:id/status?token=` | 轮询订单状态 |
| GET | `/api/order/:id/deliver?token=` | **已支付才返回** `{url, key_b64, enc_len, file_size, title}` |
| POST | `/api/wxpay/notify` | 微信支付回调（raw body 验签） |
| GET | `/healthz` | 健康检查 |

完整契约见 `skill/references/api.md`。

## 配置（deploy/sph.env）

| 变量 | 说明 |
|---|---|
| `WX_APPID` / `WX_MCHID` / `WX_SERIAL` | 公众号 appid / 商户号 / 商户证书序列号 |
| `WX_PRIVATE_KEY_PATH` | 商户 API 私钥（容器内 `/app/certs/apiclient_key.pem`） |
| `WX_PUB_KEY_PATH` / `WX_PUB_KEY_ID` | 微信支付公钥 + 公钥ID（公钥模式商户必填，回调验签用） |
| `WX_APIV3KEY` | APIv3 密钥（32 字符，回调解密用） |
| `WX_NOTIFY_URL` | 支付回调地址（公网 HTTPS） |
| `PRICE_CENTS` / `ORDER_TTL_SECONDS` | 单价（分）/ 未付过期秒数 |
| `SPH_BASE` / `SIGN_TTL_MS` | 上游解析站地址 / sign 缓存有效期 |
| `MOCK_PAY` | 1=模拟支付（挂载 `/api/dev/*`），生产必须 0 |
| `HEADED` | 1=xvfb 有头模式（headless 被反自动化检测时的兜底） |

## 测试与验证

```bash
cd server && npm test                          # 单元测试
node test/manual-sign.js '<视频号链接>'          # 风险前置：headless 签名 + quick 全链路
```

已验证路径：MOCK 全状态机（含失败→自动退款）、真实链接解析、CDN 下载 XOR 解密（`ftyp` 校验 + ffprobe）、Docker 容器重启订单持久化。

## 风险与合规

- **上游单点**：解析依赖 sph.miuistore.com，无控制权；其改版/封禁即服务失效，排查看 `docs/runbook.md`
- **资质合规**：微信商户号挂"视频下载"类虚拟服务存在类目风险；页面/交互保留"仅供个人学习备份"与侵权投诉通道
- 订单库（`server/data/orders.db`）含下载密钥，注意权限（已 chmod 600）与备份边界

## 目录

```
server/   云后端（Express + sqlite + playwright + 微信支付 APIv3）
  src/sph/          上游站点隔离层（唯一接触 sph.miuistore.com 的代码）
skill/    Claude Code skill（SKILL.md + qr/poll/decrypt 脚本）
deploy/   systemd / nginx / env 模板
docs/     runbook（部署、改版排查、故障处置）
```
