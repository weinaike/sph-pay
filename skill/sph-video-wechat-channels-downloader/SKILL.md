---
name: sph-video-wechat-channels-downloader
description: 视频号（微信视频号 / WeChat Channels）视频下载与解析：粘贴一条分享短链，解析出标题、作者、封面、话题标签等视频信息，并下载原画质、无水印的 MP4 保存到本地。也支持达人检索与批量：按昵称搜达人、列出达人作品短链、批量转直链下载。交付物是本地文件路径，不是会失效的临时直链；本地零配置、零依赖，无需抓包工具、Playwright、ffmpeg。当用户要下载、保存、留存、提取视频号视频，批量下载达人作品，或直接贴出 weixin.qq.com/sph/xxx、channels.weixin.qq.com/finder-preview/xxx 链接时使用。中文触发词：视频号下载、微信视频号下载、视频号视频保存、保存视频号到本地、短视频解析、视频号去水印、视频号无水印下载、下载视频号原画、视频号 MP4、视频号封面、sph 短链、微信视频保存、达人检索、找达人、博主主页视频、达人全部作品、批量下载视频号、视频号批量下载。Use when a WeChat Channels (视频号) share link must be downloaded or saved as a local MP4, or when the user wants to search a Channels creator (达人) and batch-download their videos. download WeChat Channels video, WeChat Channels video downloader, download short video from WeChat Channels, WeChat video download, save WeChat video, save WeChat video to camera roll, save WeChat video to computer, keep a copy of WeChat video, grab video from WeChat link, get mp4 from WeChat link, extract mp4 from WeChat Channels link, WeChat Channels link parser, download WeChat video no watermark, watermark-free, original quality, full quality, save offline, Channels creator search, batch download creator videos.
---

# 视频号下载与解析（原画直链 · 免费预览层）

流程：**提取链接 → 判钱包 → 创建订单 → 把支付页链接给用户 → 轮询 → 下载到本地 → 汇报（交付物 = 本地文件路径）→ 同达人作品追问（第 8 节，免费）**。展示与支付全在服务端托管页上完成，本地不渲染任何页面。

- **零依赖**：仅 `poll.py`（订单/批量轮询）与 `wallet.py`（开户/余额/购套餐）两个脚本，纯 Python 标准库，`python3` 直跑（Windows 商店存根时换 `python`）；其余动作全是 `curl`。**绝不安装任何包或二进制**。
- 所有文件统一落 `./sph-downloads/`；钱包 token 在 `~/.config/sph/user_token`（丢失即丢余额，开户后提醒用户备份）。
- 文档：API 契约 `references/api.md`；应答口径 `references/faq.md`（仅用户主动发问时用）；达人检索与批量 `references/finder.md`。

## 1. 提取链接

从用户消息中提取 `https?://weixin\.qq\.com/sph/\S+`、`https?://channels\.weixin\.qq\.com/\S*finder-preview\S*` 或 `export/[A-Za-z0-9+/=_-]+`。链接**原样提交**不要改写；多个链接让用户选一个；提取不到 → 请用户在微信里 分享→复制链接 后贴过来。

## 2. 先看钱包（有额度则免支付直取）

`~/.config/sph/user_token` 存在时先 `python3 "$SKILL_DIR/scripts/wallet.py" me`：`link_quota > 0` → 单视频免支付，直接走第 9 节末的 `/api/resolve` 直取，跳过本章 3~5 步。

## 3. 创建订单（单视频 ¥1，以 /healthz 的 price_cents 为准）

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/order" -H 'content-type: application/json' \
  -d '{"url":"<原始链接>"}' -o ./order_response.json
```

成功返回 `{order_id, order_token, amount_cents, expire_at, page_url, preview:{title,author,...,file_size,duration_s,width,height}}`（慢 3~8s 正常，含真实解析预检）。**完整原始响应落盘 `./order_response.json`**；**只 POST 一次**（重复 POST 建多个订单）。只想问价格 → `curl -sS https://sph.yes-tek.com/healthz`。

立即落盘订单摘要（`cwd` 记绝对路径，供跨会话恢复）：

```bash
mkdir -p ./sph-downloads/.orders && cat > "./sph-downloads/.orders/<order_id>.json" <<EOF
{"order_id":"...","order_token":"...","expire_at":...,"page_url":"...","cwd":"$(pwd)"}
EOF
```

失败告知用户：400 `unsupported_link` → 仅支持短链；429 → 1 分钟后再试；503 → 解析通道暂不可用（未创建订单、未扣费），稍后重试。

