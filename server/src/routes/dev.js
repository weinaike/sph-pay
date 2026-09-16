import { Router } from 'express';
import { orders } from '../db.js';
import { resolve } from '../services/resolveService.js';
import { config } from '../config.js';

/** 仅 MOCK_PAY=1 时挂载：本地联调模拟支付成功 */
export const devRouter = Router();

devRouter.post('/mock-pay/:orderId', (req, res) => {
  if (!config.mockPay) return res.status(404).end();
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.status !== 'pending') return res.json({ ok: true, status: order.status, note: '非 pending，忽略' });

  const changed = orders.markPaid(order.id, `mock_${Date.now()}`);
  if (changed) resolve(order.id).catch(() => {});
  res.json({ ok: true, status: 'paid' });
});
