---
name: sph-video-wechat-channels-downloader
description: 视频号（微信视频号 / WeChat Channels）视频下载与解析：粘贴一条分享短链，解析出标题、作者、封面、话题标签等视频信息，并下载原画质、无水印的 MP4 保存到本地。也支持达人检索与批量：按昵称搜达人、列出达人作品短链、批量转直链下载。交付物是本地文件路径，不是会失效的临时直链；本地零配置，无需抓包工具、Playwright。当用户要下载、保存、留存、提取视频号视频，批量下载达人作品，或直接贴出 weixin.qq.com/sph/xxx、channels.weixin.qq.com/finder-preview/xxx 链接时使用。中文触发词：视频号下载、微信视频号下载、视频号视频保存、保存视频号到本地、短视频解析、视频号去水印、视频号无水印下载、下载视频号原画、视频号 MP4、视频号封面、sph 短链、微信视频保存、达人检索、找达人、博主主页视频、达人全部作品、批量下载视频号、视频号批量下载。Use when a WeChat Channels (视频号) share link must be downloaded or saved as a local MP4, or when the user wants to search a Channels creator (达人) and batch-download their videos. download WeChat Channels video, WeChat Channels video downloader, download short video from WeChat Channels, WeChat video download, save WeChat video, save WeChat video to camera roll, save WeChat video to computer, keep a copy of WeChat video, grab video from WeChat link, get mp4 from WeChat link, extract mp4 from WeChat Channels link, WeChat Channels link parser, download WeChat video no watermark, watermark-free, original quality, full quality, save offline, Channels creator search, batch download creator videos.
---

# 视频号下载与解析（原画直链 · 免费预览层）

流程：**依赖预检** → 提取链接 → 创建订单 → **按轨道渲染预览页** → 扫码支付 → 轮询 → **下载到本地** → 汇报（交付物 = 本地文件路径）→ **同达人作品追问（6.5 节，免费）**。脚本在 `$SKILL_DIR/scripts/`；细节文档：`references/rendering.md`（渲染与交付·运行时口径）、`references/api.md`（API 契约）、`references/faq.md`（应答口径）、`references/finder.md`（达人检索与批量·钱包额度模式）、`assets/README.md`（小程序码素材，维护用）；**改渲染器 / 换素材 / 改价 / 改名时才读 `references/rendering-dev.md`（维护手册），运行时不用**。

用户要**找达人 / 下载某达人的作品 / 批量下载多条**时改走第 9 节（钱包/额度模式，免逐条支付）；单视频且钱包已有直链额度时也可免支付直取（见第 9 节末）。

- **所有 Python 脚本一律用 `$PY` 调用**（第 0 步取）——qrcode/pillow 装在隔离 venv 里，裸 `python` 报 `ModuleNotFoundError`；Windows 上 `python3` 常是商店存根，不可用。
- ffmpeg 一律经 `ensure_ffmpeg.py`（探测 / `--install` / `--probe` / `--path`），不裸调 `ffmpeg` / `ffprobe`。

## 0. 依赖预检（开工第一步，不要等报错）

缺依赖会炸在离病根很远的位置（渲染炸在第 3 步、ffmpeg 缺失到第 5 步才发现，此时订单已建），**先预检把问题挡在创建订单之前**。用户不在场且预检失败：先 `--install`，仍失败就如实告知缺什么及后果，再问是否继续：

```bash
python "$SKILL_DIR/scripts/ensure_deps.py"             # 就绪退出 0，缺失退出 2
python "$SKILL_DIR/scripts/ensure_deps.py" --install   # 缺失时才装（幂等）
PY=$(python "$SKILL_DIR/scripts/ensure_deps.py" --python)   # 后续脚本统一用 $PY
```

| 依赖 | 谁在用 | 缺失后果 |
|---|---|---|
| `qrcode` + `pillow` | render_order / qr / prep_mp_qr | 第 3 步拒绝渲染，建订单全白做 |
| `ffmpeg` | 第 5/6 步读媒体信息、提音频 | 交付页无媒体信息、音频提取失败 |

