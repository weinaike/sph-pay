import { Router } from 'express';
import { orders } from '../db.js';
import { resolve } from '../services/resolveService.js';

export const devRouter = Router();

/** 模拟支付成功：仅 MOCK_PAY=1 时挂载（index.js 守卫），走与真实回调完全相同的落账路径 */
devRouter.post('/mock-pay/:id', (req, res, next) => {
  try {
    const applied = orders.markPaidAndApply(req.params.id, `MOCK_${req.params.id}`);
    if (applied?.kind === 'video') resolve(req.params.id).catch(() => {});
    res.json({ ok: true, applied });
  } catch (e) { next(e); }
});
