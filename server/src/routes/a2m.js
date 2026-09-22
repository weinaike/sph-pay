import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { normalize, NormalizeError } from '../sph/normalize.js';
import { resolveOnce } from '../services/resolveService.js';
import { a2mOrders } from '../db.js';
import { config } from '../config.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';
import { newA2mTradeNo } from '../util/id.js';
import { ensurePipeline, artifactState, artifactFile } from '../a2m/artifacts.js';
import { A2MConfigError, loadAlipayConfig, isExactSandboxMode } from '../a2m/config.js';
import {
  CURRENCY, centsToYuan, formatISO8601WithTimezone, amountsEqual,
  generateSellerSignature, buildPaymentNeeded, encodePaymentNeeded, parsePaymentProof, base64UrlEncode,
} from '../a2m/protocol.js';
import { verifyAgentPayment, confirmAgentFulfillment } from '../a2m/alipay.js';

/**
 * AI 按量付费（A2M，支付宝）资源端点：
 *   GET /api/a2m/resolve?url=<视频号分享短链>
 * 无 Payment-Proof → 402 + Payment-Needed Header（Base64URL 账单，商家本地 RSA2 签名）；
 * 带 Payment-Proof → alipay.aipay.agent.payment.verify 严格验付（active/金额/单号/资源一致/
 * trade_no 未重复履约）→ 幂等履约 → alipay.aipay.agent.fulfillment.confirm → 交付解析直链。
 *
 * ¥1 打包交付：视频直链（即时）+ 音频 m4a + ASR 文字稿（异步流水线，deliver 重放即轮询，
 * 产物经 /api/a2m/artifact?token= 下载，token 只随已验付交付响应下发）。
 *
 * 与 /api/order 同安全边界：支付前零下发（402 调试体不含 cdn_url 与产物 URL）；cdn_url 只进
 * sqlite 与已验付的交付响应；支付前真实解析预检，预检不过不出账单（从根上避免"付款后拿不到资源"）。
 */

export const a2mRouter = Router();

const querySchema = z.object({ url: z.string().min(1).max(2048) });
const bodySchema = z.object({ url: z.string().min(1).max(2048) });

/** 402 调试体白名单（智能体支付依据是 Header；绝不含 cdn_url） */
const paymentNeededBodySchema = z.object({
  code: z.literal('Payment-Needed'),
  message: z.string(),
  out_trade_no: z.string(),
  amount: z.string(),
  currency: z.string(),
  goods_name: z.string(),
  resource_id: z.string(),
  pay_before: z.string(),
});

/** 交付响应白名单：content 是已付费交付物（此处允许 cdn_url）。
 *  audio/transcript 是 ¥1 打包的增量产物（可选：老订单无产物行时不出现），
 *  客户端用同一 Payment-Proof 重调本端点轮询 status 到终态。 */
const artifactStatus = z.enum(['pending', 'processing', 'ready', 'failed', 'skipped', 'expired']);
const deliveredBodySchema = z.object({
  resource_id: z.string(),
  out_trade_no: z.string(),
  trade_no: z.string(),
  already_fulfilled: z.boolean(),
  fulfillment_confirmed: z.boolean(),
  content: z.object({
    share_url: z.string(),
    title: z.string(),
    author: z.string().optional(),
    cdn_url: z.string(),
    file_size: z.number().int().nonnegative(),
    duration_s: z.number().int().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    audio: z.object({
      status: artifactStatus,
      url: z.string().optional(),
      file_size: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }).optional(),
    transcript: z.object({
      status: artifactStatus,
      text: z.string().optional(),
      srt: z.string().optional(),
      url: z.string().optional(),
      srt_url: z.string().optional(),
      json_url: z.string().optional(),
      duration_ms: z.number().int().nullable().optional(),
      error: z.string().optional(),
    }).optional(),
    generated_at: z.string(),
  }),
});

