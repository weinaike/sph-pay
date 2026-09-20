# 实施计划：双渠道差异化定价（小程序免费+广告 / skill 资源包计费）

> 2026-09-20 制定。基于已确认的付费模型（含 QA 结论），目标是在现有 sph-pay（单视频按单付费）之上增量演进，不破坏存量订单流程。

## 0. 计费模型定格（QA 结论固化）

### 计量单位（两种余额，互相独立）

| 余额 | 获取途径 | 消耗场景 | 失败处理 |
|---|---|---|---|
| **直链额度**（条） | 购资源包 A/B/C | 每条短链→直链转换扣 1；**同 token 同短链 24h 内免重扣**（记短链指纹+时间，不存直链，命中则免费重解析） | 解析失败自动返还 1 条 |
| **百条检索机会**（次） | 购资源包 B/C 赠送 | 拉取某达人前 100 条作品扣 1；**同一用户同一达人 24h 缓存代内只扣 1 次**（隔天缓存刷新、数据更新后重新计费）；**达人作品总数 ≤10 时自动免扣** | 交付 <10 条全额返还；≥10 条交付不返还 |

> 两种余额均**永久有效**（无过期字段）。套餐**售出不退**（虚拟权益即时入账），skill 购买前明示。

### 资源包定价

| 包 | 价格 | 直链额度 | 百条检索机会 |
|---|---|---|---|
| A | ¥5 | 10 | 0 |
| B | ¥30 | 100 | 10 |
| C | ¥50 | 200 | 20 |

### 各能力计费语义（skill 渠道）

| 能力 | 免费额度 | 付费方式 |
|---|---|---|
| 达人检索（Top10） | 不限次（限频） | 无付费版 |
| 达人作品短链列表 | 每达人前 10 条，不限次重复获取（限频） | 前 100 条需消耗 1 次百条检索机会 |
| 短链→直链（批量/单条） | 无免费额度 | 扣直链额度 1 条/次；无额度时可单条 ¥1 按单付费，或引导小程序免费下载 |
| 单视频按次 | — | ¥1/条（现有订单流程保留，匿名可用） |

### 小程序渠道

- 仅**单链转换**（不支持达人检索/达人视频列表——skill 专属）；直链免费，变现靠广告（小程序端流量主组件，不在本计划范围）
- **走 sph.yes-tek.com 已有 sph-api 解析 API（`/api/scraper/fetch` + `/api/scraper/job`）**：job 结果自带标题/作者/封面 + 明文直链，预览与直链一体，sph-pay **不新增任何小程序端点**
- 访问限制：**5 次/min/IP**，落在 nginx 层（fetch 现 10r/m 调至 5r/m；ban-sph.sh 429≥15/10min 自动封禁继续兜底）
- sph-pay 现有 `/api/auth/login`、`/api/security/*` 保留（小程序合规检测用，不动）

### 账户模型

- 匿名 `user_token`（32 字节随机 hex），首次调用 `POST /api/user` 颁发
- 直链额度 / 百条机会 / 已购记录全部挂 token；**token 丢失=余额丢失**（匿名卡模式，接受；skill 负责落盘保管；后续可扩展绑定微信 openid 找回）
- 直链结果**不落库存储**（CDN 直链约 1 天时效，存了没意义）——只有消费台账（谁在何时对哪条短链扣了额度）

---

## 1. 数据模型（server/db.js 迁移）

```sql
-- 新增：匿名账户（余额挂靠点）
CREATE TABLE IF NOT EXISTS users (
  user_token      TEXT PRIMARY KEY,
  link_quota      INTEGER NOT NULL DEFAULT 0,   -- 直链额度余额（条）
  search_credits  INTEGER NOT NULL DEFAULT 0,   -- 百条检索机会余额（次）
  total_paid_cents INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER
);

-- 新增：消费台账（审计/对账/防刷分析；不含直链内容）
CREATE TABLE IF NOT EXISTS usage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_token TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- resolve | search100
  target     TEXT,                 -- share_url 或 finder username
  order_id   TEXT,                 -- 来源套餐订单（可空）
  refunded   INTEGER NOT NULL DEFAULT 0,  -- resolve 失败返还标记
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_token, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_dedup ON usage_log(kind, target, user_token, created_at);

-- 新增：达人作品列表缓存（sqlite 落盘而非内存——重启不换"缓存代"，扣费去重才稳定）
CREATE TABLE IF NOT EXISTS finder_cache (
  username   TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,          -- 前 100 条归一化结果
  total      INTEGER NOT NULL,       -- 达人作品总数（feedsCount）
  fetched_at INTEGER NOT NULL        -- 缓存代起点；TTL 24h，隔天自动重拉刷新数据
);
```

