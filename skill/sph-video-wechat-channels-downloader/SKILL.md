---
name: sph-video-wechat-channels-downloader
display_name: 视频号下载与解析
display_name_en: WeChat Channels Video Downloader
description: 视频号（微信视频号 / WeChat Channels）视频下载与解析：粘贴一条分享短链，解析出标题、作者、封面、话题标签等视频信息，并下载原画质、无水印的 MP4 保存到本地。也支持达人检索与批量：按昵称搜达人、列出达人作品短链、批量转直链下载。交付物是本地文件路径，不是会失效的临时直链；本地零配置、零依赖，无需抓包工具、Playwright。当用户要下载、保存、留存、提取视频号视频，批量下载达人作品，或直接贴出 weixin.qq.com/sph/xxx、channels.weixin.qq.com/finder-preview/xxx 链接时使用。中文触发词：视频号下载、微信视频号下载、视频号视频保存、保存视频号到本地、短视频解析、视频号去水印、视频号无水印下载、下载视频号原画、视频号 MP4、视频号封面、sph 短链、微信视频保存、达人检索、找达人、博主主页视频、达人全部作品、批量下载视频号、视频号批量下载。Use when a WeChat Channels (视频号) share link must be downloaded or saved as a local MP4, or when the user wants to search a Channels creator (达人) and batch-download their videos. download WeChat Channels video, WeChat Channels video downloader, download short video from WeChat Channels, WeChat video download, save WeChat video, save WeChat video to camera roll, save WeChat video to computer, keep a copy of WeChat video, grab video from WeChat link, get mp4 from WeChat link, extract mp4 from WeChat Channels link, WeChat Channels link parser, download WeChat video no watermark, watermark-free, original quality, full quality, save offline, Channels creator search, batch download creator videos.
description_zh: 视频号视频下载与解析：贴一条分享短链，解析出标题、作者、封面等视频信息，并下载原画质、无水印的 MP4 保存到本地；支持达人检索与批量下载达人作品。
description_en: WeChat Channels video download and parsing: paste a share link to resolve video info (title, author, cover) and save a watermark-free, original-quality MP4 locally; also supports creator search and batch downloading a creator's videos.
version: 1.0.0
author: yes-tek
---

# 视频号下载与解析

流程：**提取链接 → 查钱包（有额度直取）→ 创建订单 → 把支付页链接交给用户 → 轮询 → 下载到本地 → 按本地路径交付**。

- 零依赖：仅 `scripts/poll.py`（订单/批量轮询）与 `scripts/wallet.py`（开户/余额/购套餐）两个纯标准库脚本，`python3` 直跑（Windows 商店存根时换 `python`）；其余动作全是 `curl`。**绝不安装任何包或二进制**。
- 文件统一落 `./sph-downloads/`；钱包 token 在 `~/.config/sph/user_token`（匿名凭证，丢失即丢余额，开户后提醒用户备份）。
- 支付页自含视频信息、支付码、资费、权益说明、免费通道与常见疑问——**对话侧只推进流程与交付，不复述页面内容，不做推荐话术**。
- 文档：API 契约 `references/api.md`；达人检索与批量（钱包/额度模式）`references/finder.md`。

## 1. 提取链接

从用户消息提取 `https?://weixin\.qq\.com/sph/\S+`、`https?://channels\.weixin\.qq\.com/\S*finder-preview\S*` 或 `export/[A-Za-z0-9+/=_-]+`。链接**原样提交**不要改写；多个链接让用户选一个；提取不到 → 请用户在微信里 分享→复制链接 后贴过来。

## 2. 查钱包（有额度免支付直取）

`~/.config/sph/user_token` 存在时先 `python3 "$SKILL_DIR/scripts/wallet.py" me`：`link_quota > 0` → 按 `references/finder.md` 第 6 节直取，跳过本章 3~5 步。

用户粘来一串 64 位十六进制**钱包码**（在支付页直购了套餐）→ 按 `references/finder.md` 第 7 节处理。

## 3. 创建订单（单视频按次付费，价格以 /healthz 为准）

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/order" -H 'content-type: application/json' \
  -d '{"url":"<原始链接>"}' -o ./order_response.json
```

- 慢 3~8s 正常（下单前做真实解析预检，预检不过不创建订单）。**只 POST 一次**（重复 POST 建多个订单）。只想问价格 → `curl -sS https://sph.yes-tek.com/healthz`。
- 成功后立即落盘订单摘要（`cwd` 记绝对路径，供跨会话恢复）：

```bash
mkdir -p ./sph-downloads/.orders && cat > "./sph-downloads/.orders/<order_id>.json" <<EOF
{"order_id":"...","order_token":"...","expire_at":...,"page_url":"...","cwd":"$(pwd)"}
EOF
```

- 失败：400 `unsupported_link` → 仅支持短链；429 → 1 分钟后再试；503 → 解析通道暂不可用（未创建订单、未扣费），稍后重试。

## 4. 把支付页链接交给用户（用户唯一动作：打开链接付款）

把响应里的 **`page_url` 原样发给用户**，对话侧两行即可：

> ¥X.XX · 截止 HH:MM（expire_at 转本地时间）：〈page_url〉
> 付款后回到这里，我继续下载。

页面状态自动推进；页面不是交付物——解析完成后页面只提示回到对话，下载由本对话完成。手机微信内打开该链接可直接点按支付，电脑打开扫码，无需额外说明。

标题净化：`preview.title` 尾部焊着话题标签串（与 `description` 逐字符相同）——展示/命名前剥掉尾部连续 `#标签` 串（剥空则原样保留）；**不要把 `preview.description` 标成"文案/逐字稿"**（不含口播内容）。

## 5. 轮询支付状态

```bash
python3 "$SKILL_DIR/scripts/poll.py" --order <order_id> --token <order_token>
```

退出码：0 = 解析完成（进第 6 步）；2 = 5 分钟未支付（用户随时说「继续」即重查）；3 = 退款/失败/过期（告知用户：解析失败费用已原路退回）。429 由脚本自动退避，不算故障。

## 6. 取货 + 下载（本地文件才是交付物）

```bash
curl -sS "https://sph.yes-tek.com/api/order/<order_id>/deliver?token=<order_token>" -o ./deliver.json
```

- `key_b64` 为空（常态）→ 下载 `url`；非空（历史加密订单）→ 改下载 `proxy_url`（服务端流式解密代理，支持断点续传）。**两者都不进对话**（腾讯侧临时签名地址）。
- `curl -sSL -C - --retry 3 -o "./sph-downloads/<净化文件名>.mp4" "<url>"`；>50MB 放后台跑。文件名 = 净化标题去换行和 `/\:*?"<>|`、截断 60 字符。
- 409 → 3s 后重试；403 → 从订单文件恢复 token。

## 7. 交付汇报

展示**时长 / 体积 / 分辨率 / mp4 绝对路径**（元数据来自 deliver 响应，不需要 ffprobe），并说明视频不做云端保存、本地文件是唯一副本。用户要提取音频且本机已有 ffmpeg 时（不安装）：`ffmpeg -i "<mp4>" -vn -acodec copy "<标题>.m4a"`。用户想要同达人更多作品 → `references/finder.md`。

## 8. 恢复中断的下载

用户说「继续」→ 找 `./sph-downloads/.orders/*.json`（`cwd` 记录下单时工作目录，换了目录先按它找），读订单从第 5 步继续（已 resolved 则直接第 6 步）；下载 `curl -C -` 自动续传。批量/套餐订单的恢复见 `references/finder.md`。找不到订单文件 → 请用户提供订单号，或重新下单。
