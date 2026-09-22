import express from 'express';
import fs from 'node:fs';
import { config, validateConfig } from './config.js';
import { orders, db } from './db.js';
import { orderCreateRouter } from './routes/orderCreate.js';
import { orderRouter } from './routes/order.js';
import { wxpayRouter } from './routes/wxpay.js';
import { userRouter } from './routes/user.js';
import { packageRouter } from './routes/package.js';
import { finderRouter } from './routes/finder.js';
import { resolveRouter } from './routes/resolve.js';
import { devRouter } from './routes/dev.js';
import { wxqrRouter } from './routes/wxqr.js';
import { authRouter, securityRouter } from './routes/security.js';
import { pageRouter } from './routes/page.js';
import { resolve } from './services/resolveService.js';
import { resumeInterruptedBatches } from './services/batchService.js';
import { closeOrder, queryOrder, refundOrder } from './services/wxpay.js';
import { refundNoFor } from './util/id.js';

validateConfig();

const app = express();
app.set('trust proxy', true); // nginx 后面取真实 IP
app.disable('x-powered-by');

// 微信回调路由之前必须用 raw body（JSON 解析会破坏验签）
app.use('/api/wxpay', express.raw({ type: '*/*', limit: '1mb' }), wxpayRouter);
app.use(['/api', '/p'], express.json({ limit: '64kb' })); // /p 的 POST /:id/package 页面直购也需要 JSON

app.get('/healthz', (req, res) => res.json({ ok: true, price_cents: config.priceCents }));
app.use('/api/order', orderCreateRouter, orderRouter); // POST / = 创建订单；/:id/* = 查询/取货
app.use('/api/wxqr', wxqrRouter); // GET /?t= 微信登录二维码回源（钉钉通知图；token 由 daemon 管理生命周期）
app.use('/api/user', userRouter); // POST / = 匿名开户；GET /me = 余额/已购
app.use('/api/package', packageRouter); // POST / = 购买资源包（kind='package' 订单）
app.use('/api/finder', finderRouter); // POST /search 达人检索；POST /videos 作品列表（免费10/百条扣机会）
app.use('/api/resolve', resolveRouter); // POST / = 额度直链（扣1条/24h免重扣/失败返还）；POST /batch = 批量解析
app.use('/p', pageRouter); // 托管订单页（skill 只发 page_url；同源轮询状态自推进，/:id/cover /:id/avatar 图像代理）
if (config.mockPay) app.use('/api/dev', devRouter); // 模拟支付（仅本地联调）
app.use('/api/auth', authRouter); // POST /login：wx.login code 换 skey（内容安全用）
app.use('/api/security', securityRouter); // 内容安全检测 + 微信消息推送回调

// ---- 启动恢复：上次进程中断的批量解析任务续跑（charged=1 的条目免重扣重解析） ----
const resumedBatches = resumeInterruptedBatches();
if (resumedBatches) console.log(`[batch] 启动恢复 ${resumedBatches} 个中断批次`);

// ---- sweeper：60s 一轮 ----
setInterval(async () => {
  const nowS = Date.now() / 1000;
  try {
    // 1) pending 对账：超 60s 每轮查单（回调丢失兜底，微信回调打不进来时靠这里推进）；
    //    到期仍未付 → 关单过期。markPaidAndApply 统一落账：video→解析、package→入账余额（幂等）
    for (const o of orders.listByStatus('pending')) {
      let paid = false;
      if (nowS - o.created_at > 60) {
        const q = await queryOrder(o.id).catch(() => null);
        const state = q?.trade_state;
        if (state === 'SUCCESS') {
          const applied = orders.markPaidAndApply(o.id, q.transaction_id);
          paid = !!applied;
          if (applied?.kind === 'video') resolve(o.id).catch(() => {});
        } else if (o.expire_at <= nowS && state && state !== 'NOTPAY' && state !== 'CLOSED') {
          await closeOrder(o.id);
        }
      }
      if (!paid && o.expire_at <= nowS) orders.markExpired(o.id);
    }
    // 2) paid/resolving 卡死超 10min → 再试解析（resolve 内部有防重入与次数控制；套餐单直落 credited 不会出现在这）
    for (const o of [...orders.listByStatus('paid'), ...orders.listByStatus('resolving')]) {
      const since = o.paid_at || o.created_at;
      if (nowS - since > 600 && o.resolve_attempts < 6) resolve(o.id).catch(() => {});
    }
    // 3) 退款重试（受理失败标记 retry 的）
    for (const o of orders.listByStatus('refunded')) {
      if (o.refund_status !== 'retry') continue;
      try {
        const r = await refundOrder(o.id, o.amount_cents);
        if (r.status === 200) orders.markRefunded(o.id, refundNoFor(o.id));
      } catch { /* 下轮再试 */ }
    }
  } catch (e) {
    console.error('[sweeper] 异常:', e.message);
  }
}, 60_000).unref();

const server = app.listen(config.port, () => {
  console.log(`sph-pay-server listening :${config.port} (price=${config.priceCents}分)`);
});

// 优雅退出：纯 Node 进程，无子进程需要回收
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