// 限流：出账单走真实解析预检（成本与 /api/order 同级）；Proof 重试同路由计数。
// 双入口：/api/a2m/resolve（客户端 skill 用）与 /api/a2m/resource（服务市场注册的
// resourceUrl，平台智能体调用入口）；GET ?url= 与 POST {"url":...} 均收。
async function handleResolve(req, res, next) {
  try {
    const url = req.method === 'POST'
      ? bodySchema.parse(req.body).url
      : querySchema.parse(req.query).url;

    let norm;
    try {
      norm = normalize(url);
    } catch (e) {
      if (e instanceof NormalizeError) return res.status(400).json({ error: 'bad_link', message: e.message });
      throw e;
    }
    const shareUrl = norm.shortUri ? `https://weixin.qq.com/sph/${norm.shortUri}` : null;
    if (!shareUrl) {
      return res.status(400).json({ error: 'unsupported_link', message: '仅支持 weixin.qq.com/sph/ 短链（export/objectId 无法解析）' });
    }
    // 资源标识从规范短链构造：同一视频任意原文格式/入口路径输入 → 同一 resource_id（资源防串基准）
    const resourceId = `/api/a2m/resolve?url=${shareUrl}`;

    const proof = req.get('payment-proof');
    if (typeof proof === 'string' && proof.trim()) {
      return await verifyAndDeliver(req, res, { proof: proof.trim(), resourceId, shareUrl });
    }
    return await issuePaymentNeeded(res, { resourceId, shareUrl });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'bad_request', message: e.message });
    if (e instanceof A2MConfigError) return res.status(503).json({ error: 'a2m_not_configured', message: e.message });
    next(e);
  }
}

const resolveLimiter = rateLimit({ windowMs: 60_000, max: 10, keyFn: ipOf });
a2mRouter.get('/resolve', resolveLimiter, handleResolve);
a2mRouter.post('/resolve', resolveLimiter, handleResolve);
a2mRouter.get('/resource', resolveLimiter, handleResolve); // 服务市场注册的 resourceUrl 入口
a2mRouter.post('/resource', resolveLimiter, handleResolve);

