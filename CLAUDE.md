# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

视频号付费下载系统：Claude Code skill（`skill/`，安装于 `~/.claude/skills/sph-download/`）+ 云后端（`server/`）。用户贴视频号分享链接 → 后端展示预览 → 微信扫码支付 → 支付后才下发腾讯 CDN 直链与 XOR 解密密钥 → 客户端下载并解密为 mp4。

对上游解析站 sph.miuistore.com **无控制权**——它是单点依赖，改版风险集中在 `server/src/sph/` 隔离层。

## 常用命令

后端命令均在 `server/` 目录执行（单测对 cwd 敏感，从其他目录跑会误报失败）：

```bash
cd server
npm ci --registry=https://registry.npmmirror.com
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium

MOCK_PAY=1 npm start                      # 本地开发（模拟支付，无需微信商户配置）
npm test                                  # 全部单测
node --test test/unit/normalize.test.js   # 单个测试文件

node test/manual-sign.js 'https://weixin.qq.com/sph/AzGEWrdqgP'
# ↑ 风险前置验证：headless 签名 + quick 全链路。改过 signer/quickClient/browserPool 后必跑
```

Docker（项目根目录）：

```bash
cp deploy/sph.env.example deploy/sph.env   # 本地联调把 MOCK_PAY 设 1
docker compose up -d --build               # 默认国内源；海外构建 --build-arg USE_CN_MIRROR=0
docker compose logs -f                     # [browserPool] ready = 就绪
```

本地联调闭环：preview → `POST /api/dev/mock-pay/<order_id>`（仅 MOCK_PAY=1 挂载）→ 轮询 `/api/order/:id/status` 到 resolved → `/api/order/:id/deliver`。

## 架构

```
skill(客户端编排) ── preview/轮询/deliver ──► server(Express :8787)
                                              ├─ previewService → 微信免登录 get_feed_info（预览元数据+dynamicExportId）
                                              ├─ wxpay(APIv3 Native) → 下单/回调验签(AES-GCM)/退款
                                              ├─ resolveService → sph/ 隔离层 → quick 接口 → url+key 落库
                                              └─ sweeper(60s)：过期关单/查单对账/卡单重试/退款重试
客户端下载：直连腾讯 CDN（前 131072 字节加扰）→ XOR 解密 → mp4
```

订单状态机：`pending → paid → resolving → resolved`；分支：`pending→expired`（15min 未付+关单）、`解析 3 次重试全败→failed→自动全额退款→refunded`。幂等靠 `UPDATE ... WHERE status='pending'`。

**核心安全不变量**：`cdn_url`/`xor_key_b64` 只存在于 sqlite（`server/data/orders.db`，含密钥属敏感文件）和 deliver 响应中。preview/status 的响应必须过 zod 白名单序列化（`routes/preview.js`），新增字段需显式改 schema。支付前零下发。

### src/sph/ —— 全项目唯一接触 sph.miuistore.com 的目录

站点改版时只动这里，按此顺序排查（详见 `docs/runbook.md`）：
- `normalize.js`：输入归一化 → `<短码>##1` / `export/...##2`（规则逆向自该站前端）
- `signer.js`：在常驻页面 `page.evaluate` 执行该站自己的 `AlgoSign({appId:'sph'})` SDK 生成 sign（sign 可脱离浏览器在 Node fetch 复用，缓存 10min）。**sign 为空 = headless 被反自动化检测**，兜底 `HEADED=1` + `xvfb-run`
- `quickClient.js`：调 `/sph/public/quick` + 响应 schema 探测。结构不符抛 `SphChangedError`（显式失败，绝不入库脏数据）；HTTP 500 / error 79 抛 `BadSignError`（触发重签）
- `browserPool.js`：headless chromium 常驻 + 60s 心跳自愈 + 串行队列（VMP SDK 并发行为未知）

## 关键坑（均已踩过）

- **base64 密钥 174KB 超 ARG_MAX**：decrypt.py 密钥走文件不走 argv；长度校验用 `Buffer.from(s,'base64').length`（padding 算法差 1）
- **微信 get_feed_info 必须带 Origin/Referer 头**，裸请求被拒（previewService 已带）；仅短码可用，export/数字 id 传入会"无法播放"→ 降级占位预览
- **微信回调验签必须 raw body**：`express.raw` 挂在 wxpay 路由、全局 JSON 中间件之前；`time_expire` 与本地 `expire_at` 必须同源生成（资损窗口）
- **playwright 浏览器版本必须与 npm 包匹配**：用 `npx playwright install`，勿用系统 chromium 或手下载别的版本号（曾 1223/1243 错位启动失败）
- 本机 pip 清华源异常，装 Python 包用阿里源 `-i https://mirrors.aliyun.com/pypi/simple/`
- wechatpay-node-v3 最高版本 2.2.2 不存在，用 ^2.2.1
