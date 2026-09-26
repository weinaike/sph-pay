# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

视频号付费下载系统：Claude Code skill（`skill/`，软链安装于项目 `.claude/skills/sph-downloader`；API 地址 `https://sph.yes-tek.com` 已写死在 SKILL.md）+ 云后端（`server/`）。另有 WorkBuddy 专家包 `expert/sph-video-download-expert/`（「小视」：内置下载技能编排执行；`skills/sph-video-wechat-channels-downloader` 是指向 `skill/` 源码的相对软链，**打包 zip 时才解引用成实体文件**——技能改动后需重新 zip 提交开放平台，规范 open.workbuddy.cn/docs/expert）。用户贴视频号分享链接 → 后端展示预览 → 微信扫码支付 → 支付后才下发腾讯 CDN 直链 → 客户端下载保存为 mp4。

解析走**自有服务** `https://sph.yes-tek.com`（wx_channels_download sph-api 的公开 API，`SPH_BASE` 可覆盖），无浏览器依赖。其直链为**明文 MP4**（无 XOR 密钥、无 x-enclen）；仅历史订单（miuistore 时代）存量密钥仍按 XOR 交付。

## 常用命令

后端命令均在 `server/` 目录执行（单测对 cwd 敏感，从其他目录跑会误报失败）：

```bash
cd server
npm ci --registry=https://registry.npmmirror.com

npm start                                 # 本地开发（需真实微信商户配置，缺项启动即 fail-fast）
npm test                                  # 全部单测
node --test test/unit/normalize.test.js   # 单个测试文件

node test/manual-resolve.js 'https://weixin.qq.com/sph/AzGEWrdqgP'
# ↑ 风险前置验证：自有解析服务全链路（提交 job → 轮询 → HEAD 校准）。改过 resolverClient/resolveService 后必跑
```

Docker（项目根目录）：

```bash
cp deploy/sph.env.example deploy/sph.env   # 首次部署拷贝后填入真实凭证
docker compose up -d --build               # 默认国内源；海外构建 --build-arg USE_CN_MIRROR=0
docker compose logs -f                     # healthcheck 通过即就绪
```

联调走真实支付闭环（无 mock）：preview → 微信扫码（¥0.01）→ 轮询 `/api/order/:id/status` 到 resolved → `/api/order/:id/deliver`。回调打不进来时 sweeper 每 60s 查单对账推进 paid，无需手动干预。

## 架构

```
skill(客户端编排，纯 curl + 2 个 stdlib 脚本) ── 下单/轮询/deliver ──► server(Express :8787)
                                              ├─ previewService → 微信免登录 get_feed_info（预览元数据）
                                              ├─ wxpay(APIv3 Native) → 下单/回调验签(AES-GCM)/退款
                                              ├─ resolveService → sph/resolverClient → sph.yes-tek.com
                                              │   POST /api/scraper/fetch → 轮询 /api/scraper/job → 明文直链落库
                                              │   + sph/mp4meta（Range 拉 moov 解析时长/分辨率，替代客户端 ffprobe）
                                              ├─ routes/page.js → /p/:id 托管订单页（2026-09-22 上云：
                                              │   QR/信息/倒计时/套餐价目全服务端渲染，同源轮询 status 自推进，
                                              │   cover/avatar 防盗链代理；skill 只把 page_url 给用户）
                                              ├─ batchService → /api/resolve/batch 批量解析（落盘续跑，
                                              │   逐条扣减/失败返还/额度耗尽整批 skip；替代客户端节拍脚本）
                                              │   + 互动计数（点赞/收藏/转发/评论数，2026-09-23 起上游
                                              │   sph-api 从 get_feed_info 的 *CountFmt 解析透传进 job 载荷
                                              │   content.{like,collect,share,comment}_count；旧上游恒 0）
                                              └─ sweeper(60s)：pending 查单对账（回调丢失兜底）/过期关单/卡单重试/退款重试
客户端下载：直连腾讯 CDN（明文 MP4；历史加密订单走 /api/order/:id/file 流式解密代理，不再有 decrypt.py）
```

订单状态机：`pending → paid → resolving → resolved`；分支：`pending→expired`（15min 未付+关单）、`解析 3 次重试全败→failed→自动全额退款→refunded`。幂等靠 `UPDATE ... WHERE status='pending'`。

**双渠道计费**（plan 见 `docs/plan-dual-channel-pricing.md`）：orders 表 `kind` 列区分 `video`（¥1 单视频）与 `package`（资源包 A/B/C，支付落账 `markPaidAndApply` 同事务入账 users 余额直落 `credited`，售出不退）；匿名账户 `users`（`X-User-Token`）挂直链额度/百条检索机会两种余额（永久有效，原子扣减防并发超扣），消费/去重台账在 `usage_log`。小程序渠道不经 sph-pay（直连 sph-api fetch/job，nginx 限频 5r/m）。

