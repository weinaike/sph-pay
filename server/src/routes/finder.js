import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { users } from '../db.js';
import { userAuth } from '../middleware/userAuth.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';
import { FinderError } from '../finder/client.js';
import { searchTop, getFinderVideos, NoSearchCreditsError } from '../finder/videos.js';

export const finderRouter = Router();

const USERNAME_RE = /^(v[12]_[A-Za-z0-9]+)@finder$/;

const searchSchema = z.object({ keyword: z.string().min(1).max(64) });
const videosSchema = z.object({
  username: z.string().regex(USERNAME_RE, 'username 须为 v1_/v2_ 前缀的达人 id'),
  full: z.boolean().optional(),
});

const finderOut = z.object({
  username: z.string(),
  nickname: z.string(),
  avatar: z.string(),
  signature: z.string(),
});

const videoOut = z.object({
  object_id: z.string(),
  title: z.string(),
  share_url: z.string().nullable(),
  created_at: z.number().int(),
  duration: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
});

const videosOut = z.object({
  username: z.string(),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  charged: z.boolean(),
  refunded: z.boolean().optional(),
  truncated: z.boolean(),
  cache_hit: z.boolean(),
  items: z.array(videoOut),
});

const err = (res, status, code, message) => res.status(status).json({ error: code, message });

/** 达人检索 Top10：免费匿名（限频 10/min/IP；上游 503 语义=webtop 掉线） */
finderRouter.post('/search', rateLimit({ windowMs: 60_000, max: 10, keyFn: ipOf }), async (req, res, next) => {
  try {
    const { keyword } = searchSchema.parse(req.body);
    const items = await searchTop(keyword.trim());
    res.json({ items: items.map(i => finderOut.parse(i)) });
  } catch (e) {
    if (e instanceof z.ZodError) return err(res, 400, 'bad_request', e.issues[0]?.message || '参数错误');
    if (e instanceof FinderError) return err(res, 503, 'finder_unavailable', `达人检索上游不可用：${e.message}`);
    next(e);
  }
});

// 免费档 IP 限频 6/min；full 档再叠 token 限频 3/min（匿名请求不进这个桶）
const freeIpLimit = rateLimit({ windowMs: 60_000, max: 6, keyFn: ipOf });
const fullTokenLimit = rateLimit({ windowMs: 60_000, max: 3, keyFn: req => `vt:${req.get('x-user-token') || ipOf(req)}` });

/** 达人作品列表：免费=前 10 条（匿名）；full=true=前 100 条（X-User-Token + 百条机会） */
finderRouter.post('/videos', freeIpLimit, async (req, res, next) => {
  try {
    const { username, full } = videosSchema.parse(req.body);

    if (!full) {
      const r = await getFinderVideos({ username });
      return res.json(videosOut.parse({
        username, total: r.total, count: r.items.length, charged: false,
        truncated: r.truncated, cache_hit: r.cacheHit, items: r.items,
      }));
    }

    // full：需要账户（先过 token 限频再鉴权，坏 token 也按值分桶计数）
    return fullTokenLimit(req, res, () => {
      userAuth(req, res, async () => {
        try {
          const r = await getFinderVideos({ username, full: true, userToken: req.user.user_token });
          res.json(videosOut.parse({
            username, total: r.total, count: r.items.length, charged: r.charged,
            refunded: r.refunded, truncated: r.truncated, cache_hit: r.cacheHit, items: r.items,
          }));
        } catch (e) {
          if (e instanceof NoSearchCreditsError) {
            return err(res, 402, 'no_search_credits', `${e.message}；当前余额见 /api/user/me`);
          }
          if (e instanceof FinderError) return err(res, 503, 'finder_unavailable', `达人列表上游不可用：${e.message}`);
          next(e);
        }
      });
    });
  } catch (e) {
    if (e instanceof z.ZodError) return err(res, 400, 'bad_request', e.issues[0]?.message || '参数错误');
    if (e instanceof FinderError) return err(res, 503, 'finder_unavailable', `达人列表上游不可用：${e.message}`);
    next(e);
  }
});
