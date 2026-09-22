import { Router } from 'express';
import { Readable } from 'node:stream';
import { orders } from '../db.js';
import { orderAuth } from '../middleware/orderAuth.js';
import { resolve, resolveOnce } from '../services/resolveService.js';
import { config } from '../config.js';
import { xorDecryptStream } from '../sph/decryptStream.js';

export const orderRouter = Router();

const STATUS_MESSAGES = {
  pending: '等待支付',
  paid: '支付成功，正在解析视频源',
  resolving: '正在解析视频源',
  resolved: '解析完成，可获取下载链接',
  credited: '支付成功，套餐权益已到账（余额见 /api/user/me）',
  failed: '解析失败',
  refunded: '解析失败，已全额退款，费用将原路退回',
  expired: '订单已过期（未支付）',
};

orderRouter.get('/:id/status', orderAuth, (req, res) => {
  const o = req.order;
  // 补偿：paid 超 60s 仍无解析痕迹 → 现场重触发（防回调后进程崩溃丢任务）
  if (o.status === 'paid' && o.paid_at && Date.now() / 1000 - o.paid_at > 60) {
    resolve(o.id).catch(() => {});
  }
  res.json({
    status: o.status,
    message: STATUS_MESSAGES[o.status] || o.status,
    poll_after_ms: ['paid', 'resolving'].includes(o.status) ? 3000 : 5000,
  });
});

const REFRESH_AFTER_S = 20 * 3600; // CDN 时效约 1 天，留 4h 余量

orderRouter.get('/:id/deliver', orderAuth, async (req, res, next) => {
  try {
    let o = req.order;
    if (o.kind === 'package') {
      return res.status(409).json({ error: 'package_order', message: STATUS_MESSAGES[o.status] || '套餐订单无直链交付' });
    }
    if (o.status === 'paid' || o.status === 'resolving') {
      return res.status(409).json({ error: 'not_ready', message: STATUS_MESSAGES[o.status] });
    }
    if (o.status !== 'resolved') {
      return res.status(409).json({ error: o.status, message: STATUS_MESSAGES[o.status] });
    }
    // CDN url 过期 → 刷新（仅短链订单可刷新；订单已支付，不重复收费）
    if (o.share_url && Date.now() / 1000 - o.resolved_at > REFRESH_AFTER_S) {
      try {
        const fresh = await resolveOnce(o.share_url, { forceRefresh: true, timeoutMs: 20_000 });
        orders.refreshDelivery(o.id, fresh);
        o = orders.get(o.id);
      } catch (e) {
        // 刷新失败但旧 url 可能仍有效 → 下发旧的
        console.error(`[deliver] 刷新失败，回退旧 url: ${e.message}`);
      }
    }
    // 密钥存在性区分新旧订单：明文直链常态（key 空/len 0）；历史加密订单存量密钥原样交付
    const encrypted = !!o.xor_key_b64;
    res.json({
      url: o.cdn_url,
      key_b64: encrypted ? o.xor_key_b64 : '',
      enc_len: encrypted ? (o.enc_len || 131072) : 0,
      // 历史加密订单：服务端解密代理（Range 流式 XOR），客户端 curl 直下、无需本地解密
      proxy_url: encrypted ? `${config.publicBase}/api/order/${o.id}/file?token=${o.order_token}` : '',
      file_size: o.file_size,
      duration_s: o.duration_s ?? null, // mp4 头解析元数据（可能为 null，客户端需兜底）
      width: o.width ?? null,
      height: o.height ?? null,
      title: o.title || 'sph_video',
    });
  } catch (e) { next(e); }
});

/**
 * 历史加密订单解密代理（仅 kind=video 且带存量密钥的订单；明文订单继续走 deliver.url 直下）。
 * Range 支持断点续传：XOR 等长保序，明文偏移 == 密文偏移，区间直接透传上游后按起点解密。
 */
orderRouter.get('/:id/file', orderAuth, async (req, res, next) => {
  try {
    const o = req.order;
    if (o.kind === 'package') return res.status(409).json({ error: 'package_order' });
    if (!o.xor_key_b64 || !o.cdn_url) {
      return res.status(409).json({ error: 'not_encrypted', message: '该订单为明文直链，直接下载 deliver 返回的 url 即可' });
    }
    if (o.status !== 'resolved') {
      return res.status(409).json({ error: o.status, message: STATUS_MESSAGES[o.status] || o.status });
    }

    const key = Buffer.from(o.xor_key_b64, 'base64');
    const encLen = o.enc_len || 131072;
    const range = req.headers.range; // 原样透传（curl -C - 产生 bytes=a-b）
    const upstream = await fetch(o.cdn_url, {
      headers: range ? { Range: range } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: 'upstream_error', message: `CDN ${upstream.status}` });
    }

    res.status(upstream.status);
    res.set({
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }

    // Range 起点决定解密偏移（bytes=a-b → a）；无 Range 从 0 开始
    let start = 0;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      if (m) start = Number(m[1]);
    }
    // Node fetch 的 body 是 Web ReadableStream；转 Node 流后过解密 Transform
    Readable.fromWeb(upstream.body).pipe(xorDecryptStream(key, encLen, start)).pipe(res);
    // 客户端断开 → 中止上游拉流
    res.on('close', () => upstream.body?.cancel?.().catch(() => {}));
  } catch (e) { next(e); }
});