**扣费去重两条规则（均查 usage_log，防重扣）**：
- `resolve` 去重：存在 `kind='resolve' AND target=<share_url> AND user_token=? AND refunded=0 AND created_at >= now-24h` → 免重扣，照常重新 resolveOnce 下发新直链（成本=一次解析，不存直链）
- `search100` 去重：存在 `kind='search100' AND target=<username> AND user_token=? AND created_at >= finder_cache.fetched_at` → 命中当前缓存代，直接回缓存数据不扣费；缓存刷新（新 fetched_at）后自然重新计费
- **总数 ≤10 自动免扣**：百条请求先看 `finder_cache.total`（或首拉后回填），≤10 时不扣/已扣即返还——与免费档等价的东西不收钱

**orders 表扩展（不建新表）**：`ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'`，`ADD COLUMN package TEXT`。
- 套餐订单复用 orders 全套生命周期：微信下单/回调验签/sweeper 对账/15min 过期关单一套代码通吃，`content_id` 存哨兵值 `'package:A'` 等、`share_url` 为 NULL
- **幂等入账**：新增 `orders.markPaid()` 的包装 `markPaidAndApply(id, txnId)`——`UPDATE ... WHERE status='pending'` 抢到变更权后，在同一 better-sqlite3 事务里按 kind 分支：
  - `kind='video'` → 维持现状（触发 resolve）
  - `kind='package'` → `users` 余额累加 + `usage_log` 记购买来源 + total_paid_cents 累加
- 回调 handler 与 sweeper 两处都改调这一个函数，双路径天然幂等（status 守卫）
- `resolve()` 与 sweeper 的解析重试入口加 `kind='video'` 守卫，套餐订单永不进解析/退款链路

**原子扣减**（余额守卫，杜绝并发超扣）：

```sql
UPDATE users SET link_quota = link_quota - 1, last_seen_at = ?
WHERE user_token = ? AND link_quota > 0   -- changes==1 才算扣成功
```
返还即对称 `+1` 并置 `usage_log.refunded=1`。

## 2. 配置（config.js + deploy/sph.env）

```js
packages: {   // 常量即可，env 覆盖为可选增强
  A: { cents: 500,  linkQuota: 10,  searchCredits: 0  },
  B: { cents: 3000, linkQuota: 100, searchCredits: 10 },
  C: { cents: 5000, linkQuota: 200, searchCredits: 20 },
},
priceCents: 100,                       // 单视频 ¥1/条（现默认 199 → 改 100）
finder: { base: process.env.FINDER_BASE || 'http://host.docker.internal:2027',
          timeoutMs: 10_000, shareConcurrency: 5 },
```

`sph.env` 增加 `FINDER_BASE=http://host.docker.internal:2027`（容器到宿主 wx-webtop-old，与 `SPH_BASE` 同模式）。

## 3. finderClient（新增 server/src/finder/client.js）

照 `sph/resolverClient.js` 的隔离层模式封装 webtop 三接口（2026-09-20 已实测存活）：

| 上游 | 接口 | 用途 |
|---|---|---|
| 达人检索 | `GET :2027/api/channels/contact/search?keyword=` | Top10 免费检索 |
| 作品列表 | `GET :2027/api/channels/contact/feed/list?username=&last_buffer=` | 15 条/页，翻页凑 100 |
| 短链生成 | `GET :2027/api/channels/feed/share_url?oid=` | object_id → `weixin.qq.com/sph/xxx` |

- 错误分类：超时/5xx → `FinderTransientError`（上游重试 1 次）；微信掉线特征（Ret!=0 / 空列表 / 超时持续）→ 统一 503 `finder_unavailable`（runbook 已有四层探活处置）
- **缓存落 sqlite（finder_cache 表）**：达人→前 100 条列表 TTL 24h（**隔天自动重拉刷新数据**）；keyword→搜索结果仍走内存 TTL 10min。缓存全局共享（省上游成本），**扣费按用户按缓存代去重**：同一用户同一达人 24h 内重复拉只扣 1 次，换了用户/隔了天则正常计费
- **交付物按既定选型**：逐条 share_url → 复用 resolveService 走明文直链（feed_list 自带的 url+decodeKey 是加密流，不用）；share_url 生成失败的条目返回 `object_id` + `share_url: null` 并计入条数（与部分失败阈值口径一致）

