import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { users } from '../db.js';
import { userAuth } from '../middleware/userAuth.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';

export const userRouter = Router();

// 白名单序列化：余额/已购之外的字段绝不外泄
const meSchema = z.object({
  user_token: z.string(),
  link_quota: z.number().int().nonnegative(),
  search_credits: z.number().int().nonnegative(),
  total_paid_cents: z.number().int().nonnegative(),
  purchases: z.array(z.object({
    order_id: z.string(),
    package: z.string(),
    amount_cents: z.number().int().positive(),
    created_at: z.number().int(),
  })),
});

/** 匿名开户：首次访问颁发 user_token（256bit），余额/已购挂它；丢失即丢余额 */
userRouter.post('/', rateLimit({ windowMs: 60_000, max: 10, keyFn: ipOf }), (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  users.create(token);
  res.status(201).json(meSchema.parse({ user_token: token, link_quota: 0, search_credits: 0, total_paid_cents: 0, purchases: [] }));
});

userRouter.get('/me', userAuth, (req, res) => {
  const u = req.user;
  res.json(meSchema.parse({
    user_token: u.user_token,
    link_quota: u.link_quota,
    search_credits: u.search_credits,
    total_paid_cents: u.total_paid_cents,
    purchases: users.listPurchases(u.user_token)
      .map(p => ({ order_id: p.id, package: p.package, amount_cents: p.amount_cents, created_at: p.created_at })),
  }));
});