- 两者都装进同一个用户级隔离 venv（`~/.workbuddy/.cache/sph/venv`）：无需管理员、不动 PATH、不污染环境；`ensure_deps.py` 自动挑"能 import 成功"的解释器（venv → 当前 → PATH）。
- ffmpeg 缺失时**先问用户**（要下约 40MB 二进制），点头后 `"$PY" "$SKILL_DIR/scripts/ensure_ffmpeg.py" --install`（imageio-ffmpeg 静态二进制，走阿里云镜像、幂等；机器上已有则直接复用）。**ffprobe 可能不存在**：读媒体信息一律 `ensure_ffmpeg.py --probe`，缺 ffprobe 时自动降级解析 `ffmpeg -i`，输出同构。

## 1. 提取链接

从用户消息中提取 `https?://weixin\.qq\.com/sph/\S+`、`https?://channels\.weixin\.qq\.com/\S*finder-preview\S*` 或 `export/[A-Za-z0-9+/=_-]+`。链接**原样提交**不要改写；多个链接让用户选一个；提取不到 → 请用户在微信里 分享→复制链接 后贴过来。

## 2. 创建订单

> **先看钱包**：`~/.config/sph/user_token` 存在且 `link_quota > 0`（`"$PY" "$SKILL_DIR/scripts/wallet.py" me`）→ 单视频免支付，改走第 9 节的 `/api/resolve` 直取，跳过本章 2~4 步。

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/order" -H 'content-type: application/json' \
  -d '{"url":"<原始链接>"}' -o ./order_response.json
```

成功返回 `{order_id, order_token, amount_cents, code_url, expire_at, preview:{...}}`（慢 3~6s 正常）。**完整原始响应落盘 `./order_response.json`**（A 轨渲染要用，不要裁剪字段）；**只 POST 一次**，重复 POST 会创建多个订单。只想先问价格 → `curl -sS https://sph.yes-tek.com/healthz`（返回 `price_cents`），不创建订单。

**立即落盘订单摘要**（`cwd` 记绝对路径，供跨会话恢复）：

```bash
mkdir -p ./sph-downloads/.orders && cat > "./sph-downloads/.orders/<order_id>.json" <<EOF
{"order_id":"...","order_token":"...","expire_at":...,"title":"...","code_url":"...","cwd":"$(pwd)"}
EOF
```

失败告知用户：400 `unsupported_link` → 仅支持短链，export 链接无法下载；429 → 太频繁，1 分钟后再试；503 → 解析通道暂不可用（未创建订单、未扣费），稍后重试。

## 3. 展示预览 + 支付（先判轨道）

预览承载三件性质不同的事：**视频信息**（判断要不要）、**免费备选**（记或忽略）、**支付二维码**（立刻行动），压成一条 Markdown 文字流会层级塌陷、扫码转化掉。**先判载体再定轨道**：有 present_files 面板 → **A 轨**；无面板但本机有桌面（macOS / Linux 图形会话 / Windows）→ **也是 A 轨**，同一个 HTML 改用系统命令打开（打开页面和打开 PNG 没差别，信息量却大得多）；纯终端（服务器无桌面）→ **B 轨**终端渲染。探测命令与分界原理见 `references/rendering.md` §二。

### A 轨 · 页面载体（面板或系统浏览器）— 默认

```bash
"$PY" "$SKILL_DIR/scripts/render_order.py" \
  --in ./order_response.json --url "<原始分享短链>" --stage pay \
  --out "./sph-downloads/<净化标题>.html"
```

然后 **present_files 打开**（单文件自包含，公司 logo/封面/头像/支付码/小程序码全部 base64 内嵌，顶栏品牌链官网）；**无面板但有桌面**时改用系统命令打开——macOS `open`、Linux `xdg-open`、Windows `cmd //c start ""`——其余不变（重渲交付态后浏览器刷新即见）。对话侧**只留 3 行**，不复述页面内容：

> ¥X.XX · 剩余 XX 分 XX 秒 · 微信扫码付费
> 不想付费：小程序《越思工具》
> （详见预览面板）

### B 轨 · 纯终端（服务器无桌面）

没有面板也**没有桌面**（SSH 到服务器跑 CLI 等）——终端是唯一屏幕，直接终端渲染；给 PNG 路径没有意义（机器上没有任何图片查看器打得开）：

```bash
"$PY" "$SKILL_DIR/scripts/qr.py" "<code_url>" --invert
```

