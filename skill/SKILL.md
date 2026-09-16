---
name: sph-download
description: 下载视频号(WeChat Channels/ sph / finder)分享链接中的视频——先展示视频预览信息，用户微信扫码支付后由云端解析、下载并解密为本地 mp4。当用户给出 weixin.qq.com/sph/ 短链、channels.weixin.qq.com/finder-preview 链接、export/ 开头的视频号 id，或说"下载/保存/解析这个视频号视频"时使用本 skill。Use when the user wants to download a WeChat Channels (视频号) video from a share link.
---

# 视频号付费下载

后端 API 地址从环境变量 `SPH_API` 或本 skill 目录下 `config.json`（`{"api":"https://..."}`）读取，两者都没有时必须先问用户。

## 流程（严格按序执行）

### 1. 提取链接
从用户消息中正则提取：
```
https?://weixin\.qq\.com/sph/\S+
https?://channels\.weixin\.qq\.com/\S*finder-preview\S*
export/[A-Za-z0-9+/=_-]+
```
- 找到多个链接 → 列出让用户选一个
- **不要自己做归一化**（后端是单一事实源），原样提交
- 提取不到 → 请用户粘贴"视频号分享链接"（微信里 分享→复制链接）

### 2. 创建订单（拿到预览+支付码）
```bash
curl -sS -X POST "$SPH_API/api/preview" -H 'content-type: application/json' \
  -d '{"url":"<原始链接>"}'
```
成功返回 `{order_id, order_token, amount_cents, code_url, expire_at, preview:{...}}`。
- 响应会慢 3~6s（下单前做解析预检），正常
- 400 `unsupported_link` → 告知用户仅支持短链（export 链接无法解析）
- 503 `resolve_unavailable` → 解析通道暂不可用，未创建订单；告知用户稍后重试
**立即落盘**（会话中断可恢复）：
```bash
mkdir -p ./sph-downloads/.orders && cat > "./sph-downloads/.orders/<order_id>.json" <<EOF
{"order_id":"...","order_token":"...","expire_at":...,"title":"..."}
EOF
```

### 3. 展示预览（markdown）
用 `preview` 字段渲染：封面图（markdown 图片）、标题、作者+头像、点赞数、发布时间（转本地时间）。
然后 prominently 显示：
- **价格：¥X.XX**（amount_cents/100）
- 订单号、付款截止时间（expire_at 转本地时间）
- 提示："支付完成后开始解析并下载。视频仅供个人学习备份，请勿用于商业用途。"
- 时长/文件大小支付后才能确认

### 4. 渲染微信支付二维码
```bash
python3 ~/.claude/skills/sph-download/scripts/qr.py "<code_url>"
```
终端 UTF8 二维码（▀▄ 半块字符）。提示用户用微信扫码。
- 用户反馈扫不出来 → `qr.py "<code_url>" --png` 生成图片并给出绝对路径让用户打开扫
- qr.py 报缺库 → `pip install --user -i https://mirrors.aliyun.com/pypi/simple/ qrcode pillow` 后重试

### 5. 轮询支付状态（一条命令，脚本内置节奏）
```bash
python3 ~/.claude/skills/sph-download/scripts/poll.py --api "$SPH_API" --order <order_id> --token <order_token>
```
- 前 30s 每 3s、之后每 5s，总超时 5min
- 支付成功后会自动等到解析完成（status=resolved）才退出
- 退出码 0 = resolved；2 = 超时仍 pending；3 = refunded/failed/expired

超时(pending)：告知用户二维码仍有效至截止时间，订单文件已保存在 `./sph-downloads/.orders/`，付完款随时说"继续"即可恢复（用订单文件里的 token 重新轮询）。
refunded/failed：告知"解析失败，费用已原路退回"。

### 6. 取货
```bash
curl -sS "$SPH_API/api/order/<order_id>/deliver?token=<order_token>"
```
返回 `{url, key_b64, enc_len, file_size, title}`。
- 409 not_ready → 等 3s 再试
- 403 → 从订单文件恢复 token
- **`key_b64` 为空或 `enc_len` 为 0（常态）**：`url` 是明文 MP4 直链 → 按第 7 步直接下载，跳过第 8 步
- `key_b64` 非空（历史加密订单）：走第 7 步 `.enc` + 第 8 步解密

### 7. 下载（断点续传，可后台）
明文直链（常态）：
```bash
curl -sSL -C - --retry 3 -o "./sph-downloads/<净化文件名>.mp4" "<url>"
```
历史加密订单：目标文件改为 `<净化文件名>.mp4.enc`，下载后进第 8 步。
- 文件名：标题去除换行和 `/\:*?"<>|`，截断 60 字符
- 大文件（>50MB）放后台跑，期间可 `ls -l` 查看进度

### 8. 解密（仅历史加密订单：原地 XOR 前 enc_len 字节）
密钥 base64 约 175KB，超出命令行参数上限，必须先存文件：
```bash
curl -sS "$SPH_API/api/order/<order_id>/deliver?token=<order_token>" -o /tmp/deliver.json
python3 -c "import json;open('/tmp/key.b64','w').write(json.load(open('/tmp/deliver.json'))['key_b64'])"
python3 ~/.claude/skills/sph-download/scripts/decrypt.py "./sph-downloads/<文件>.mp4.enc" /tmp/key.b64 <enc_len> "./sph-downloads/<文件>.mp4"
```
脚本会校验 offset 4 处为 `ftyp`，失败则报错并保留 .enc 文件。

### 9. 汇报
```bash
ffprobe -v error -show_entries format=duration,size -of json "<mp4>"
```
展示时长/体积，给出 mp4 绝对路径，删除 .enc 中间文件。

## 恢复中断的下载
会话里已有订单（`./sph-downloads/.orders/*.json` 存在）且用户说"继续"时：读订单文件 → 从第 5 步轮询继续（若已 resolved 则直接第 6 步）；第 7 步 `curl -C -` 自动续传。
