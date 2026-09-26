import { orders } from '../db.js';
import { resolveVideo, ResolverFatalError } from '../sph/resolverClient.js';
import { probeMp4Meta } from '../sph/mp4meta.js';
import { refundOrder } from './wxpay.js';
import { refundNoFor } from '../util/id.js';
import { config } from '../config.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 8000];
const resolving = new Set(); // 进行中防重入

/**
 * 支付成功后的解析编排：自有解析服务 → HEAD 校准 → 入库。
 * 网络/超时类错误自动重试；job failed/结构变化立即终止；3 次失败自动全额退款。
 */
export async function resolve(orderId) {
  if (resolving.has(orderId)) return;
  resolving.add(orderId);
  try {
    const order = orders.get(orderId);
    if (!order || !['paid', 'resolving', 'resolved'].includes(order.status)) return;
    if (order.status === 'resolved') return;
    if (order.kind !== 'video') return; // 套餐单直落 credited，不走解析（防御性守卫）
    orders.markResolving(orderId);

    // 自有解析服务只接受 /sph/ 短链；export/objectId 订单 fail-fast（防 sweeper 无限重试）
    if (!order.share_url) {
      orders.bumpAttempts(orderId);
      await failAndRefund(orderId, new Error('该订单缺少分享短链：解析仅支持 weixin.qq.com/sph/ 链接'));
      return;
    }

    // 预解析命中：preview 时已解析落库（订单 15min 内必支付，URL 新鲜度 ~1 天，恒有效）
    if (order.cdn_url) {
      orders.markResolved(orderId, {
        cdnUrl: order.cdn_url,
        xorKeyB64: order.xor_key_b64 || '',
        encLen: order.enc_len || 0,
        fileSize: order.file_size,
        title: order.title,
        durationS: order.duration_s,
        width: order.width,
        height: order.height,
      });
      console.log(`[resolve] ${orderId} OK 预解析命中 (${order.file_size}B)`);
      return;
    }

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const result = await resolveOnce(order.share_url);
        orders.markResolved(orderId, result);
        console.log(`[resolve] ${orderId} OK (${result.fileSize}B)`);
        return;
      } catch (e) {
        lastErr = e;
        orders.bumpAttempts(orderId);
        console.error(`[resolve] ${orderId} 第 ${attempt + 1} 次失败: ${e.message}`);
        if (e instanceof ResolverFatalError) break; // 站点/契约级失败，重试无意义
        if (attempt < MAX_ATTEMPTS - 1) await new Promise(r => setTimeout(r, BACKOFF_MS[attempt] || 8000));
      }
    }
    await failAndRefund(orderId, lastErr);
  } finally {
    resolving.delete(orderId);
  }
}

/** 解析并 HEAD 校准 + mp4 头探测元数据（不落库；deliver 刷新 CDN 时效时复用）。
 *  明文直链：无 XOR、无 x-enclen。元数据探测失败不阻断（返回 null 字段）。 */
export async function resolveOnce(shareUrl, { forceRefresh = false, timeoutMs } = {}) {
  const { cdnUrl, title, author, likeCount, favCount, forwardCount, commentCount } = await resolveVideo(shareUrl, { forceRefresh, timeoutMs });

  // HEAD 校准：可达性 + 真实 file_size
  const head = await fetch(cdnUrl, { method: 'HEAD', signal: AbortSignal.timeout(config.sph.requestTimeoutMs) });
  if (!head.ok) throw new Error(`CDN HEAD ${head.status}`);
  const fileSize = Number(head.headers.get('content-length')) || 0;

  // 时长/分辨率：moov 头自解析（上游载荷无这些字段，实测 2026-09-22）
  const meta = await probeMp4Meta(cdnUrl, { timeoutMs: config.sph.requestTimeoutMs });

  return {
    cdnUrl,
    xorKeyB64: '',
    encLen: 0,
    fileSize,
    title: title || 'sph_video',
    author: author || '', // 达人昵称：/api/resolve 出参用（skill 6.5 同达人追问）；markResolved 解构不取、自然忽略
    durationS: meta.durationS,
    width: meta.width,
    height: meta.height,
    // 互动计数（可选增强）：markResolved 解构不取、自然忽略；批量与 /api/resolve 出参用
    likeCount, favCount, forwardCount, commentCount,
  };
}

/** 解析最终失败：标记 failed 并自动退款；退款受理失败交给 sweeper 重试 */
async function failAndRefund(orderId, err) {
  const order = orders.get(orderId);
  orders.markFailed(orderId, err?.message || 'resolve failed');
  console.error(`[resolve] ${orderId} 全部失败，进入退款`);

  try {
    const r = await refundOrder(orderId, order.amount_cents);
    if (r.status === 200) orders.markRefunded(orderId, refundNoFor(orderId));
    else orders.markRefundRetry(orderId, refundNoFor(orderId), `refund status ${r.status}`);
  } catch (e) {
    orders.markRefundRetry(orderId, refundNoFor(orderId), e.message);
  }
}
