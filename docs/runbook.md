# Runbook

## 部署方式一：Docker（推荐）

```bash
# 1. 配置
cp deploy/sph.env.example deploy/sph.env && vi deploy/sph.env   # 填微信商户参数，MOCK_PAY=0
mkdir -p certs && cp /path/to/{apiclient_key.pem,pub_key.pem} certs/   # 商户私钥 + 微信支付公钥

# 2. 构建并启动（默认国内源加速；海外构建 --build-arg USE_CN_MIRROR=0）
docker compose up -d --build
docker compose logs -f            # healthcheck 通过即就绪

# 3. 验证
curl localhost:8787/healthz
```

要点：
- **数据卷 sph-data** 挂 `/app/data`（sqlite 订单库含下载密钥，备份它）；`certs/` 只读挂载私钥
- `mem_limit: 512m` / `init: true`（PID 1 信号转发 + 子进程回收），按机器规格在 compose 里调
- 无浏览器依赖，镜像是纯 Node 进程
- 本地联调：`docker compose up -d` 前把 `deploy/sph.env` 的 `MOCK_PAY` 设 1，用 `/api/dev/mock-pay/<order_id>` 模拟支付
- 公网 TLS：要么宿主机 nginx（见下），要么 `docker compose --profile tls up -d`（配置 `deploy/tls/nginx.conf` + 证书）——微信回调 `WX_NOTIFY_URL` 必须是公网 HTTPS
- 升级：`git pull && docker compose up -d --build`（订单数据在卷里不丢；首次升级会自动给 orders 表加 `share_url` 列并回填旧短链订单）

## 部署方式二：systemd 裸机

```bash
# 1. 系统依赖
sudo apt install -y chrony   # NTP（时间漂移 >5min 微信验签必败），其余无特殊依赖

# 2. 代码与依赖
sudo mkdir -p /opt/sph && sudo chown $USER /opt/sph
rsync -a --exclude node_modules --exclude data ./ server/ /opt/sph/server/
cd /opt/sph/server && npm i --registry=https://registry.npmmirror.com

# 3. 配置
sudo cp .env.example /etc/sph.env && sudo vi /etc/sph.env   # 填微信商户参数
sudo mkdir -p /var/log/sph && sudo chown www-data /var/log/sph
sudo mkdir -p /opt/sph/server/data && sudo chown www-data /opt/sph/server/data

# 4. systemd
sudo cp deploy/sph-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sph-server
curl localhost:8787/healthz
```

nginx 配置见 `deploy/nginx.conf.example`（回调路径勿改写 body）。

## 日常检查

```bash
systemctl status sph-server
tail -f /var/log/sph/server.err.log          # [resolve]/[notify] 日志
sqlite3 /opt/sph/server/data/orders.db \
  "SELECT status, COUNT(*) FROM orders GROUP BY status; SELECT id, refund_status FROM orders WHERE refund_status='retry';"
```

## 故障处置

### 解析服务故障（sph.yes-tek.com）
现象：`[resolve] ... 提交解析任务失败 / 解析超时 / 解析失败`。
处置顺序：
1. **隔离定位**——绕开 sph-pay 直接打解析服务：
   ```bash
   # 提交（正常应返回 code:0 + data.id）
   curl -sS -X POST https://sph.yes-tek.com/api/scraper/fetch -H 'content-type: application/json' \
     -d '{"url":"https://weixin.qq.com/sph/AzGEWrdqgP"}'
   # 轮询到 completed（data.content.url 有值即服务正常）
   curl -sS "https://sph.yes-tek.com/api/scraper/job?id=<上面的data.id>"
   ```
   - 这里就失败 → 问题在解析服务侧：登 mac-mini 看 `docker logs wx-sph-api`；最常见的根因是 `.tencent.com` cookie 过期（看 CookieCloud 浏览器插件是否还在同步、是否久未访问腾讯系站点；恢复登录后等下一次推送）
   - 这里正常但 sph-pay 报错 → 问题在 sph-pay：查 `SPH_BASE` 配置与网络出口
2. 解析服务侧 nginx（deploy 仓库 sph vhost）必须放行 `/api/scraper/fetch` 与 `/api/scraper/job`（403 即白名单被改）
3. 期间订单会走 3 次重试 → 自动退款，用户不受损

