import { Router } from 'express';
import { config } from '../config.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';

/**
 * 微信 webtop 登录二维码回源（运维通知链路，非商品 API）：
 * 钉钉群机器人消息内嵌二维码图 → 钉钉客户端按公网 URL 拉图 →
 * 本路由回源 mac-mini 的 wx-rpa daemon（GET {WXQR_UPSTREAM}/wxqr/<token>/<版本hash>.png）。
 *
 * 安全：token 由 daemon 在 need_scan 期间生成、登录成功即作废（见
 * wx_channels_download/docker/webtop-old/rpa/wx_rpa.py）；本路由只透传路径，
 * 不做任何缓存（二维码会自动刷新，同 URL 缓存旧码会害人扫过期码）。
 *
 * 路径式而非 query 传 token：部分图片拉取器会丢 query 参数（2026-09-20 实测教训）。
 * 限频 60/min/IP：钉钉客户端单次渲染会连发多次请求（缩略图+原图+404 重试风暴），
 * 10/min 实测会误伤（429 → 群里"原图加载失败"）；真正的防护是 token 本身。
 */

export const wxqrRouter = Router();

const ipLimit = rateLimit({ windowMs: 60_000, max: 60, keyFn: ipOf });

wxqrRouter.get('/:token/:ver.png', ipLimit, async (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return res.status(404).end();
  }
  try {
    const upstream = `${config.wxqrUpstream}/wxqr/${encodeURIComponent(token)}/${req.params.ver}.png`;
    const r = await fetch(upstream, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(buf);
  } catch {
    return res.status(502).end();
  }
});

// 兼容 query 形态（老 URL / 本地调试）
wxqrRouter.get('/', ipLimit, async (req, res) => {
  const t = String(req.query.t || '');
  if (!t || t.length > 128) return res.status(404).end();
  try {
    const upstream = `${config.wxqrUpstream}/wxqr.png?t=${encodeURIComponent(t)}`;
    const r = await fetch(upstream, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(buf);
  } catch {
    return res.status(502).end();
  }
});
