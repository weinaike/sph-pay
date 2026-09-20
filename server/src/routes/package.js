import { Router } from 'express';
import { z } from 'zod';
import { orders } from '../db.js';
import { createNativeOrder } from '../services/wxpay.js';
import { newOrderId, newOrderToken } from '../util/id.js';
import { config } from '../config.js';
import { userAuth } from '../middleware/userAuth.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';

export const packageRouter = Router();

const bodySchema = z.object({ package: z.enum(['A', 'B', 'C']) });

const responseSchema = z.object({
  order_id: z.string(),
  order_token: z.string(),
  package: z.string(),
  amount_cents: z.number().int().positive(),
  code_url: z.string(),
  expire_at: z.number().int(),
  granted: z.object({ link_quota: z.number().int(), search_credits: z.number().int() }),
  notice: z.string(),
});

const rfc3339 = (epochSec) => new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/** 购买资源包：套餐订单复用 orders 支付生命周期（kind='package'），支付落账时入账余额（db.markPaidAndApply）。 */
packageRouter.post('/', rateLimit({ windowMs: 60_000, max: 5, keyFn: ipOf }), userAuth, async (req, res, next) => {
  try {
    const { package: pkgName } = bodySchema.parse(req.body);
    const pkg = config.packages[pkgName];

    const orderId = newOrderId();
    const orderToken = newOrderToken();
    const expireAt = Math.floor(Date.now() / 1000) + config.orderTtlSeconds;

    const codeUrl = await createNativeOrder({
      orderId,
      amountCents: pkg.cents,
      description: `视频号资源包${pkgName} ${pkg.linkQuota}条直链额度`
        + (pkg.searchCredits ? `+${pkg.searchCredits}次百条检索` : '') + ` ${orderId}`,
      timeExpire: rfc3339(expireAt), // 与本地 expire_at 严格同源
    });

    orders.create({
      id: orderId, token: orderToken,
      contentId: `package:${pkgName}`, // NOT NULL 哨兵：套餐无视频身份，share_url 留 NULL
      kind: 'package', pkg: pkgName, userToken: req.user.user_token,
      amountCents: pkg.cents, expireAt,
    });

    res.json(responseSchema.parse({
      order_id: orderId, order_token: orderToken, package: pkgName,
      amount_cents: pkg.cents, code_url: codeUrl, expire_at: expireAt,
      granted: { link_quota: pkg.linkQuota, search_credits: pkg.searchCredits },
      notice: '虚拟权益，支付后即时到账，售出不退；余额永久有效',
    }));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'bad_request', message: e.message });
    next(e);
  }
});
