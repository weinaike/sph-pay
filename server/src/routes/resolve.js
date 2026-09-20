import { Router } from 'express';
import { z } from 'zod';
import { normalize, NormalizeError } from '../sph/normalize.js';
import { resolveOnce } from '../services/resolveService.js';
import { users, usageLog } from '../db.js';
import { userAuth } from '../middleware/userAuth.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';

export const resolveRouter = Router();

const bodySchema = z.object({ url: z.string().min(1).max(2048) });

const outSchema = z.object({
  url: z.string(),
  file_size: z.number().int().nonnegative(),
  title: z.string(),
  charged: z.boolean(), // false = 24h 内同短链免重扣
});

const DEDUP_WINDOW_S = 24 * 3600; // 与 CDN 直链时效对齐：同 token 同短链 24h 内免重扣

// IP 15/min（防匿名刷面）+ token 10/min（合法批量的实际节拍）。
// ⚠️ 实测教训：IP 限频低于 token 限频时，合法批量第 6 条起必吃 429（IP 桶先满），批量节奏以 token 限频为准。
const ipLimit = rateLimit({ windowMs: 60_000, max: 15, keyFn: ipOf });
const tokenLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: req => `rs:${req.get('x-user-token') || ipOf(req)}` });

/**
 * 额度直链（skill 渠道）：短链 → 直链，扣 1 条直链额度。
 * 顺序：24h 去重 → 原子扣减（不足 402）→ resolveOnce → 失败自动返还。
 * 直链结果不落库（时效 ~1 天）；只落 usage_log 身份台账。
 */
resolveRouter.post('/', ipLimit, tokenLimit, userAuth, async (req, res, next) => {
  try {
    const { url } = bodySchema.parse(req.body);
    let norm;
    try {
      norm = normalize(url);
    } catch (e) {
      if (e instanceof NormalizeError) return res.status(400).json({ error: 'bad_link', message: e.message });
      throw e;
    }
    if (!norm.shortUri) {
      return res.status(400).json({ error: 'unsupported_link', message: '仅支持 weixin.qq.com/sph/ 短链（export/objectId 无法解析）' });
    }
    const shareUrl = `https://weixin.qq.com/sph/${norm.shortUri}`;
    const token = req.user.user_token;

    // 24h 内同短链已扣过且未返还 → 免重扣（照常重新解析下发新直链）
    const deduped = usageLog.chargedSince('resolve', shareUrl, token, Math.floor(Date.now() / 1000) - DEDUP_WINDOW_S);

    let logId = null;
    if (!deduped) {
      if (!users.consumeLinkQuota(token)) {
        return res.status(402).json({
          error: 'no_link_quota',
          message: `直链额度不足：可购买资源包（A ¥5/10条、B ¥30/100条、C ¥50/200条，POST /api/package），`
            + `或单条 ¥1 支付下载（POST /api/order），或使用小程序免费下载`,
        });
      }
      logId = usageLog.insert({ userToken: token, kind: 'resolve', target: shareUrl });
    }

    try {
      const r = await resolveOnce(shareUrl, { timeoutMs: 30_000 });
      res.json(outSchema.parse({ url: r.cdnUrl, file_size: r.fileSize, title: r.title, charged: !deduped }));
    } catch (e) {
      if (logId != null) { // 解析失败：本次扣减作废
        users.refundLinkQuota(token);
        usageLog.markRefunded(logId);
      }
      res.status(503).json({ error: 'resolve_failed', message: `解析失败（${deduped ? '未扣额度' : '额度已返还'}）：${e.message}` });
    }
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'bad_request', message: e.message });
    next(e);
  }
});