## 4. 新路由（全部挂 /api，走现有 express.json 中间件）

鉴权约定：`X-User-Token` 请求头（skill 落盘保管）。小程序不走 sph-pay 任何端点（直连 sph-api，见 §0）。

| 方法+路径 | 鉴权 | 限频 | 语义 |
|---|---|---|---|
| `POST /api/user` | 无 | 10/min/IP | 颁发匿名 user_token（幂等创建） |
| `GET /api/user/me` | X-User-Token | 60/min | `{link_quota, search_credits, total_paid_cents, purchases:[...已购套餐]}` |
| `POST /api/package` | X-User-Token | 5/min/IP | `{package:'A'/'B'/'C'}` → 套餐订单 `{order_id, order_token, code_url, amount_cents, expire_at}`（复用 createNativeOrder，15min 过期同规格） |
| `GET /api/order/:id/status` | order_token | 沿用 | 套餐订单新增终态 `credited`（paid→credited 秒级），message 文案适配 |
| `POST /api/finder/search` | 无 | 10/min/IP | `{keyword}` → Top10 `{username, nickname, avatar, signature}` |
| `POST /api/finder/videos` | full 时需 token | 免费 6/min/IP；full 3/min/token | `{username}` → 前 10 条 `{title, share_url, object_id, created_at, duration, size}`；`{username, full:true}` → 命中当前缓存代已扣过则免扣直回，否则原子扣 1 次百条机会（不足→402 `no_search_credits`）；总数 ≤10 自动免扣；翻页凑 100 条 + 并发(5)生成 share_url；交付 <10 条全额返还 |
| `POST /api/resolve` | X-User-Token | 15/min/IP + 10/min/token（M4 实测调整：IP 限频低于 token 限频会让合法批量第 6 条起必吃 429，故 IP 放宽到 15，token 10 为批量节拍） | `{url}` → 短链归一化 → **24h 内同短链已扣过则免重扣** → 原子扣 1 直链额度（不足→402 `no_link_quota`，message 引导三选项）→ resolveOnce → `{url, file_size, title}`；**解析/HEAD 失败自动返还额度**，503 语义与现有预检一致 |
- `/api/resolve` 与现有 `POST /api/order`（¥1 单视频）**并存**：skill 先试额度路径，402 时展示「购套餐 / 单条 ¥1 / 去小程序免费下」三选项
- 套餐订单**无退款通路**（虚拟权益即时入账；SKILL.md 注明），sweeper 退款重试循环天然不触及（kind 守卫）
- 白名单序列化原则延续：新路由响应显式 zod schema；sph-pay 面上直链只出现在 `/api/resolve` 与 `/api/order/:id/deliver` 两处（小程序的免费直链走 sph-api 通道，不在 sph-pay 面）

## 5. skill 改版（SKILL.md + references/api.md）

- **token bootstrap**：钱包身份存**全局** `~/.config/sph/user_token`（跟人不跟项目目录；订单文件仍留 `./sph-downloads/.orders/`）。首次使用检查该文件，无则 `POST /api/user` 落盘；所有额度类调用带 `X-User-Token`；提示用户这是余额凭证、丢失无法找回
- **新增工作流**：
  1. 达人检索：search → 表格展示 Top10 → 用户选达人
  2. 作品列表：默认免费 10 条；主动询问「是否拉取前 100 条（消耗 1 次百条机会，余额 N）」
  3. 批量转直链：循环 `/api/resolve`，余额不足时中断并给出套餐建议（按待转条数推荐 A/B/C：≤10 推 A，≤100 推 B，>100 或多次使用推 C）
  4. 套餐购买：`POST /api/package` → **购买前醒目提示「虚拟权益，即时到账，售出不退」** → 渲染支付码（复用 qr.py）→ 轮询 credited → 刷新余额继续；同时明示余额永久有效
