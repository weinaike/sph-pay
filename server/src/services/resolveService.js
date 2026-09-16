import { orders } from '../db.js';
import { signer, SignError } from '../sph/signer.js';
import { quickClient, BadSignError, SphChangedError } from '../sph/quickClient.js';
import { refundOrder } from './wxpay.js';
import { refundNoFor } from '../util/id.js';
import { config } from '../config.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 8000];
const resolving = new Set(); // 进行中防重入

/**
 * 支付成功后的解析编排：sign → quick → 校验 → 入库。
 * sign 失效自动重签；3 次失败自动全额退款。
 */
export async function resolve(orderId) {
  if (resolving.has(orderId)) return;
  resolving.add(orderId);
  try {
    const order = orders.get(orderId);
    if (!order || !['paid', 'resolving', 'resolved'].includes(order.status)) return;
    if (order.status === 'resolved') return;
    orders.markResolving(orderId);

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const result = await resolveOnce(order.content_id);
        orders.markResolved(orderId, result);
        console.log(`[resolve] ${orderId} OK (${result.fileSize}B)`);
        return;
      } catch (e) {
        lastErr = e;
        orders.bumpAttempts(orderId);
        // sign 类错误：作废缓存下次重签；站点改版/业务错误：重试无意义也计入尝试
        if (e instanceof BadSignError) signer.invalidate(order.content_id);
        console.error(`[resolve] ${orderId} 第 ${attempt + 1} 次失败: ${e.message}`);
        if (attempt < MAX_ATTEMPTS - 1) await new Promise(r => setTimeout(r, BACKOFF_MS[attempt] || 8000));
      }
    }
    await failAndRefund(orderId, lastErr);
  } finally {
    resolving.delete(orderId);
  }
}

/** 只取 url/key，不落库（deliver 时刷新 CDN 时效用） */
export async function resolveOnce(contentId) {
  const sign = await signer.getSign(contentId);
  const j = await quickClient.fetch(contentId, sign);

  // HEAD 校准：可达性 + 真实 enc_len/file_size
  const head = await fetch(j.url, { method: 'HEAD' });
  const encLen = Number(head.headers.get('x-enclen')) || 131072;
  const fileSize = Number(head.headers.get('content-length')) || j.media.file_size;
  if (!head.ok) throw new SphChangedError(`CDN HEAD ${head.status}`);

  return {
    cdnUrl: j.url,
    xorKeyB64: j._data,
    encLen,
    fileSize,
    title: j.media.title,
  };
}

/** 解析最终失败：标记 failed 并自动退款；退款受理失败交给 sweeper 重试 */
async function failAndRefund(orderId, err) {
  const order = orders.get(orderId);
  orders.markFailed(orderId, err?.message || 'resolve failed');
  console.error(`[resolve] ${orderId} 全部失败，进入退款`);

  if (config.mockPay) {
    console.error('[resolve] MOCK_PAY: 跳过真实退款，仅标记 refunded');
    orders.markRefunded(orderId, refundNoFor(orderId));
    return;
  }
  try {
    const r = await refundOrder(orderId, order.amount_cents);
    if (r.status === 200) orders.markRefunded(orderId, refundNoFor(orderId));
    else orders.markRefundRetry(orderId, refundNoFor(orderId), `refund status ${r.status}`);
  } catch (e) {
    orders.markRefundRetry(orderId, refundNoFor(orderId), e.message);
  }
}
