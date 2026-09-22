import crypto from 'node:crypto';

/** 订单号：sph_ + base36 时间戳(12) + _ + hex(16) → 总长 4+12+1+16=33，微信 out_trade_no 上限 32，压缩 hex 到 15 */
export function newOrderId() {
  const ts = Date.now().toString(36).padStart(12, '0').slice(-12);
  const rand = crypto.randomBytes(8).toString('hex').slice(0, 15);
  return `sph_${ts}_${rand}`; // 4+12+1+15 = 32
}

/** 订单 capability token（128bit） */
export function newOrderToken() {
  return crypto.randomBytes(16).toString('hex');
}

export const refundNoFor = (orderId) => `rf_${orderId}`.slice(0, 64);

/** 批量解析任务 id：可读前缀 + 时间戳 + 随机段（无微信侧长度约束） */
export function newBatchId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `bat_${ts}_${rand}`;
}

/** AI 按量付费（A2M）商户订单号（支付宝 out_trade_no，上限 64 字符） */
export function newA2mTradeNo() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(10).toString('hex');
  return `a2m_${ts}_${rand}`; // 4+11+1+20 = 36
}