**第三渠道：AI 按量付费（A2M，支付宝 402 协议）**——智能体（AI agent）直连 `GET /api/a2m/resolve?url=<短链>` 按次付费，不走微信订单/托管页。`src/a2m/`（protocol 纯函数/config 加载/SDK 验付与履约）+ `routes/a2m.js` + `a2m_orders` 表（`PENDING_PAYMENT→PAID→PENDING_CONFIRM→FULFILLED`，`trade_no` 全表 UNIQUE 防重复履约，未付懒过期）。安全边界同微信渠道：出账单（402 调试体）绝不含 cdn_url，交付物只进 sqlite 与验付后响应；出账单前真实解析预检。配置优先级：生产 env `ALIPAY_*` 全齐 → 项目根 `.alipay-sandbox.json`（alipay-aipay skill 快速沙箱，service_id 固定 `api_mock_service_id`，¥0.01 试算）→ 未配置 503（不影响微信主链路）。客户端 skill 在 `skill/sph-video-alipay-a2m/`（402→收银下单→付款链接→Proof 重试+产物轮询→下载 mp4/m4a/txt/srt）。**¥1 打包交付（2026-09-23）**：一次付费交付 视频直链（即时）+ 音频 M4A + ASR 文字稿 TXT/SRT；音频/文字稿是异步流水线 `a2m/artifacts.js`（ffmpeg 拉 CDN 抽 AAC→m4a → 16k wav 流 → `a2m/volcAsr.js` 火山豆包单向流式识别，二进制帧协议对齐官方 demo `protocol.py`，`ws` 依赖），产物落 `data/a2m-artifacts/<out_trade_no>/`、状态进 `a2m_artifacts` 表，客户端用**同一 Proof 重调 deliver** 轮询（幂等重放即轮询，零新鉴权面），下载走 `GET /api/a2m/artifact/:outTradeNo/:kind?token=`（token 只随验付后交付响应下发；TTL 默认 48h 清扫置 expired 不重跑，防重复 ASR 计费）；降级：`ARK_API_KEY` 缺失→文字稿 skipped、ffmpeg 缺失→failed，均不影响视频交付；超 `A2M_MAX_DURATION_S`（默认 2h）400 `video_too_long` 拒出账单。已踩坑：沙箱网关 `dl.alipaydev.com` 对 `alipay.aipay.agent.*` 方法间歇 404，`a2m/alipay.js` 的 `execWithRetry` 已做只读重试。

**核心安全不变量**：`cdn_url`/`xor_key_b64` 只存在于 sqlite（`server/data/orders.db`，含密钥属敏感文件）和 deliver 响应中。preview/status 的响应必须过 zod 白名单序列化（`routes/orderCreate.js`），新增字段需显式改 schema。支付前零下发；托管页 `/p/:id` 同理（绝不出现直链/密钥）。

### src/sph/ —— 解析隔离层

解析身份是订单的 `share_url` 列（`https://weixin.qq.com/sph/<短码>`，preview 时落库；db.js 启动迁移会从旧 `content_id LIKE '%##1'` 回填）。`content_id` 的 `##1/##2` 后缀仅为台账兼容。排查解析问题只动这里：

- `normalize.js`：输入归一化 → `contentId` + `shortUri`（短码是解析与预览的唯一有效身份）
- `resolverClient.js`：自有解析 API 客户端。错误分类决定重试策略：`ResolverTransientError`（网络/超时/job interrupted）→ 上层重试；`ResolverFatalError`（job failed / 响应结构变化）→ 立即终止进退款（显式失败，绝不入库脏数据）。completed 载荷校验拆成纯函数 `validateCompleted` 供单测

### src/finder/ —— 达人检索隔离层（M2，计划见 docs/plan-dual-channel-pricing.md）

- `client.js`：wx-webtop（:2027，`FINDER_BASE`）三接口封装（search / feed_list / share_url）。**两个上游实测坑**：① object id 是 20 位数字超 JS 精度——必须走 json-bigint 无损解析；② feed_list 续页 `feedsCount=0`（不是缺失）——总数只信 `>0` 的页。FinderError 统一 503 `finder_unavailable`（search 超时=微信掉线，探活见 runbook）
- `videos.js`：计费语义层。免费 10 条/百条扣机会、`finder_cache` 表作缓存代（fetched_at，TTL 24h 隔天刷新、落盘保代际跨重启）、`usage_log.chargedSince` 去重（同用户×同达人×当前代只扣一次）、总数 ≤10 自动免扣、可用交付 <10 返还

## 关键坑（均已踩过）

- **解析服务只接受 `weixin.qq.com/sph/` 短链**：export/objectId 输入在 preview 即被拒（400 unsupported_link，不创建订单）；支付前还有真实解析预检（预检不过 503，不下单）——两道闸门从根上避免"支付后解析失败→退款"。resolveService 里保留 share_url NULL fail-fast 兜底（防存量订单/sweeper 无限重试）
- **直链是明文 MP4**：无 XOR/x-enclen；deliver 用密钥存在性（`!!xor_key_b64`）区分新旧订单，历史密钥原样交付
- **base64 密钥 174KB 超 ARG_MAX**（历史订单解密）：decrypt.py 密钥走文件不走 argv；长度校验用 `Buffer.from(s,'base64').length`（padding 算法差 1）
- **微信 get_feed_info 必须带 Origin/Referer 头**，裸请求被拒（previewService 已带）；仅短码可用，export/数字 id 传入会"无法播放"→ 降级占位预览
- **微信回调验签必须 raw body**：`express.raw` 挂在 wxpay 路由、全局 JSON 中间件之前；`time_expire` 与本地 `expire_at` 必须同源生成（资损窗口）
- **回调打不进来时（本地调试/公网未部署）**：sweeper 对超 60s 的 pending 订单每轮主动查单对账推进 paid
- 本机 pip 清华源异常，装 Python 包用阿里源 `-i https://mirrors.aliyun.com/pypi/simple/`
- wechatpay-node-v3 最高版本 2.2.2 不存在，用 ^2.2.1
