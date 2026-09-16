import { Router } from 'express';
import { orders } from '../db.js';
import { orderAuth } from '../middleware/orderAuth.js';
import { resolve, resolveOnce } from '../services/resolveService.js';

export const orderRouter = Router();

const STATUS_MESSAGES = {
  pending: '等待支付',
  paid: '支付成功，正在解析视频源',
  resolving: '正在解析视频源',
  resolved: '解析完成，可获取下载链接',
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
    if (o.status === 'paid' || o.status === 'resolving') {
      return res.status(409).json({ error: 'not_ready', message: STATUS_MESSAGES[o.status] });
    }
    if (o.status !== 'resolved') {
      return res.status(409).json({ error: o.status, message: STATUS_MESSAGES[o.status] });
    }
    // CDN url 过期 → 刷新（订单已支付，不重复收费）
    if (Date.now() / 1000 - o.resolved_at > REFRESH_AFTER_S) {
      try {
        const fresh = await resolveOnce(o.content_id);
        orders.refreshDelivery(o.id, fresh);
        o = orders.get(o.id);
      } catch (e) {
        // 刷新失败但旧 url 可能仍有效 → 下发旧的
        console.error(`[deliver] 刷新失败，回退旧 url: ${e.message}`);
      }
    }
    res.json({
      url: o.cdn_url,
      key_b64: o.xor_key_b64,
      enc_len: o.enc_len || 131072,
      file_size: o.file_size,
      title: o.title || 'sph_video',
    });
  } catch (e) { next(e); }
});
