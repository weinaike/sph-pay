# 达人检索与批量下载（钱包 / 额度模式）

> 触发场景：用户要「找某个达人/博主」「下载 TA 的视频」「批量下载多条」「某达人全部作品」。
> 单视频 + 钱包有额度也可以走 `/api/resolve` 免支付通道（见文末）。
> 本模式所有额度类调用都带 `X-User-Token`（`wallet.py ensure` 取）。

## 0. 钱包（匿名账户）

```bash
"$PY" "$SKILL_DIR/scripts/wallet.py" ensure   # 首次匿名开户；token 落 ~/.config/sph/user_token (0600)
"$PY" "$SKILL_DIR/scripts/wallet.py" me       # 余额：link_quota(直链条数) / search_credits(百条机会) / 已购
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

- 默认返回前 10 条（含 `share_url` 短链），**免费不限次**——先展示这 10 条再问要不要百条，不要上来就 full。
- full 首次较慢（服务端翻页+生成短链，约 10~60s），**必须先告知用户将消耗 1 次百条机会（余额 `wallet.py me`）**，确认后再发。
- 402 `no_search_credits` → 百条机会不足，引导购 B/C（见第 4 节）；`total ≤ 100` 时列表就是全部作品。

## 3. 批量转直链（batch_resolve.py）

用户选定要下载的条目后，把 `share_url` 写入文件（每行一条），交给脚本：

```bash
printf '%s\n' <短链1> <短链2> ... > ./sph-downloads/urls.txt
"$PY" "$SKILL_DIR/scripts/batch_resolve.py" ./sph-downloads/urls.txt
# 中断续跑：--skip <上次结果文件>（脚本最后会打印路径）
```

- 逐条扣直链额度；**单条解析失败自动返还该条额度并继续**；402 中断并汇报（退出码 2）。
- 结果文件含每条 `{url, title, file_size}`——**下载动作**逐条 `curl -sSL -C - --retry 3 -o "./sph-downloads/<净化标题>.mp4" "<url>"`（同 SKILL.md 第 5 步规则；直链不进对话，本地文件才是交付物）。量大会话过长时，可用结果文件分批处理。

## 4. 额度不足与套餐购买（402 应对）

价目、各档额度与权益**只有一个事实源**，报价前先取数：

```bash
"$PY" "$SKILL_DIR/scripts/render_order.py" --dump-packages   # JSON：mp_name + packages（价格/单条折算/权益条目）
```

向用户报价、推荐、写套餐卡都用这份输出，**不凭记忆写价格**。推荐档位按**待转条数**取最小满足档（额度 ≈10 条→A；≈100 条→B；更多/常用→C）。

**购买前必达三条**（引导付费时明确告知）：**虚拟权益支付后即时到账 · 售出不退 · 余额永久有效**。

```bash
"$PY" "$SKILL_DIR/scripts/wallet.py" buy B                       # → {order_id, order_token, code_url, ...}
"$PY" "$SKILL_DIR/scripts/qr.py" "<code_url>" --invert    # B 轨·纯终端；有桌面则渲套餐页（SKILL.md 第 9 节第 5 步）
"$PY" "$SKILL_DIR/scripts/poll.py" --order <order_id> --token <order_token> --terminal credited
"$PY" "$SKILL_DIR/scripts/wallet.py" me                           # 确认到账后继续批量
```

不想付费的免费口径：单条视频 → 小程序《越思工具》免费下载（同 SKILL.md 第 7 节）；达人前 10 条短链本身免费。

## 5. 单视频 + 有额度：免支付直取

钱包存在且 `link_quota > 0` 时，单条视频不必走按次付费的订单流（SKILL.md 第 2~4 步），直接：

```bash
curl -sS -X POST "https://sph.yes-tek.com/api/resolve" \
  -H 'content-type: application/json' -H "x-user-token: <token>" -d '{"url":"<短链>"}'
```

→ `{url, file_size, title, author, charged}`（扣 1 条额度；同短链 24h 内 `charged:false` 免重扣；解析失败 503 自动返还）。拿到 url 后下载与汇报同第 5/6 步，交付后追问同达人其他作品见 SKILL.md 6.5 节（响应自带 `author` 达人昵称，空串才问用户）。无钱包/无额度 → 走原订单流。