`--invert` 必加（终端极性天然相反）；码块**原样**贴进回复（代码围栏），用户拿手机扫屏幕；qr.py 自带 border=4 静区与超宽自动降级 PNG（降级时打印路径，可传到有屏幕的设备再扫）。

文本给：净化标题、作者、点赞数、发布时间、价格、订单号、付款截止时间、免费通道一句话、套餐价目一行（先跑 `"$PY" "$SKILL_DIR/scripts/render_order.py" --dump-packages` 取价，**别凭记忆写**；末尾缀「要买说『买套餐 X』」）、免责提醒。

### 通用规则（两轨都适用）

- **标题净化**：`preview.title` 尾部焊着话题标签串（实测与 `description` 逐字符相同），展示、命名前必须过 `clean_title()` 剥掉；标签仅用户明确要时从 `extract_tags()` 给出；**绝不要把 `preview.description` 标成"文案/逐字稿"**——它不含任何口播内容。细节见 `references/rendering.md` §七。
- **二维码极性铁律**：屏幕扫码必须**白底黑码**，绝不跟随深色主题反色（HTML 由 `.qr{background:#fff}` 强制；终端才用 `--invert`，因终端极性天然相反）。
- **免费交付**：`curl -sSL -o "./sph-downloads/<净化标题>.jpg" "<preview.cover>"`
- **必传达**：价格 ¥X.XX（amount_cents/100）、订单号、付款截止时间（expire_at 转本地时间）、免费通道提示（"不想付费？微信搜索小程序《越思工具》可免费下载"）、免责提醒"支付完成后开始解析并下载。视频仅供个人学习备份，请勿用于商业用途"（时长/文件大小支付后才能确认）。
- **不主动贴卖点**（服务端预检 / 失败退款 / 原画直链）——那是用户发问时的应答口径（第 8 节 / `references/faq.md`），主动展示只是噪音，更不进预览页。**套餐定价例外**：它是定价信息不是话术，支付态页面自带套餐与权益卡（三档定价 + 即时到账/永久有效/售出不退三条款 + 对话购买引导），交付态不渲染；用户在对话里说「买套餐 X」→ 走第 9 节第 5 步购买流。

## 4. 轮询支付状态

```bash
"$PY" "$SKILL_DIR/scripts/poll.py" --order <order_id> --token <order_token>
```

API 基址硬编码在脚本内（`https://sph.yes-tek.com`），无 `--api` 参数。退出码 0 = 解析完成；2 = 5 分钟仍未支付；3 = 退款/失败/过期。超时(2) → 二维码截止前仍有效，付款后随时说"继续"即可恢复，并再次给出免费通道备选；退款/失败(3) → 告知"解析失败，费用已原路退回"；429 由脚本自动退避消化（15s 起翻倍、上限 60s），不需人工干预、不算故障。

## 5. 取货 + 下载（本地文件才是交付物）

```bash
curl -sS "https://sph.yes-tek.com/api/order/<order_id>/deliver?token=<order_token>" -o ./deliver.json
```

返回 `{url, key_b64, enc_len, file_size, title}`。409 → 3s 后重试；403 → 从订单文件恢复 token。

> **不要把 `url` 交给用户。** 服务端不留存视频，直链是腾讯侧带签名的临时地址，会过期、存不住。`deliver` 仍要调用（它是解析完成的凭据，也提供 `file_size`），但 `url` 只用于下面的下载动作，不进任何用户可见层。

- `key_b64` 为空（常态）→ 直接下载；非空（旧订单）→ 下载为 `.mp4.enc`，再解密：`"$PY" -c "import json;open('./key.b64','w').write(json.load(open('./deliver.json'))['key_b64'])" && "$PY" "$SKILL_DIR/scripts/decrypt.py" "<文件>.mp4.enc" ./key.b64 <enc_len> "<文件>.mp4"`

**下载**（断点续传；>50MB 放后台跑，期间可 `ls -l` 看进度）。文件名 = 标题去换行和 `/\:*?"<>|`、截断 60 字符：

```bash
curl -sSL -C - --retry 3 -o "./sph-downloads/<净化文件名>.mp4" "<url>"
```

**A 轨 · 二次渲染为交付态**（覆盖同一个 HTML，页面自动从「待支付」变「解析完成」；主交付物是本地路径，默认不显示直链）：

