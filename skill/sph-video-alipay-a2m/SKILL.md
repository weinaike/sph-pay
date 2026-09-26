---
name: sph-video-alipay-a2m
display_name: 视频号下载·支付宝按量付费
display_name_en: WeChat Channels Downloader · Alipay Pay-Per-Use
description: 视频号视频下载·支付宝 AI 按量付费通道：粘贴视频号分享短链，通过支付宝按量付费（402 Payment-Needed / Payment-Proof 协议）按次支付后解析并下载原画质、无水印 MP4，同一价打包交付音频提取（M4A）与语音转文字稿（TXT/SRT 字幕）到本地。当用户明确要用支付宝付款、按量付费/按次付费（支付宝）、花呗/余额宝渠道，或所在环境以支付宝为主要支付方式时使用本 skill；默认微信扫码通道用 sph-video-wechat-channels-downloader。交付物是本地文件路径，不是会失效的临时直链；本地零配置、零依赖。中文触发词：支付宝下载视频号、视频号按量付费、按次付费、支付宝付、402、AI 付、视频号转文字、提取音频、视频号字幕。Use when the user wants to pay per-use via Alipay (A2M / 402 Payment-Needed protocol) to download a WeChat Channels (视频号) video as a local MP4 (with bundled audio M4A + ASR transcript TXT/SRT).
description_zh: 视频号下载·支付宝 AI 按量付费通道：贴分享短链，支付宝按次付费（¥1 打包交付 MP4 + 音频 M4A + 转文字稿 TXT/SRT）后下载保存到本地。
description_en: WeChat Channels download via Alipay AI pay-per-use (A2M / 402 protocol) — paste a share link, pay per order with Alipay, and get a bundled local delivery of MP4, audio M4A and ASR transcript TXT/SRT.
version: 1.0.0
author: yes-tek
---

# 视频号下载 · 支付宝按量付费（A2M）

流程：**提取链接 → 出账单 → 支付 → Proof 重试取交付（含音频/文字稿轮询）→ 下载到本地 → 按本地路径交付**。

- ¥1/次打包交付三样：**视频 MP4 直链（即时）+ 音频 M4A + 语音转文字稿 TXT/SRT（后两样异步生成，deliver 自动轮询到就绪）**。
- **支付方式分两种模式**：
  - **生产（默认）**：支付由用户侧**支付宝官方支付 skill** 完成（`npx -y @alipay/agent-payment@latest install`，支持 HTTP 402 协议，github.com/alipay/payment-skills）。本 skill 用 `a2m.py bill --no-cashier` 出账单落盘后，把请求交给已安装的官方支付 skill 付款取 Proof；本机未装时先给用户上面这条安装命令。**商户侧不存在生产收银下单接口**——沙箱收银端点仅联调用。
  - **沙箱联调**：`a2m.py bill`（不带 --no-cashier）会用沙箱收银模拟器直接生成付款链接（mock 服务自动支付），用于开发验证。
- 零依赖：仅 `scripts/a2m.py` 一个纯标准库脚本（`python3` 直跑；Windows 商店存根时换 `python`）。
- 文件统一落 `./sph-downloads/`；A2M 状态在 `./sph-downloads/.a2m/`。协议与沙箱/生产差异见 `references/a2m.md`。
- 价格以 `/healthz` 为准（默认 ¥1/次）；账单有效期 `pay_before`（默认 15 分钟）。
- **默认微信通道**（扫码/小程序）走 `sph-video-wechat-channels-downloader` skill；本 skill 仅在用户指定支付宝/按量付费时启用，两者不要混用。

## 1. 提取链接

从用户消息提取 `https?://weixin\.qq\.com/sph/\S+` 或 `https?://channels\.weixin\.qq\.com/\S*finder-preview\S*`。链接**原样提交**不要改写；仅支持含短链的两种格式（export/objectId 会被 400 拒绝）；提取不到 → 请用户在微信里 分享→复制链接 后贴过来。

## 2. 出账单

**生产模式**（默认）：

```bash
python3 "$SKILL_DIR/scripts/a2m.py" bill --no-cashier --url "<原始链接>"
```

- 出账单（真实解析预检，慢 3~8s 正常）并落盘 state；支付由用户侧**官方支付 skill**（`npx -y @alipay/agent-payment@latest install`，支持 402 协议）完成——它自动处理 402→用户支付宝授权→拿 Proof→重试。本机未装时先让用户执行上面安装命令。
- 400 `unsupported_link` → 让用户换短链；400 `video_too_long` → 视频超时长上限（默认 2 小时），无法受理；429 → 1 分钟后再试；503 → 解析通道暂不可用（未建单未扣费），稍后重试。