### 响应结构变化（ResolverFatalError "解析服务响应结构变化"）
解析服务（wx_channels_download）升级改了 job 响应结构。改 `src/sph/resolverClient.js` 的 `validateCompleted`（schema 校验集中在此）。

### 手动退款
```bash
source /etc/sph.env
curl -X POST "http://localhost:8787/api/admin/refund/$ORDER_ID" -H "X-Admin-Token: $ADMIN_TOKEN"
```
（管理接口，进阶实现；临时可用微信商户平台网站按 out_trade_no 手动退）

### 卡单（paid/resolving 超 10min）
sweeper 每分钟自动重试；仍卡住 `systemctl restart sph-server`（解析进度在 DB，重启不丢）。export/objectId 订单在 preview 即被拒（不创建订单）；支付前解析预检不过同样不创建订单——正常情况下不存在"解析失败退款"路径，仅剩解析服务在预检后 15min 内故障的极端窗口（3 次重试 + 自动退款兜底）。

### 回调丢失（paid 长时间不推进）
微信回调打不进来（notify URL 未部署/被墙/nginx 未放行）时不必处理：sweeper 对创建超 60s 的 pending 订单每轮主动查单，支付成功即推进 paid → 解析。若长期本地运行，可忽略微信侧重试的失败回调。

### 达人检索后端探活（wx-webtop 容器，:2027）
达人检索的上游是本机 `wx-webtop-old` 容器（微信登录态 + 视频号页面注入 WS）。四层死法，探法成本与含义不同：

| 层 | 探法 | 死了的现象 |
|---|---|---|
| 容器/进程 | `docker ps` / `pgrep` | healthcheck unhealthy、重启循环 |
| 引擎 API | HTTP GET `:2027/` | 连接拒绝/超时 |
| **注入 socket（地面真相）** | 真实 search 调用 | `{"code":400,"msg":"请先初始化客户端 socket 连接"}` |
| 微信登录态 | 同上 | 同样报 socket 错 + 桌面弹登录窗（需人工扫码） |

```bash
# L0/L1：进程与引擎——活着 ≠ 能用（最隐蔽的半死状态：引擎 200 但 socket 已死）
docker exec wx-webtop-old pgrep -c 'wx_video_download|wechat'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:2027/

# L2：注入在线性——唯一可靠探活，errCode:0 即全链路健康
curl -s -m 10 -G http://127.0.0.1:2027/api/channels/contact/search \
  --data-urlencode 'keyword=1' | head -c 120
```

处置（按最常见的死法排序）：
1. **socket 死、进程全活**（最常见，隔夜页面丢失）：开 `http://127.0.0.1:3200` 桌面 → 微信 → 重新点开「视频号」页面 → 重跑 L2 验证。注意 WeChatAppEx（webview 运行时）不随页面销毁，进程探测发现不了这种死法
2. 引擎死：`docker exec wx-webtop-old wx-start-downloader`；重启容器是最后手段（微信要重新扫码）
3. 微信死/掉线：`docker exec wx-webtop-old wx-start-wechat`——Linux 微信冷启动无自动登录，重启后基本要人工扫码
4. **探活频率纪律**：真实 search 探活 ≥10min 间隔；1min 一次的搜索本身就是风控信号，探活不能成为风险源

保活现状（2026-09）：无自动保活，页面恢复靠人工。已知根因优先级：宿主 mac-mini 睡眠（Docker VM 挂起 → 微信长连接全断，wechat.log 会留 `GetA8KeyResp` 错误痕迹）> 页面隔夜丢失 > 进程崩溃。`wx-keepalive`（xdotool 自动重开页面）落地前，隔夜后先跑 L2 再对外承诺检索可用。

## 风险提示
- 解析单点是自有服务 sph.yes-tek.com（受控），其上游依赖 `.tencent.com` cookie 新鲜度（CookieCloud 自更新链），链断裂表现为持续解析失败→自动退款
- 达人检索上游单点：wx-webtop 容器内的微信登录态（页面丢失/掉线即检索不可用，探测与处置见上节；掉线恢复需人工扫码）
- 商户号挂"视频下载"虚拟服务有类目合规风险，保留侵权投诉通道
- 微信平台证书由 SDK 自动轮换，勿硬编码进代码