```bash
"$PY" "$SKILL_DIR/scripts/ensure_ffmpeg.py" --probe "<mp4>" > ./probe.json
"$PY" "$SKILL_DIR/scripts/render_order.py" \
  --in ./order_response.json --url "<原始分享短链>" --stage delivered \
  --local-path "<mp4 绝对路径>" --probe ./probe.json \
  --out "./sph-downloads/<净化标题>.html"
```

再 present_files。交付态与支付态形状不同：只有一张合并卡、不放免费通道、无任何二维码。**状态推进归对话侧**：后端 `/status` 无 CORS，页面 JS 只做本地倒计时，状态变化由 poll.py 驱动后二次渲染（`references/rendering.md` §五）。

## 6. 汇报与下游能力

展示**时长、体积、mp4 绝对路径**三行即可。**不把 CDN 直链贴进对话**——只给本地路径；提醒用户：视频不做云端保存，本地文件是唯一副本，请妥善保管。下载完成后**主动提供**下游选项（本地 ffmpeg 即可，不再收费，路径用 `FFMPEG=$("$PY" "$SKILL_DIR/scripts/ensure_ffmpeg.py" --path ffmpeg)` 取）：

- **提取音频**：`"$FFMPEG" -i "<mp4>" -vn -acodec copy "<标题>.m4a"`（视频号音轨是 AAC，流复制无损、秒级；报容器不支持则源音轨非 AAC，换 `-c:a aac` 重编码）

## 6.5 同达人其他作品（交付后主动追问 · 列表免费）

单视频交付汇报后，紧接着主动追问一句"要不要同达人的其他作品"。达人检索和每达人前 10 条列表**全程免费**（仅限频、不扣任何额度），承接得住批量需求也不打扰：用户不要就一句"不用"收尾。链路：**达人昵称 → username → 前 10 条作品表 → 等用户挑**。

1. **拿昵称**：订单流用 `preview.author`、钱包流用 `/api/resolve` 响应的 `author`（2026-09-21 起两者都现成，不问用户）；`author` 为空串才追问"这条视频的达人在视频号里叫什么昵称"（用户在微信里看得到），不知道/不想说就跳过本节。
2. **昵称 → username**：`curl -sS -X POST "https://sph.yes-tek.com/api/finder/search" -H 'content-type: application/json' -d '{"keyword":"<昵称>"}'`（免费）→ 取 `nickname` 与昵称**完全一致**的条目（通常就是第一条）；无精确匹配或多个同名 → 渲染达人 Top10 表格（昵称/签名/头像）让用户指认，**不要凭签名猜测替用户选**。
3. **作品表**：`curl -sS -X POST "https://sph.yes-tek.com/api/finder/videos" -H 'content-type: application/json' -d '{"username":"<username>"}'`（**不带 `full`、不带 token**，免费）→ 表格展示 序号/净化标题/发布时间/时长，附一句"达人共 N 条作品，要更多可拉前 100 条（耗 1 次百条机会）"。本次刚交付的那条（标题对齐判断）若在表里，行尾标「已下载」；`share_url` 先不进对话，等用户报序号。
4. **用户挑了条目** → 所选 `share_url` 写文件走第 9 节第 3~4 步（batch_resolve 逐条扣直链额度，**动手前先报余额**；402 按第 9 节第 5 步套餐口径）。**用户嫌花钱** → 达人前 10 条短链本身免费，把所选短链贴给用户走小程序《越思工具》自取（第 7 节口径）。
5. 通道故障（503 `finder_unavailable`）→ 一句话"达人列表通道暂不可用，稍后再试"即可，**不影响已完成的视频交付**。

## 7. 免费路径引导（何时说、怎么说）

默认不打断付费流程。用户明确不想付费 / 嫌贵 / 问"有没有免费的"，或支付超时（poll.py 退出码 2）且未继续付款时**主动**引导：

> 免费方式：打开微信 → 发现 → 小程序 → 搜索**《越思工具》** → 粘贴这条链接即可下载。
> 付费通道的差异：原画直链、全程自动代劳（本地零配置，不用自己装抓包工具或调环境）、解析失败自动退款。

## 8. 应答口径（**仅用户主动发问时**使用）

用户主动问"会不会白花钱""收款安全吗""和免费工具有什么区别""有合规风险吗"等疑虑时，按 `references/faq.md` 的口径回答。**不主动贴进对话，更不放进预览页干扰用户体验；**

