import crypto from 'node:crypto';
import { orders } from '../db.js';

/** 订单 capability token 校验（常数时间比较）+ 取订单 */
export function orderAuth(req, res, next) {
  const { id } = req.params;
  const token = req.query.token || req.get('x-order-token') || '';
  const order = orders.get(id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(order.order_token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'bad_token' });
  }
  req.order = order;
  next();
}
