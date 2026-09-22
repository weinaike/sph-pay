import crypto from 'node:crypto';

/**
 * AI 按量付费（A2M）协议纯函数层：账单构造/商家签名/Proof 解析。
 * 依据 alipay-aipay skill 本地契约（aipay-interface-contract.md）：
 * - 402 + Payment-Needed Header（Base64URL 账单），响应体仅调试用
 * - 商家签名字段按 key 字典序拼接：amount/currency/goods_name/out_trade_no/
 *   pay_before/resource_id/seller_id/service_id，RSA2 本地签名（不请求支付宝）
 * - Payment-Proof 解码后取 protocol.payment_proof / protocol.trade_no /
 *   method.client_session（可选）
 */

export const SELLER_SIGN_TYPE = 'RSA2';
export const CURRENCY = 'CNY';
export const SANDBOX_SERVICE_ID = 'api_mock_service_id'; // 仅沙箱；生产换服务市场真实 serviceId
export const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
export const PROD_GATEWAY = 'https://openapi.alipay.com/gateway.do';

/** 参与商家签名的账单字段（字典序即此顺序） */
const SIGN_FIELDS = ['amount', 'currency', 'goods_name', 'out_trade_no', 'pay_before', 'resource_id', 'seller_id', 'service_id'];

export function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(str) {
  let s = String(str);
  const pad = (4 - (s.length % 4)) % 4;
  if (pad) s += '='.repeat(pad);
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64').toString('utf8');
}

/** 支付宝时间戳：yyyy-MM-dd HH:mm:ss（禁 ISO） */
export function formatAlipayTimestamp(date = new Date()) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** pay_before 格式：ISO 8601 带时区偏移（如 2026-05-15T12:08:36+08:00） */
export function formatISO8601WithTimezone(date = new Date()) {
  const pad = (n) => n.toString().padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const offsetSign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T`
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offsetSign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** 金额归一化："1" / "1.0" / "1.00" → "1.00"；非法返回 null */
export function normalizeAmount(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return `${BigInt(match[1]).toString()}.${(match[2] || '').padEnd(2, '0')}`;
}

export function amountsEqual(left, right) {
  const l = normalizeAmount(left);
  const r = normalizeAmount(right);
  return l !== null && r !== null && l === r;
}

/** 分 → 元字符串（100 → "1.00"） */
export function centsToYuan(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * 商家签名（seller_signature）：字段按 key 字典序 `k=v` 以 & 拼接后 RSA-SHA256 签名。
 * 私钥为已校验配置中的原始 PKCS#1 Base64 字符串——仅在此按 Node 密码库要求临时构造
 * 密钥对象（skill 允许的调用边界），不写回/不修改任何配置。
 */
export function generateSellerSignature(params, privateKeyBase64Pkcs1) {
  const missing = SIGN_FIELDS.filter((k) => params[k] === undefined || params[k] === null || params[k] === '');
  if (missing.length) throw new Error(`账单缺少签名字段: ${missing.join(',')}`);
  const signContent = SIGN_FIELDS.map((k) => `${k}=${params[k]}`).join('&');
  const keyObject = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64Pkcs1, 'base64'),
    format: 'der',
    type: 'pkcs1',
  });
  return crypto.createSign('RSA-SHA256').update(signContent, 'utf8').sign(keyObject, 'base64');
}

/** 用商家公钥验证 seller_signature（单测用；公钥与私钥同源时可通过） */
export function verifySellerSignature(params, publicKeyBase64Spki, signature) {
  const signContent = SIGN_FIELDS.map((k) => `${k}=${params[k]}`).join('&');
  const keyObject = crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64Spki, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto.createVerify('RSA-SHA256').update(signContent, 'utf8').verify(keyObject, Buffer.from(signature, 'base64'));
}

/**
 * 构造 Payment-Needed 账单对象（未编码）。protocol/method 必含字段见契约：
 * protocol: out_trade_no/amount/currency/resource_id/pay_before/seller_signature/
 *           seller_sign_type/seller_unique_id
 * method: seller_name/seller_id/seller_app_id/goods_name/seller_unique_id_key/service_id
 */
export function buildPaymentNeeded({ bill, sellerName }) {
  return {
    protocol: {
      out_trade_no: bill.outTradeNo,
      amount: bill.amount,
      currency: bill.currency,
      resource_id: bill.resourceId,
      pay_before: bill.payBefore,
      seller_signature: bill.sellerSignature,
      seller_sign_type: SELLER_SIGN_TYPE,
      seller_unique_id: bill.sellerId,
    },
    method: {
      seller_name: sellerName,
      seller_id: bill.sellerId,
      seller_app_id: bill.appId,
      goods_name: bill.goodsName,
      seller_unique_id_key: 'seller_id',
      service_id: bill.serviceId,
    },
  };
}

export function encodePaymentNeeded(paymentNeeded) {
  return base64UrlEncode(JSON.stringify(paymentNeeded));
}

/**
 * 解析 Payment-Proof Header：Base64URL JSON，取 protocol.payment_proof /
 * protocol.trade_no / method.client_session（可选）。缺 payment_proof 或 trade_no
 * 返回 null（按未支付处理，重新出账单）。
 */
export function parsePaymentProof(headerValue) {
  let proofJson;
  try {
    proofJson = JSON.parse(base64UrlDecode(headerValue));
  } catch {
    return null;
  }
  const paymentProof = proofJson?.protocol?.payment_proof;
  const tradeNo = proofJson?.protocol?.trade_no;
  const clientSession = proofJson?.method?.client_session;
  if (typeof paymentProof !== 'string' || !paymentProof.trim()) return null;
  if (typeof tradeNo !== 'string' || !tradeNo.trim()) return null;
  return {
    paymentProof: paymentProof.trim(),
    tradeNo: tradeNo.trim(),
    clientSession: typeof clientSession === 'string' && clientSession.trim() ? clientSession.trim() : undefined,
  };
}