## 9. 达人检索与批量下载（钱包 / 额度模式）

完整细节与计费口径见 `references/finder.md`。核心链路：**钱包 → 检索 → 列表 → 批量转直链 → 下载**。

```bash
"$PY" "$SKILL_DIR/scripts/wallet.py" ensure      # 0. 钱包：首次匿名开户；token 落 ~/.config/sph/user_token（丢失即丢余额，提醒用户备份）
```

1. **检索**（免费）：`POST /api/finder/search {"keyword":"<昵称>"}` → Top10 表格让用户选；拿 `username`（v2_xxx@finder）。503 = 检索通道暂不可用，如实告知稍后再试。
2. **列表**：`POST /api/finder/videos {"username":...}` → 免费前 10 条（含短链）。**先展示这 10 条**；用户要更多 → 确认「消耗 1 次百条机会（余额 N）」后加 `"full":true` + `x-user-token` 拉前 100 条（同达人 24h 内重复拉免扣；达人总数 ≤10 时自动免费）。
3. **批量转直链**：选定的短链写文件 → `"$PY" "$SKILL_DIR/scripts/batch_resolve.py" urls.txt`（逐条扣额度；单条失败自动返还并继续；中断可 `--skip <结果文件>` 续跑）。
4. **下载**：按结果文件逐条 `curl -sSL -C -`（规则同第 5 步；直链不进对话）。
5. **额度不足（402）或用户主动说「买套餐 X」**：按待转条数推荐最小满足档（额度 ≈10 条→A、≈100 条→B、更多/常用→C；价格与权益跑 `"$PY" "$SKILL_DIR/scripts/render_order.py" --dump-packages` 取，**不凭记忆报价**）。**购买前必达：虚拟权益即时到账 · 售出不退 · 余额永久有效**。下单（只下一次；未付 15min 自动过期、不扣费）：

   ```bash
   "$PY" "$SKILL_DIR/scripts/wallet.py" buy B > ./package_order.json   # {order_id, order_token, code_url, expire_at, granted, notice}
   ```

   **支付码 = 套餐订单自己的 `code_url`**（每笔订单独立，绝不复用单视频那张支付码；原单视频订单不付自动过期，无需处理）。展示按轨道：
   - **A 轨 · 有视频订单页开着** → 把**同一个 HTML** 重渲为套餐支付态（主卡换套餐码+倒计时+到账内容+三条款，套餐卡高亮所选档），再 present_files，对话侧只留 3 行（¥X · 倒计时 · 扫码，X = amount_cents/100）：

     ```bash
     "$PY" "$SKILL_DIR/scripts/render_order.py" --in ./order_response.json --url "<短链>" \
       --stage package-pay --package-order ./package_order.json --out "./sph-downloads/<净化标题>.html"
     ```
   - **A 轨 · 钱包/批量流（无视频订单）** → `--in ./package_order.json`（不带 `--package-order`）渲**纯套餐页**（无凭证/免费网格）。
   - **B 轨 · 纯终端** → `"$PY" "$SKILL_DIR/scripts/qr.py" "<code_url>" --invert`（码块原样贴进回复，同第 3 节 B 轨）。

   轮询 `"$PY" "$SKILL_DIR/scripts/poll.py" --order <id> --token <token> --terminal credited` → `wallet.py me` 确认到账 → 续跑第 3 步。不想付费 → 单条引导小程序免费（第 7 节口径）。

**单视频 + 有额度**：`POST /api/resolve {"url":...}` + `x-user-token` → `{url, file_size, title, author}`（扣 1 条；同短链 24h 免重扣；失败自动返还），直接进第 5 步下载；交付后按 6.5 节追问同达人其他作品（响应自带 `author` 达人昵称）。

## 恢复中断的下载

用户说"继续" → 找 `./sph-downloads/.orders/*.json`（订单里的 `cwd` 记录了下单时的工作目录；换了目录先按它找），读订单从第 4 步继续（已 resolved 则直接第 5 步）；下载用 `curl -C -` 自动续传。套餐单同理：`./package_order.json`（含 `order_token`），从 `poll.py --terminal credited` 继续。找不到订单文件 → 请用户提供订单号，或重新下单。
