/** 内存滑窗限流（单机够用；上量后换 redis） */
export function rateLimit({ windowMs, max, keyFn }) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of buckets) {
      const kept = arr.filter(t => t > cutoff);
      if (kept.length) buckets.set(k, kept); else buckets.delete(k);
    }
  }, windowMs).unref?.();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter(t => t > now - windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'rate_limited', retry_after_ms: windowMs });
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}

export const ipOf = (req) => req.ip || req.socket.remoteAddress || 'unknown';