- **单视频场景话术**：有额度走 `/api/resolve`；无额度先建议「小程序搜索 XX 小程序免费下载」，用户坚持终端操作再 ¥1 下单
- api.md 补齐上述 8 个端点契约（含 402 语义）

## 6. 部署与运维

1. `deploy/sph.env`：`PRICE_CENTS=100`、`FINDER_BASE=http://host.docker.internal:2027`
2. **nginx gost.conf sph vhost 白名单放行**（deploy 仓库，deploy-server.sh 流程）：`/api/user`、`/api/user/me`、`/api/package`、`/api/finder/` 前缀、`/api/resolve`（`/api/auth/login` 与 `/api/security/` 2026-09-18 已放行）；其余仍 403。⚠️ 新端点在 nginx 层**不加限流**（现有限流只挂在 `/api/order` POST 和 `/api/scraper/fetch`）——skill 客户端批量调用走应用层限频即可，nginx 再叠一层会造成 skill 端不可控 429
3. **nginx 限流调整（小程序/网站页公网通道，与 sph-pay 无关）**：sph-pay 双上游走内网直连（`SPH_BASE=:2022`、`FINDER_BASE=:2027`），不过 nginx、不受任何公网限流影响。本项仅对齐小程序渠道规格「5 次/min/IP」：`/api/scraper/fetch` 单 IP 10r/m → 5r/m（网站下载页共用此入口同享）。属小程序侧配置，可与 sph-pay 上线解耦执行；ban-sph.sh 计数口径不变
4. ban-sph.sh 计数口径确认：新路径 429 不计入封禁（同 `/api/order` 现状理由）
5. runbook 增补：webtop 探活（已有）、`/api/finder/*` 与 `/api/resolve` 的 503 降级语义、套餐入账对账 SQL（usage_log vs orders）
6. 重建 sph-server 容器（db 迁移自动跑，存量 orders 默认 kind='video' 兼容）

## 7. 测试

- **单测**（server/test/unit/，cwd 敏感）：
  - 套餐配置与入账：双次 markPaid 只入账一次（幂等）
  - 额度原子性：循环并发扣减到 0 不负值（better-sqlite3 同步事务可确定性验证）
  - resolve 失败返还（SPH_BASE 指向死端口）、百条部分失败阈值（<10 条交付返还、≥10 不返还）
  - **扣费去重**：24h 内同短链重转免扣、同缓存代百条重拉免扣、隔天（新缓存代）重新计费、达人总数 ≤10 自动免扣
  - finder 响应归一化/截断/缓存命中（finder_cache 代际跨重启稳定）、限频键（IP/token 分桶）
- **MOCK_PAY 闭环**：`POST /api/user` → 购 B → mock-pay → me 见 100/10 → videos full 扣 1 → resolve 扣 1 → 失败返还 1
- **手工探活**：新增 `test/manual-finder.js '<关键词>'`（search→选首条→列表→share_url 抽查），与 manual-resolve.js 并列

## 8. 里程碑（可独立交付的顺序）

| # | 内容 | 估时 | 验收 |
|---|---|---|---|
| M1 | 计费底座：users 表/套餐订单复用 orders/入账幂等/`/api/user*` + `/api/package`/sweeper 分支 + MOCK 闭环 + 单测 | 1 天 | ✅ 2026-09-20 完成：MOCK_PAY 买 B → 余额 100/10、重复落账幂等、deliver/鉴权守卫、单测 28/28 |
| M2 | finder 能力：finderClient + `/api/finder/search\|videos`（缓存/限频/百条扣费） | 1 天 | ✅ 2026-09-20 完成：真实关键词全链路（检索 Top10 → 免费 10 条带短链 → 购 B → 百条 100/100 短链 9.3s → 同代免扣秒回）；上游实测两坑已修：**续页 feedsCount=0**（只信 >0）、**20 位数字 id 超精度**（json-bigint 无损解析） |
| M3 | 额度直链：`/api/resolve`（扣减/失败返还/402） | 0.25 天（并入 M2 尾） | ✅ 2026-09-20 完成：真实短链扣 1 条出明文直链、同短链 24h 免重扣、死通道 503+额度返还、零额度 402 三选项引导；单测 46/46 |
| M4 | skill 改版：SKILL.md/api.md/token/购买/推荐话术 | 0.5 天 | ✅ 2026-09-20 完成（对准重构后的 `skill/sph-video-wechat-channels-downloader/`）：wallet.py（ensure/me/buy + `~/.config/sph/user_token` 0600）、batch_resolve.py（断点续跑/失败返还继续/402 中断+套餐推荐）、poll.py `--terminal credited`、SKILL.md 第 9 节 + 单视频额度旁路、references/finder.md + api.md 全契约；脚本级真实验证全过 |
| M5 | 上线：env/nginx 白名单 + fetch 限流 5r/m/runbook/PRICE_CENTS=100 + 真实支付购包验证（小程序零服务端改动，nginx 调完即可联调） | 0.5 天 | ✅ 2026-09-20 完成：DB 备份→sph.env（¥1+FINDER_BASE）→容器重建迁移（存量 8 单 kind=video）→nginx 白名单（新端点零 nginx 限流）→**真实支付购 C ¥50 → credited → 200/20 → 真实消费 百条+直链 → 199/19**；视频订单回归 ¥1 ✓；fetch 限流调整按 §6.3 与 sph-pay 解耦未执行 |