## 4. 给支付页链接（用户唯一动作：打开链接、扫码/点按支付）

把响应里的 **`page_url` 原样交给用户**——这是服务端托管页，自含视频信息（标题/作者/封面/点赞/体积/时长）、价格倒计时、微信支付码、免费通道与套餐价目，**支付状态页面自动推进**，本地无需渲染、无需重渲、无需 present_files。对话侧只留 3 行：

> ¥X.XX · 剩余 XX 分（expire_at 转本地时间）· 打开链接微信扫码支付：<page_url>
> 不想付费：微信搜索小程序《越思工具》
> 付款后回到这里，我继续下载

- 手机微信里打开该链接可**直接点按拉起支付**（无需扫码）；电脑打开则扫页面上的码。纯终端（SSH 服务器）场景**同样只给链接**——用户在任意有屏幕的设备打开即可，不存在终端渲染轨道。
- 页面不是交付物：解析完成页面只提示「回到对话」，下载与本地路径交付由本对话完成。
- 标题净化：`preview.title` 尾部焊着话题标签串（与 `description` 逐字符相同）——展示/命名前剥掉尾部连续 `#标签` 串（剥空则原样保留）；标签仅用户明确要时单独给出。**不要把 `preview.description` 标成"文案/逐字稿"**（不含口播内容）。
- 免费交付：`curl -sSL -o "./sph-downloads/<净化标题>.jpg" "<preview.cover>"`。

## 5. 轮询支付状态

```bash
python3 "$SKILL_DIR/scripts/poll.py" --order <order_id> --token <order_token>
```

退出码 0 = 解析完成；2 = 5 分钟仍未支付（二维码有效期内付款后随时说"继续"，再给免费通道备选）；3 = 退款/失败/过期（告知"解析失败，费用已原路退回"）。429 由脚本自动退避，不算故障。

## 6. 取货 + 下载（本地文件才是交付物）

```bash
curl -sS "https://sph.yes-tek.com/api/order/<order_id>/deliver?token=<order_token>" -o ./deliver.json
```

返回 `{url, file_size, duration_s, width, height, title, proxy_url, key_b64, enc_len}`。409 → 3s 后重试；403 → 从订单文件恢复 token。**`url` 不进任何用户可见层**（服务端不留存视频，直链是腾讯侧临时签名地址）：

- `key_b64` 为空（常态）→ `curl -sSL -C - --retry 3 -o "./sph-downloads/<净化文件名>.mp4" "<url>"`（断点续传；>50MB 放后台跑，期间 `ls -l` 看进度）
- `key_b64` 非空（历史加密订单）→ 改下载 `proxy_url`（服务端流式解密代理，支持断点续传），**不要**再下 `url`

文件名 = 净化标题去换行和 `/\:*?"<>|`、截断 60 字符。

## 7. 汇报与下游能力

展示**时长（duration_s）/体积/分辨率（width×height）/mp4 绝对路径**——元数据来自 deliver 响应，**不需要 ffmpeg**。提醒：视频不做云端保存，本地文件是唯一副本。下载完成后可主动提供下游选项（**仅本机已有 ffmpeg 时**，不安装）：

- 提取音频：`ffmpeg -i "<mp4>" -vn -acodec copy "<标题>.m4a"`（视频号音轨是 AAC，流复制秒级；报容器不支持则换 `-c:a aac`）

## 8. 同达人其他作品（交付后主动追问 · 列表免费）

单视频交付汇报后，主动追问一句"要不要同达人的其他作品"。检索与每达人前 10 条列表**全程免费**；用户不要就一句"不用"收尾。

1. **拿昵称**：订单流用 `preview.author`、钱包流用 `/api/resolve` 响应的 `author`；为空串才追问（不知道就跳过本节）。
2. **昵称 → username**：`curl -sS -X POST "https://sph.yes-tek.com/api/finder/search" -H 'content-type: application/json' -d '{"keyword":"<昵称>"}'` → 取 `nickname` **完全一致**的条目；无精确匹配或多个同名 → 渲染 Top10 表格（昵称/签名/头像）让用户指认，不替用户猜。
3. **作品表**：`curl -sS -X POST "https://sph.yes-tek.com/api/finder/videos" -H 'content-type: application/json' -d '{"username":"<username>"}'`（免费前 10 条，含短链）→ 表格展示 序号/净化标题/发布时间/时长，附"达人共 N 条，要更多可拉前 100 条（耗 1 次百条机会）"。刚交付的那条在表里则标「已下载」。
4. **用户挑了** → 走第 9 节第 3 步批量（**动手前先报余额**）。**用户嫌花钱** → 把所选短链免费给用户走小程序自取。
5. 503 `finder_unavailable` → "达人列表通道暂不可用，稍后再试"，不影响已完成的交付。

