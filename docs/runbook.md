# Runbook

## 部署方式一：Docker（推荐）

```bash
# 1. 配置
cp deploy/sph.env.example deploy/sph.env && vi deploy/sph.env   # 填微信商户参数，MOCK_PAY=0
mkdir -p certs && cp /path/to/apiclient_key.pem certs/          # 商户 API 私钥

# 2. 构建并启动（默认国内源加速；海外构建 --build-arg USE_CN_MIRROR=0）
docker compose up -d --build
docker compose logs -f            # 看到 [browserPool] ready 即就绪

# 3. 验证
curl localhost:8787/healthz
```

要点：
- **数据卷 sph-data** 挂 `/app/data`（sqlite 订单库含下载密钥，备份它）；`certs/` 只读挂载私钥
- `mem_limit: 2g` / `shm_size: 1g` / `init: true`（chromium 僵尸进程回收），按机器规格在 compose 里调
- 镜像内 chromium 由 `npx playwright install --with-deps` 安装，与 npm 包版本**精确匹配**（勿单独升级 playwright 小版本而不重建镜像）
- 本地联调：`docker compose up -d` 前把 `deploy/sph.env` 的 `MOCK_PAY` 设 1，用 `/api/dev/mock-pay/<order_id>` 模拟支付
- 公网 TLS：要么宿主机 nginx（见下），要么 `docker compose --profile tls up -d`（配置 `deploy/tls/nginx.conf` + 证书）——微信回调 `WX_NOTIFY_URL` 必须是公网 HTTPS
- 升级：`git pull && docker compose up -d --build`（订单数据在卷里不丢）
- HEADED 兜底：`deploy/sph.env` 加 `HEADED=1`，并把 compose 的 command 改为 `xvfb-run -a node src/index.js`（镜像已内置 xvfb）

## 部署方式二：systemd 裸机

```bash
# 1. 系统依赖（chromium 运行库）
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2t64 libpango-1.0-0 libcairo2 xvfb   # xvfb 为 HEADED 兜底

# 2. 代码与依赖
sudo mkdir -p /opt/sph && sudo chown $USER /opt/sph
rsync -a --exclude node_modules --exclude data ./ server/ /opt/sph/server/
cd /opt/sph/server && npm i --registry=https://registry.npmmirror.com
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
  ./node_modules/.bin/playwright install chromium

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

**NTP 必装**（时间漂移 >5min 微信验签必败）：`sudo apt install chrony && sudo systemctl enable --now chrony`

## 日常检查

```bash
systemctl status sph-server
tail -f /var/log/sph/server.err.log          # [browserPool]/[resolve]/[notify] 日志
sqlite3 /opt/sph/server/data/orders.db \
  "SELECT status, COUNT(*) FROM orders GROUP BY status; SELECT id, refund_status FROM orders WHERE refund_status='retry';"
```

## 故障处置

### sph 站改版（SphChangedError）
现象：`[resolve] ... sph 站响应结构变化`。
处置顺序：
1. `curl 'https://sph.miuistore.com/' | grep -o 'enc.js?v=[0-9]*'` 看版本是否变化
2. 浏览器手动走一遍下载，DevTools 看 `/sph/public/quick` 的新参数/响应结构
3. 改 `src/sph/quickClient.js`（schema 校验集中在此）、必要时 `src/sph/normalize.js`、`src/sph/signer.js`（page.evaluate 里的签名调用）
4. 期间订单会走 3 次重试 → 自动退款，用户不受损

### sign 持续为空（headless 被检测）
`/etc/sph.env` 加 `HEADED=1`，ExecStart 改 `xvfb-run -a /usr/bin/node src/index.js`。

### 手动退款
```bash
source /etc/sph.env
curl -X POST "http://localhost:8787/api/admin/refund/$ORDER_ID" -H "X-Admin-Token: $ADMIN_TOKEN"
```
（管理接口，进阶实现；临时可用微信商户平台网站按 out_trade_no 手动退）

### 卡单（paid/resolving 超 10min）
sweeper 每分钟自动重试；仍卡住看 server.err.log 里 browserPool 是否 degraded，必要时 `systemctl restart sph-server`（解析进度在 DB，重启不丢）。

## 风险提示
- 依赖 sph.miuistore.com 是单点：它改版/封 IP 本服务即失效（表现为 SphChangedError/SignError）
- 商户号挂"视频下载"虚拟服务有类目合规风险，保留侵权投诉通道（参照 sph 站页脚做法）
- 微信平台证书由 SDK 自动轮换，勿硬编码进代码