// 产物下载（音频/文字稿）：token 随已验付交付响应下发，独立限流（音频断点续传等重试不占出账单额度）
const artifactLimiter = rateLimit({ windowMs: 60_000, max: 60, keyFn: ipOf });
const ARTIFACT_MIME = {
  'audio.m4a': 'audio/mp4',
  'transcript.txt': 'text/plain; charset=utf-8',
  'transcript.srt': 'application/x-subrip',
  'transcript.json': 'application/json; charset=utf-8',
};
a2mRouter.get('/artifact/:outTradeNo/:kind', artifactLimiter, (req, res) => {
  const { outTradeNo, kind } = req.params;
  const hit = artifactFile(outTradeNo, String(req.query.token || ''), kind);
  if (hit.error) {
    const message = { 400: '未知产物类型', 403: '产物凭证无效', 404: '产物不存在或已过期' }[hit.error];
    return res.status(hit.error).json({ error: 'artifact_unavailable', message });
  }
  // 下载文件名尽量用订单标题（deliverable.title），兜底订单号
  let base = outTradeNo;
  try {
    const o = a2mOrders.get(outTradeNo);
    const title = o?.deliverable ? JSON.parse(o.deliverable).title : '';
    const safe = String(title || '').replace(/[^\p{L}\p{N}_()+-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (safe) base = safe;
  } catch { /* 文件名美化失败不阻断下载 */ }
  const ext = kind.split('.').pop();
  res.set('Content-Type', ARTIFACT_MIME[kind] || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${outTradeNo}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`);
  fs.createReadStream(hit.file).pipe(res);
});

/** 无有效 Proof：解析预检 → 建待付订单 → 402 + Payment-Needed Header */
async function issuePaymentNeeded(res, { resourceId, shareUrl }) {
  const cfg = loadAlipayConfig(); // 抛 A2MConfigError → 503

  // 支付前真实解析预检（与 /api/order 同闸门：预检不过不出账单，避免付款后拿不到资源）
  let pre;
  try {
    pre = await resolveOnce(shareUrl, { timeoutMs: config.a2m.precheckTimeoutMs });
  } catch (e) {
    return res.status(503).json({ error: 'resolve_unavailable', message: `解析预检未通过，未出账单：${e.message}` });
  }

  // 时长上限（¥1 打包含 ASR，超长视频成本倒挂 → 不出账单；解析已拿 moov 时长）
  if (pre.durationS && pre.durationS > config.a2m.maxDurationS) {
    return res.status(400).json({
      error: 'video_too_long',
      message: `视频时长 ${Math.round(pre.durationS / 60)} 分钟，超过本服务上限 ${Math.round(config.a2m.maxDurationS / 60)} 分钟，未出账单`,
    });
  }

  // 沙箱 mock 服务（api_mock_service_id）收银固定按 0.01 元试算（官方五语言 A2M 示例同值，
  // 其他金额收银返回 SERVICE_PRICE_MISMATCH）；生产按业务定价 config.a2m.priceCents 计费
  const amount = isExactSandboxMode(cfg) ? '0.01' : centsToYuan(config.a2m.priceCents);
  const goodsName = `视频号视频+音频+文字提取：${(pre.title || '').slice(0, 40)}`.replace(/[:：]$/, '');
  const payBeforeDate = new Date(Date.now() + config.a2m.payBeforeSeconds * 1000);
  const payBefore = formatISO8601WithTimezone(payBeforeDate);
  const outTradeNo = newA2mTradeNo();

  const sellerSignature = generateSellerSignature({
    amount,
    currency: CURRENCY,
    goods_name: goodsName,
    out_trade_no: outTradeNo,
    pay_before: payBefore,
    resource_id: resourceId,
    seller_id: cfg.sellerId,
    service_id: cfg.serviceId,
  }, cfg.privateKey);

  // 交付物随订单落库（预检已拿到直链；敏感字段只进 sqlite 与已验付交付响应）
  a2mOrders.createPending({
    outTradeNo, resourceId, shareUrl, goodsName, amount, currency: CURRENCY,
    payBefore, payBeforeAt: Math.floor(payBeforeDate.getTime() / 1000),
    deliverable: {
      share_url: shareUrl,
      title: pre.title || 'sph_video',
      author: pre.author || '',
      cdn_url: pre.cdnUrl,
      file_size: pre.fileSize,
      duration_s: pre.durationS ?? null,
      width: pre.width ?? null,
      height: pre.height ?? null,
    },
  });

  const paymentNeeded = buildPaymentNeeded({
    bill: { outTradeNo, amount, currency: CURRENCY, resourceId, payBefore, sellerSignature, sellerId: cfg.sellerId, appId: cfg.appId, goodsName, serviceId: cfg.serviceId },
    sellerName: cfg.sellerName,
  });
  res.set('Payment-Needed', encodePaymentNeeded(paymentNeeded));
  return res.status(402).json(paymentNeededBodySchema.parse({
    code: 'Payment-Needed',
    message: '需要支付：请通过 Payment-Needed Header 完成智能体支付后携带 Payment-Proof 重试',
    out_trade_no: outTradeNo,
    amount,
    currency: CURRENCY,
    goods_name: goodsName,
    resource_id: resourceId,
    pay_before: payBefore,
  }));
}

/** 带 Proof：严格验付 → 幂等履约 → 确认 → 交付。任一校验失败 → 402 重新出账单 */
async function verifyAndDeliver(req, res, { proof, resourceId, shareUrl }) {
  let alipay;
  try {
    alipay = loadAlipayConfig();
  } catch (e) {
    if (e instanceof A2MConfigError) return res.status(503).json({ error: 'a2m_not_configured', message: e.message });
    throw e;
  }

  const parsed = parsePaymentProof(proof);
  if (!parsed) {
    console.error('[a2m] Payment-Proof 解析失败，按未支付处理');
    return issuePaymentNeeded(res, { resourceId, shareUrl });
  }
  const { paymentProof, tradeNo, clientSession } = parsed;

  // 1) 平台验付（SDK；签名/验签由 SDK 用已校验配置完成）
  const v = await verifyAgentPayment({ paymentProof, tradeNo, clientSession });
  if (!v.ok) {
    console.error(`[a2m] 验付失败 outTradeNo=${v.outTradeNo || '-'}: code=${v.code || '-'}`);
    return issuePaymentNeeded(res, { resourceId, shareUrl });
  }

  // 2) 本地订单匹配（沙箱精确模式允许响应缺字段时回退本地/Proof 值，与 skill 示例一致）
  const order = v.outTradeNo ? a2mOrders.get(v.outTradeNo) : null;
  const sandboxMode = isExactSandboxMode(alipay);
  const verifyTradeNo = v.tradeNo || (sandboxMode ? tradeNo : '');
  const verifyAmount = v.amount || (sandboxMode && order ? order.amount : '');
  const resourceIdVerified = v.resourceId || (sandboxMode && order ? order.resource_id : '');

  // 3) 严格校验：active、单号一致、资源一致（响应=订单=当前请求）、金额一致、状态可用
  //    PENDING_PAYMENT 即未过期（get 懒过期）；PENDING_CONFIRM/FULFILLED 只重试确认或回放结果
  const amountMatches = order && amountsEqual(order.amount, verifyAmount);
  const resourceMatches = order && order.resource_id === resourceIdVerified && resourceIdVerified === resourceId;
  const orderUsable = order && order.currency === CURRENCY
    && ['PENDING_PAYMENT', 'PAID', 'PENDING_CONFIRM', 'FULFILLED'].includes(order.status);

  if (v.active !== true || !verifyTradeNo || verifyTradeNo !== tradeNo || !v.outTradeNo
    || !resourceIdVerified || !amountMatches || !resourceMatches || !orderUsable) {
    console.error(`[a2m] 支付凭证无效或已过期 outTradeNo=${v.outTradeNo || '-'} active=${v.active}`);
    return issuePaymentNeeded(res, { resourceId, shareUrl });
  }

  // 4) 绑定 trade_no（UNIQUE 全表防重复履约；同单同号幂等）
  const bind = a2mOrders.bindTrade(v.outTradeNo, verifyTradeNo);
  if (bind === 'trade_mismatch' || bind === 'trade_reused' || bind === 'unpayable') {
    console.error(`[a2m] trade_no 绑定拒绝 outTradeNo=${v.outTradeNo}: ${bind}`);
    return issuePaymentNeeded(res, { resourceId, shareUrl });
  }

  // 5) 交付物落位 → PENDING_CONFIRM（幂等；缺交付物说明订单异常，明确失败不猜）
  const row = a2mOrders.prepareDeliverable(v.outTradeNo);
  if (!row || !['PENDING_CONFIRM', 'FULFILLED'].includes(row.status) || !row.deliverable) {
    throw new Error(`a2m 订单 ${v.outTradeNo} 交付物缺失或状态异常（${row?.status ?? 'null'}）`);
  }
  const deliverable = JSON.parse(row.deliverable);

  // 6) 幂等重放：已确认完成的订单直接回放已保存结果；产物流水线幂等续跑/触发（客户端轮询即重放）
  if (row.status === 'FULFILLED') {
    ensurePipeline(v.outTradeNo, deliverable);
    return sendDelivered(res, resourceId, v.outTradeNo, verifyTradeNo, deliverable, true);
  }

  // 7) 履约确认（失败允许同一 Proof 重试：订单停在 PENDING_CONFIRM）
  const confirmed = await confirmAgentFulfillment(verifyTradeNo);
  if (!confirmed) {
    return res.status(502).json({
      code: 'FULFILLMENT_CONFIRM_FAILED',
      message: '资源已生成但履约确认失败，请稍后使用同一 Payment-Proof 重试',
    });
  }
  a2mOrders.markFulfilled(v.outTradeNo);
  console.log(`[a2m] 履约完成 outTradeNo=${v.outTradeNo} tradeNo=${verifyTradeNo}`);
  ensurePipeline(v.outTradeNo, deliverable); // 音频/ASR 产物异步流水线（不阻塞交付响应）

  return sendDelivered(res, resourceId, v.outTradeNo, verifyTradeNo, deliverable, false);
}

function sendDelivered(res, resourceId, outTradeNo, tradeNo, deliverable, alreadyFulfilled) {
  res.set('Payment-Validation', base64UrlEncode(JSON.stringify({
    trade_no: tradeNo,
    out_trade_no: outTradeNo,
    validated: true,
    resource_id: resourceId,
  })));
  return res.json(deliveredBodySchema.parse({
    resource_id: resourceId,
    out_trade_no: outTradeNo,
    trade_no: tradeNo,
    already_fulfilled: alreadyFulfilled,
    fulfillment_confirmed: true,
    // artifacts（audio/transcript）状态随重放实时合并：客户端轮询同一 Proof 到终态
    content: { ...deliverable, ...(artifactState(outTradeNo) ?? {}), generated_at: formatISO8601WithTimezone(new Date()) },
  }));
}