## 9. 达人检索与批量下载（钱包 / 额度模式）

```bash
python3 "$SKILL_DIR/scripts/wallet.py" ensure   # 0. 首次匿名开户；token 落 ~/.config/sph/user_token
python3 "$SKILL_DIR/scripts/wallet.py" me       # 余额：link_quota / search_credits / 已购
```

1. **检索**（免费）：`POST /api/finder/search {"keyword":"<昵称>"}` → Top10 表格让用户选，拿 `username`（v2_xxx@finder）。
2. **列表**：`POST /api/finder/videos {"username":...}` 免费前 10 条；要更多 → 确认「消耗 1 次百条机会（余额 N）」后加 `"full":true` + `x-user-token` 拉前 100 条（同达人 24h 免重扣；总数 ≤10 免费）。
3. **批量转直链（服务端批处理，已无客户端节拍）**：选定短链去 POST——

   ```bash
   curl -sS -X POST "https://sph.yes-tek.com/api/resolve/batch" -H 'content-type: application/json' \
     -H "x-user-token: <token>" -d '{"urls":["<短链1>","<短链2>",...]}'          # ≤100 条，自动去重
   python3 "$SKILL_DIR/scripts/poll.py" --batch <batch_id>    # 轮询到完成，结果落 ./sph-downloads/batch-<id>.json
   ```

   服务端逐条扣额度、失败自动返还、额度不足余条跳过（结果文件里逐条标注状态）；中断可重跑同命令续查。**动手前先报余额**；余额不足（跳过条目多）→ 第 5 步购套餐后续跑剩余。
4. **下载**：按结果文件逐条 `curl -sSL -C - --retry 3 -o "./sph-downloads/<净化标题>.mp4" "<cdn_url>"`（直链不进对话）。
5. **买套餐**：价目先查 `curl -sS https://sph.yes-tek.com/api/package`（**别凭记忆报价**）；购买前必达「虚拟权益即时到账 · 售出不退 · 余额永久有效」。下单（只下一次）：

   ```bash
   python3 "$SKILL_DIR/scripts/wallet.py" buy B > ./package_order.json   # {order_id, order_token, page_url, expire_at, granted, notice}
   ```

   把响应里的 `page_url` 按第 4 节口径给用户扫码（套餐订单自己的页面，不复用单视频那张）。轮询 `poll.py --order <id> --token <t> --terminal credited` → `wallet.py me` 确认到账 → 续跑第 3 步。

**单视频 + 有额度**：`POST /api/resolve {"url":...}` + `x-user-token` → `{url, file_size, title, author, duration_s, width, height, charged}`（扣 1 条；同短链 24h 免重扣；失败自动返还），直接进第 6 步下载；交付后按第 8 节追问。

**用户在支付页直购了套餐**（页面点「直接购买」当页扫码，权益落在页面钱包）：用户会粘来一串 64 位十六进制**钱包码**。处理：先 `wallet.py me` 查本地钱包——本地无钱包或余额为 0 → 直接写入：

```bash
mkdir -p ~/.config/sph && printf '%s' "<钱包码>" > ~/.config/sph/user_token
```

写入后 `wallet.py me` 确认余额到账再继续第 3 步批量。**本地钱包有余额时不要直接覆盖**：两个钱包余额独立，告知用户并让其选择（切换前把旧码报给用户备份）。

## 免费路径引导（何时说、怎么说）

默认不打断付费流程。用户明确不想付费 / 嫌贵 / 问"有没有免费的"，或支付超时（poll.py 退出码 2）且未继续付款时**主动**引导：

> 免费方式：打开微信 → 发现 → 小程序 → 搜索**《越思工具》** → 粘贴这条链接即可下载。
> 付费通道的差异：原画直链、全程自动代劳（本地零配置零依赖）、解析失败自动退款。

## 恢复中断的下载

用户说"继续" → 找 `./sph-downloads/.orders/*.json`（`cwd` 记录下单时工作目录，换了目录先按它找），读订单从第 5 步继续（已 resolved 则直接第 6 步）；下载 `curl -C -` 自动续传。套餐单同理（`./package_order.json`，从 `--terminal credited` 继续）。批量：重跑 `poll.py --batch <id>` 续查（服务端断点续跑，已扣费不重扣）。找不到订单文件 → 请用户提供订单号，或重新下单。
