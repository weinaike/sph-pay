---
name: sph-downloader
description: 下载视频号(WeChat Channels / sph / finder)视频——用户贴分享链接后先展示预览信息（封面/标题/作者/价格），微信扫码支付，云端解析出腾讯 CDN MP4 直链并下载为本地 mp4。当用户给出 weixin.qq.com/sph/ 短链、channels.weixin.qq.com/finder-preview 链接，或说"下载/保存/解析/买这个视频号视频"时使用本 skill。Use when the user wants to download or extract a WeChat Channels (视频号) video from a share link.
---

# 视频号付费下载

流程：提取链接 → 创建订单 → 展示预览 → 扫码支付 → 等解析完成 → **出示 CDN 直链** → 下载 mp4 → 汇报。

后端 API：`https://sph.yes-tek.com`（已内置）。脚本在本 skill 基目录（Base directory）的 `scripts/`，下文以 `$SKILL_DIR` 指代。

## 1. 提取链接
从用户消息中提取：
```
https?://weixin\.qq\.com/sph/\S+
https?://channels\.weixin\.qq\.com/\S*finder-preview\S*
export/[A-Za-z0-9+/=_-]+
```
- 链接**原样提交**，不要改写
- 多个链接 → 让用户选一个
- 提取不到 → 请用户在微信里 分享→复制链接 后贴过来

## 2. 创建订单
```bash
curl -sS -X POST "https://sph.yes-tek.com/api/order" -H 'content-type: application/json' \
  -d '{"url":"<原始链接>"}'
```
成功返回 `{order_id, order_token, amount_cents, code_url, expire_at, preview:{...}}`（响应慢 3~6s，正常）。

**立即落盘**：
```bash
mkdir -p ./sph-downloads/.orders && cat > "./sph-downloads/.orders/<order_id>.json" <<EOF
{"order_id":"...","order_token":"...","expire_at":...,"title":"...","code_url":"..."}
EOF
```

失败时告知用户：
- 400 `unsupported_link` → 仅支持短链，export 链接无法下载，请提供分享短链
- 429 → 操作太频繁，1 分钟后再试
- 503 → 解析通道暂不可用（未创建订单、未扣费），稍后重试

## 3. 展示预览
用 `preview` 字段渲染 markdown：封面图、标题、作者+头像、点赞数、发布时间（转本地时间）。
然后醒目给出：
- **价格：¥X.XX**（amount_cents/100）
- 订单号、付款截止时间（expire_at 转本地时间）
- 提醒："支付完成后开始解析并下载。视频仅供个人学习备份，请勿用于商业用途。"（时长/文件大小支付后才能确认）

## 4. 渲染支付二维码
```bash
python3 "$SKILL_DIR/scripts/qr.py" "<code_url>" --invert
```
提示用户用微信扫码。
- `--invert` 适配深色主题终端（默认用它）；用户终端是浅色主题时去掉
- 用户反馈扫不出来 → `qr.py "<code_url>" --png /tmp/sph-qr.png`（自动打开），给出图片绝对路径
- 报缺库 → `pip install --user -i https://mirrors.aliyun.com/pypi/simple/ qrcode pillow` 后重试

## 5. 轮询支付状态
```bash
python3 "$SKILL_DIR/scripts/poll.py" --api https://sph.yes-tek.com --order <order_id> --token <order_token>
```
退出码 0 = 解析完成；2 = 5 分钟仍未支付；3 = 退款/失败/过期。
- 超时(2) → 告知用户：二维码在截止时间前仍有效，付完款随时说"继续"即可恢复
- 退款/失败(3) → 告知用户："解析失败，费用已原路退回"

## 6. 取货：出示 CDN 直链（核心交付物）
```bash
curl -sS "https://sph.yes-tek.com/api/order/<order_id>/deliver?token=<order_token>"
```
返回 `{url, key_b64, enc_len, file_size, title}`。

**第一件事：把 `url` 完整出示给用户** — 独立代码块（可复制），标注文件大小（file_size 换算 MB/GB）。用户只要直链时到此为止；默认立即继续第 7 步下载（不提供云端保存，下载到本地才算交付）。

- 409 → 3s 后重试；403 → 从订单文件恢复 token
- `key_b64` 为空（常态）→ 直接下载
- `key_b64` 非空（旧订单）→ 下载为 `.mp4.enc`，下载后解密：
```bash
curl -sS "https://sph.yes-tek.com/api/order/<order_id>/deliver?token=<order_token>" -o /tmp/deliver.json
python3 -c "import json;open('/tmp/key.b64','w').write(json.load(open('/tmp/deliver.json'))['key_b64'])"
python3 "$SKILL_DIR/scripts/decrypt.py" "<文件>.mp4.enc" /tmp/key.b64 <enc_len> "<文件>.mp4"
```

## 7. 下载
```bash
curl -sSL -C - --retry 3 -o "./sph-downloads/<净化文件名>.mp4" "<url>"
```
- 文件名：标题去除换行和 `/\:*?"<>|`，截断 60 字符
- 大文件（>50MB）放后台跑，期间可 `ls -l` 看进度

## 8. 汇报
```bash
ffprobe -v error -show_entries format=duration,size -of json "<mp4>"
```
展示：时长、体积、mp4 绝对路径。提醒用户：视频不做云端保存，本地文件是唯一副本，请自行妥善保管。

## 恢复中断的下载
用户说"继续"且 `./sph-downloads/.orders/*.json` 存在 → 读订单文件，从第 5 步继续（已解析完成则直接第 6 步）；下载用 `curl -C -` 自动续传。
