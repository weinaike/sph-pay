# 达人检索与批量下载（钱包 / 额度模式）

> 触发场景：用户要「找某个达人/博主」「下载 TA 的视频」「批量下载多条」「某达人全部作品」。
> 单视频 + 钱包有额度也可以走 `/api/resolve` 免支付通道（见文末）。
> 本模式所有额度类调用都带 `X-User-Token`（`wallet.py ensure` 取）。

## 0. 钱包（匿名账户）

```bash
python3 "$SKILL_DIR/scripts/wallet.py" ensure   # 首次匿名开户；token 落 ~/.config/sph/user_token (0600)
python3 "$SKILL_DIR/scripts/wallet.py" me       # 余额：link_quota(直链条数) / search_credits(百条机会) / 已购
```

- token **全局唯一**（跟人不跟项目目录），开户后**必提醒用户备份 `~/.config/sph/user_token`**——匿名凭证，丢失即丢余额。
- 两种余额**永久有效**；计费语义：
  | 动作 | 消耗 | 免扣情形 |
  |---|---|---|
  | 短链→直链（每条） | 1 条直链额度 | 同一条短链 24h 内重复转换 |
  | 达人前 100 条作品列表 | 1 次百条机会 | 同达人 24h 内重复拉取；达人总数 ≤10 免费 |
  | 达人检索 Top10 / 每达人前 10 条 | 免费 | 不限次（限频） |

## 1. 达人检索（免费）

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/finder/search" \
  -H 'content-type: application/json' -d '{"keyword":"<昵称关键词>"}'
```

→ `{items:[{username, nickname, avatar, signature}]}`（Top10）。**username（v2_xxx@finder）是后续所有操作的身份**，渲染成表格让用户选。503 `finder_unavailable` = 检索通道暂不可用（隔夜易掉线，稍后重试）。

## 2. 作品列表（免费 10 条 / 百条扣机会）

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/finder/videos" \
  -H 'content-type: application/json' -d '{"username":"<达人 username>"}'
# 百条（需钱包；扣 1 次百条机会，同达人 24h 免重扣）：
curl -sS -X POST "https://sph.yes-tek.com/api/finder/videos" \
  -H 'content-type: application/json' -H "x-user-token: <token>" \
  -d '{"username":"<达人 username>","full":true}'
```

→ `{items:[{object_id,title,share_url,created_at,duration,width,height,size}], total, charged, ...}`

- 默认前 10 条**免费不限次**——先展示这 10 条再问要不要百条，不要上来就 full。
- full 首次较慢（服务端翻页+生成短链，约 10~60s），**必须先告知将消耗 1 次百条机会（余额 `wallet.py me`）**，确认后再发。
- 402 `no_search_credits` → 百条机会不足，引导购 B/C（第 5 节）；`total ≤ 100` 时列表就是全部作品。

## 3. 批量转直链（服务端批处理 · POST /api/resolve/batch）

用户选定要下载的条目后，把 `share_url` 数组一次提交（≤100 条，自动去重；**任一非短链整批 400，提交前自查一遍**）：

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/resolve/batch" -H 'content-type: application/json' \
  -H "x-user-token: <token>" \
  -d '{"urls":["<短链1>","<短链2>",...]}'          # → {batch_id, total, ...}
python3 "$SKILL_DIR/scripts/poll.py" --batch <batch_id>   # 轮询到 done，结果落 ./sph-downloads/batch-<batch_id>.json
```

- **动手前先报余额**（要转 N 条 ≥ N 条直链额度）。
- 服务端逐条扣额度、**单条失败自动返还并继续**、额度不足余条 `skipped`；进程重启自动续跑（已扣费不重扣）。
- 轮询超时（30min）不是失败：同命令重查即可续取进度。
- 会话过长可分批：每批 ≤100 条，批与批之间独立计费（同短链 24h 免重扣兜底重复）。

## 4. 下载与交付

结果文件 `./sph-downloads/batch-<id>.json` 里 `items[].cdn_url`（仅 resolved 条目）逐条下载（**直链不进对话，本地文件才是交付物**）：

```bash
curl -sSL -C - --retry 3 -o "./sph-downloads/<净化标题>.mp4" "<cdn_url>"
```

- 逐条时长/体积/分辨率就在结果文件里（`duration_s`/`file_size`/`width`/`height`，可能 null 需兜底），汇报不需要 ffprobe。
- 量大放后台跑、逐条汇报绝对路径；中断用 `curl -C -` 续传。

## 5. 额度不足 → 购买套餐（402 应对）

价目、各档额度与权益**只有一个事实源**，报价前先取数：

```bash
curl -sS https://sph.yes-tek.com/api/package    # → {price_cents, notice, packages:{A:{amount_cents,link_quota,search_credits},...}}
```

报价都用这份输出，**不凭记忆写价格**；档位按**待转条数**取最小满足档（≈10 条→A；≈100 条→B；更多→C）。条款与权益说明支付页自带，对话侧不复述。

```bash
python3 "$SKILL_DIR/scripts/wallet.py" buy B > ./package_order.json   # → {order_id, order_token, page_url, expire_at, granted, notice}
```

**支付页 = 响应里的 `page_url`**（套餐订单自己的页面，绝不复用单视频订单的支付页；原单视频订单不付自动过期，无需处理）。把链接给用户——手机微信内打开可**点按直接支付**，电脑打开扫码；对话侧只留 3 行（¥X · 剩余时间 · 打开链接支付）。然后：

```bash
python3 "$SKILL_DIR/scripts/poll.py" --order <order_id> --token <order_token> --terminal credited
python3 "$SKILL_DIR/scripts/wallet.py" me                           # 确认到账后继续批量
```

## 7. 用户粘来「钱包码」（在支付页直购了套餐）

用户会粘来一串 64 位十六进制**钱包码**（权益落在页面钱包）。先 `wallet.py me` 查本地钱包：

- 本地无钱包或余额为 0 → 直接写入并验证：

```bash
mkdir -p ~/.config/sph && printf '%s' "<钱包码>" > ~/.config/sph/user_token
python3 "$SKILL_DIR/scripts/wallet.py" me                           # 确认余额到账再继续
```

- 本地钱包已有余额 → **不要直接覆盖**：两个钱包相互独立。把旧码报给用户备份，由用户决定切换还是继续用本地余额。

## 6. 单视频 + 有额度：免支付直取

钱包存在且 `link_quota > 0` 时，单条视频不必走按次付费的订单流（SKILL.md 第 3~5 步），直接：

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/resolve" \
  -H 'content-type: application/json' -H "x-user-token: <token>" -d '{"url":"<短链>"}'
```

→ `{url, file_size, title, author, duration_s, width, height, charged}`（扣 1 条额度；同短链 24h 内 `charged:false` 免重扣；解析失败 503 自动返还）。拿到 url 后下载与汇报同 SKILL.md 第 6/7 步；响应自带 `author` 达人昵称（空串兜底），用户要同达人更多作品时走本文件第 1~4 节。无钱包/无额度 → 走原订单流（SKILL.md 第 3~5 步）。
