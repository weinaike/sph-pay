import express from 'express';
import fs from 'node:fs';
import { config, validateConfig } from './config.js';
import { orders, db } from './db.js';
import { previewRouter } from './routes/preview.js';
import { orderRouter } from './routes/order.js';
import { wxpayRouter } from './routes/wxpay.js';
import { devRouter } from './routes/dev.js';
import { resolve } from './services/resolveService.js';
import { closeOrder, queryOrder, refundOrder } from './services/wxpay.js';
import { refundNoFor } from './util/id.js';
import { pool } from './sph/browserPool.js';

validateConfig();

const app = express();
app.set('trust proxy', true); // nginx 后面取真实 IP
app.disable('x-powered-by');

// 微信回调路由之前必须用 raw body（JSON 解析会破坏验签）
app.use('/api/wxpay', express.raw({ type: '*/*', limit: '1mb' }), wxpayRouter);
app.use('/api', express.json({ limit: '64kb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, mock: config.mockPay, price_cents: config.priceCents }));
app.use('/api/preview', previewRouter);
app.use('/api/order', orderRouter);
if (config.mockPay) app.use('/api/dev', devRouter);

// 生产环境浏览器常驻预热（MOCK 联调也预热，方便 manual-sign 复用）
pool.start().catch(e => console.error('[boot] 浏览器预热失败（首次用到时会再试）:', e.message));

// ---- sweeper：60s 一轮 ----
setInterval(async () => {
  const nowS = Date.now() / 1000;
  try {
    // 1) pending 过期 → 查单对账 → 关单
    for (const o of orders.listByStatus('pending')) {
      if (o.expire_at > nowS) continue;
      let paid = false;
      if (!config.mockPay) {
        const q = await queryOrder(o.id).catch(() => null);
        const state = q?.trade_state;
        if (state === 'SUCCESS') {
          paid = orders.markPaid(o.id, q.transaction_id);
          if (paid) resolve(o.id).catch(() => {});
        } else if (state && state !== 'NOTPAY' && state !== 'CLOSED') {
          await closeOrder(o.id);
        }
      }
      if (!paid) orders.markExpired(o.id);
    }
    // 2) paid/resolving 卡死超 10min → 再试解析（resolve 内部有防重入与次数控制）
    for (const o of [...orders.listByStatus('paid'), ...orders.listByStatus('resolving')]) {
      const since = o.paid_at || o.created_at;
      if (nowS - since > 600 && o.resolve_attempts < 6) resolve(o.id).catch(() => {});
    }
    // 3) 退款重试（受理失败标记 retry 的）
    for (const o of orders.listByStatus('refunded')) {
      if (o.refund_status !== 'retry' || config.mockPay) continue;
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
  console.log(`sph-pay-server listening :${config.port} (MOCK_PAY=${config.mockPay}, price=${config.priceCents}分)`);
});

// 优雅退出：关服务器与浏览器
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    try { await pool.close(); } catch {}
    db.close();
    process.exit(0);
  });
}
