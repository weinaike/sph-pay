import { Router } from 'express';
import { z } from 'zod';
import { normalize, NormalizeError } from '../sph/normalize.js';
import { fetchPreview } from '../services/previewService.js';
import { createNativeOrder } from '../services/wxpay.js';
import { orders } from '../db.js';
import { newOrderId, newOrderToken } from '../util/id.js';
import { config } from '../config.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';

export const previewRouter = Router();

// IP 5 次/分钟
previewRouter.use(rateLimit({ windowMs: 60_000, max: 5, keyFn: ipOf }));

const bodySchema = z.object({ url: z.string().min(1).max(2048) });

/** 白名单序列化：url/key/sign 绝不出现 */
const responseSchema = z.object({
  order_id: z.string(),
  order_token: z.string(),
  amount_cents: z.number().int().positive(),
  code_url: z.string(),
  expire_at: z.number().int(),
  preview: z.object({
    title: z.string(),
    author: z.string(),
    avatar: z.string(),
    cover: z.string(),
    description: z.string(),
    created_at: z.number().int().nullable(),
    likes: z.string(),
    content_id: z.string(),
  }),
});

const rfc3339 = (epochSec) => new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

previewRouter.post('/', async (req, res, next) => {
  try {
    const { url } = bodySchema.parse(req.body);

    let norm;
    try {
      norm = normalize(url);
    } catch (e) {
      if (e instanceof NormalizeError) return res.status(400).json({ error: 'bad_link', message: e.message });
      throw e;
    }

    // 免登录预览（export 类输入降级为占位）
    const preview = await fetchPreview(norm.shortUri);
    // 预览拿到 dynamicExportId 时升级 content_id（更贴近最终标识）
    const contentId = preview.export_id ? `${preview.export_id}##2` : norm.contentId;

    const orderId = newOrderId();
    const orderToken = newOrderToken();
    const expireAt = Math.floor(Date.now() / 1000) + config.orderTtlSeconds;

    let codeUrl = 'weixin://wxpay/mock'; // MOCK_PAY 占位
    if (!config.mockPay) {
      codeUrl = await createNativeOrder({
        orderId,
        amountCents: config.priceCents,
        description: `视频号视频下载 ${orderId}`,
        timeExpire: rfc3339(expireAt), // 与本地 expire_at 严格同源
      });
    }

    const previewJson = JSON.stringify({ ...preview, content_id: contentId });
    orders.create({ id: orderId, token: orderToken, contentId, amountCents: config.priceCents, expireAt, previewJson });

    // 白名单序列化（多余字段直接丢弃）
    const out = responseSchema.parse({
      order_id: orderId,
      order_token: orderToken,
      amount_cents: config.priceCents,
      code_url: codeUrl,
      expire_at: expireAt,
      preview: {
        title: preview.title, author: preview.author, avatar: preview.avatar, cover: preview.cover,
        description: preview.description, created_at: preview.created_at, likes: preview.likes,
        content_id: contentId,
      },
    });
    res.json(out);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'bad_request', message: e.message });
    next(e);
  }
});
