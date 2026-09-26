import { Router } from 'express';
import { z } from 'zod';
import { normalize, NormalizeError } from '../sph/normalize.js';
import { resolveOnce } from '../services/resolveService.js';
import { createBatch, kick } from '../services/batchService.js';
import { users, usageLog, batches } from '../db.js';
import { userAuth } from '../middleware/userAuth.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';

export const resolveRouter = Router();

const bodySchema = z.object({ url: z.string().min(1).max(2048) });

const outSchema = z.object({
  url: z.string(),
  file_size: z.number().int().nonnegative(),
  title: z.string(),
  author: z.string(), // 达人昵称（上游缺省为 ''，客户端需兜底）
  duration_s: z.number().int().nullable(), // mp4 头解析元数据（可能为 null）
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  like_count: z.number().int().nonnegative(), // 互动计数（get_feed_info Fmt 解析；旧上游恒 0）
  fav_count: z.number().int().nonnegative(),
  forward_count: z.number().int().nonnegative(),
  comment_count: z.number().int().nonnegative(),
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
      res.json(outSchema.parse({
        url: r.cdnUrl, file_size: r.fileSize, title: r.title, author: r.author,
        duration_s: r.durationS ?? null, width: r.width ?? null, height: r.height ?? null,
        like_count: r.likeCount ?? 0, fav_count: r.favCount ?? 0,
        forward_count: r.forwardCount ?? 0, comment_count: r.commentCount ?? 0,
        charged: !deduped,
      }));
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

// ---- 批量解析（skill 端 batch_resolve.py 的服务端替代）----
// 提交轻（只建表不解析），重活在后台 runner；轮询 GET /batch/:id 取进度与结果。

const batchBodySchema = z.object({ urls: z.array(z.string().min(1).max(2048)).min(1).max(100) });
const BATCH_MAX = 100;

const batchCreateLimitIp = rateLimit({ windowMs: 60_000, max: 5, keyFn: ipOf });
const batchCreateLimitToken = rateLimit({ windowMs: 60_000, max: 5, keyFn: req => `bt:${req.get('x-user-token') || ipOf(req)}` });
const batchPollLimitIp = rateLimit({ windowMs: 60_000, max: 60, keyFn: ipOf });
const batchPollLimitToken = rateLimit({ windowMs: 60_000, max: 30, keyFn: req => `bt:${req.get('x-user-token') || ipOf(req)}` });

resolveRouter.post('/batch', batchCreateLimitIp, batchCreateLimitToken, userAuth, (req, res, next) => {
  try {
    const { urls } = batchBodySchema.parse(req.body);

    // 全量预校验：任一非短链整批拒绝（避免半批执行后才发现脏输入）；批内按短码去重保序
    const seen = new Set();
    const shareUrls = [];
    const bad = [];
    for (const [i, u] of urls.entries()) {
      let norm;
      try {
        norm = normalize(u);
      } catch { norm = null; }
      if (!norm?.shortUri) { bad.push(i); continue; }
      const shareUrl = `https://weixin.qq.com/sph/${norm.shortUri}`;
      if (!seen.has(shareUrl)) { seen.add(shareUrl); shareUrls.push(shareUrl); }
    }
    if (bad.length) {
      return res.status(400).json({
        error: 'unsupported_link',
        message: `第 ${bad.join(',')} 条（0 起）不是 weixin.qq.com/sph/ 短链，已整批拒绝`,
      });
    }
    if (shareUrls.length > BATCH_MAX) {
      return res.status(400).json({ error: 'bad_request', message: `单批最多 ${BATCH_MAX} 条（去重后 ${shareUrls.length} 条）` });
    }

    const { id, total } = createBatch(req.user.user_token, shareUrls);
    res.json({
      batch_id: id,
      total, // 去重后的条数
      status: 'running',
      poll_after_ms: 10_000,
      message: `批量解析已提交（${total} 条，逐条扣直链额度、失败自动返还）；GET /api/resolve/batch/${id} 轮询进度`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'bad_request', message: e.message });
    next(e);
  }
});

resolveRouter.get('/batch/:id', batchPollLimitIp, batchPollLimitToken, userAuth, (req, res, next) => {
  try {
    const b = batches.get(req.params.id);
    // 属主校验：非本人批次按不存在处理（不泄露批次 id 空间）
    if (!b || b.user_token !== req.user.user_token) {
      return res.status(404).json({ error: 'batch_not_found' });
    }
    // 防御：running 但 runner 因进程崩溃丢失（同进程 kick 补启；跨进程由启动恢复兜底）
    if (b.status === 'running') kick(b.id);

    const items = batches.items(b.id);
    const count = s => items.filter(i => i.status === s).length;
    res.json({
      batch_id: b.id,
      status: b.status,
      total: b.total,
      resolved_count: count('resolved'),
      failed_count: count('refunded'),
      skipped_count: count('skipped'),
      pending_count: items.filter(i => ['pending', 'resolving'].includes(i.status)).length,
      poll_after_ms: b.status === 'running' ? 10_000 : 0,
      items: items.map(i => ({
        url: i.url,
        status: i.status,
        title: i.title,
        file_size: i.file_size,
        duration_s: i.duration_s,
        width: i.width,
        height: i.height,
        like_count: i.like_count ?? 0, // 互动计数（旧库行/旧上游解析的历史条目为 0）
        fav_count: i.fav_count ?? 0,
        forward_count: i.forward_count ?? 0,
        comment_count: i.comment_count ?? 0,
        cdn_url: i.status === 'resolved' ? i.cdn_url : undefined, // 直链只随成功条目下发，属主鉴权内
        error: i.error || undefined,
      })),
    });
  } catch (e) { next(e); }
});