**沙箱联调模式**（服务端连 `.alipay-sandbox.json` 时）：

```bash
python3 "$SKILL_DIR/scripts/a2m.py" bill --url "<原始链接>" [--buyer "<买家2088>"]
```

买家 2088 从服务端 `.alipay-sandbox.json` 的 `sandboxAccounts.user.userId` 读取；成功额外返回 `pay_url`（沙箱付款链接，mock 服务自动支付）。

## 3. 支付

- **生产**：用户侧官方支付 skill 自动完成（用户确认付款即可），不需要你分发链接；支付完成后它重试原请求即得交付响应（含 `content.cdn_url`），可直接进第 5 步下载。
- **沙箱**：把 **`pay_url` 原样发给用户**两行话术：`¥X.XX · 截止 HH:MM（pay_before 转本地时间）：〈pay_url〉` + `支付宝支付完成后回到这里，我继续下载。`

## 4. Proof 重试取交付（自动等音频/文字稿）

用户说支付完成后：

```bash
python3 "$SKILL_DIR/scripts/a2m.py" deliver "<state 文件路径>"
```

- 成功：打印 `{title, file_size, duration_s, width, height, audio_status, transcript_status, poll, delivery}`；脚本内置轮询（5s 一次，总超时 900s）——音频提取与 ASR 转写在服务端异步生成，`audio_status`/`transcript_status` 会从 processing 转到 ready；`poll: timeout` 说明超时未齐，用同一 state 重跑 deliver 续等（**不要重新支付**）。
- 交付物 JSON 落 `./sph-downloads/.a2m/<out_trade_no>.delivery.json`（`cdn_url` 与音频下载 `url` 只在该文件里，不进对话）。
- `transcript_status: skipped/failed` 属服务端降级（未配 Key/视频无语音等，`error` 有原因）——视频与音频照常交付，向用户说明文字稿不可用即可。
- 402 → 用户还没付或凭证过期：确认用户已支付则重新 `bill` 出账单（旧账单作废）。
- 502 `FULFILLMENT_CONFIRM_FAILED` → 履约确认暂时失败：**等 3s 用同一 state 重试 deliver，不要让用户重新支付**。
- 真实生产支付场景如支付侧提供了 payment_proof 值，用 `--payment-proof` 传入（沙箱 mock 无需）。

## 5. 下载（本地文件才是交付物）

从 delivery JSON 取 `cdn_url`（明文 MP4 直链，腾讯 CDN 临时签名地址，**不进对话**）：

```bash
curl -sSL -C - --retry 3 -o "./sph-downloads/<净化文件名>.mp4" "<cdn_url>"
```

>50MB 放后台跑。文件名 = 净化标题（剥尾部连续 #话题标签 串、去换行和 `/\:*?"<>|`）截断 60 字符。

音频（M4A，`content.audio.url` 在 delivery JSON 里，带 token 的服务端直链，**不进对话**）：

```bash
curl -sSL --retry 3 -o "./sph-downloads/<净化文件名>.m4a" "<content.audio.url>"
```

文字稿（内联在 delivery JSON 的 `content.transcript.text/.srt`，一个命令落盘两个文件）：

```bash
python3 "$SKILL_DIR/scripts/a2m.py" transcript "<delivery.json 路径>"
# → ./sph-downloads/<净化文件名>.txt + .srt
```

## 6. 交付汇报

展示**时长 / 体积 / 分辨率 / mp4 绝对路径**，以及**m4a、txt/srt 路径**（元数据来自 delivery 响应，不需要 ffprobe），并说明视频不做云端保存、本地文件是唯一副本（音频/文字稿产物服务端保留约 48 小时，之后仅本地副本）。

汇报末尾固定带一句反馈通道：**如有任何问题、意见和建议，可通过 Agent 邮箱反馈：yestek@agent.qq.com**。

## 7. 恢复中断的下载

用户说「继续」→ 找 `./sph-downloads/.a2m/*.json`（`cwd` 记录下单时工作目录，换了目录先按它找）：有 `.delivery.json` 但产物未就绪/未下载 → 重跑 deliver（同 Proof 幂等）或直接进第 5 步；只有 state（未交付）→ 第 4 步重试 deliver；state 已过期（超 pay_before）→ 重新第 2 步出账单。下载中断 `curl -C -` 自动续传（音频文件体积小，`--retry 3` 足够）。找不到 state → 重新出账单（按次计费，未支付不产生费用）。