M1–M3 是服务端一条主线；M4 可与服务端并行；M5 收口。小程序不需要 sph-pay 侧里程碑（直连 sph-api）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| webtop 脆弱（重启需扫码、引擎静默死、服务端限流史） | 503 `finder_unavailable` 明确语义 + 缓存削峰 + runbook 四层探活；单视频主链路（sph-api）不受影响 |
| 百条拉取慢（7 页列表 + 100 次 share_url） | 并发 5 + 总超时 60s；超时部分成功（≥10 条交付不返还，<10 返还），响应带 `truncated` 标记 |
| 匿名 token 丢失即余额丢失 | skill 落盘 `.user_token.json`；SKILL.md 提示备份；后续可扩展绑定 openid |
| 免费端点被脚本薅（search/videos-top10；小程序直连的 sph-api fetch） | sph-pay 侧 IP+token 双维限频、finder_cache 缓存；sph-api 侧沿用 nginx 限频（fetch 5r/m）+ ban-sph.sh 行为面封禁 |
| 套餐类目合规 | 虚拟权益售出不退换需明示；沿用"个人学习备份"话术与投诉通道 |
| 小程序侧技术边界（前端课题，不影响本计划） | `sph.yes-tek.com` 需加入小程序 request 合法域名；**CDN 直链（finder.video.qq.com）非自有域名、加不进 downloadFile 白名单** → 小程序内直接落盘不可行，需「复制直链/浏览器打开」交付或服务器中转（中转有带宽成本，慎选） |
| 直链额度被并发刷（单 token 多请求） | 原子 UPDATE 守卫天然防超扣；限频 10/min/token；usage_log 可事后审计异常 |

## 10. 已确认的决策清单（2026-09-20 与产品对齐）

1. 套包订单**复用 orders 表**（kind 列）而非新表——微信支付生命周期零重复代码
2. 免费档无任何每用户状态（不记"谁看过哪些达人"），纯限频控制
3. **百条缓存全局共享省上游成本，扣费按用户按缓存代去重**：同一用户同一达人 24h 内重复拉只扣 1 次；隔天缓存刷新（数据更新）后重新计费
4. **同 token 同短链 24h 内重转直链免重扣**（记短链指纹+时间，不存直链，命中免费重解析）
5. **余额永久有效**；套餐**售出不退**，skill 购买前明示
6. **百条部分失败**：交付 ≥10 条不返还、<10 条全额返还
7. **达人总数 ≤10 请求百条自动免扣**（与免费档等价不收钱）
8. user_token 存**全局** `~/.config/sph/`（钱包跟人不跟项目目录）
9. 单视频 ¥1 保留匿名按单流程，不强制注册账户
10. 小程序**只做单链转换、不做达人功能**，且**直连 sph-api 解析 API**（`/api/scraper/fetch`+`/job`，结果自带预览元数据+直链）；sph-pay **零新增小程序端点**，仅 nginx 层把 fetch 限频调到 5r/m/IP；现有 `/api/auth/login`、`/api/security/*` 保留不动（小程序合规用）
11. 百条 = 前 100 条整（作品 >100 的达人也只给前 100；更深档位未来再说，schema 不受影响）
12. 免费档 10 条同样吃 finder_cache 第一页（缓存对免费/付费一视同仁）
