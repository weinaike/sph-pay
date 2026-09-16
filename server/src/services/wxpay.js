import WxPay from 'wechatpay-node-v3';
import { config } from '../config.js';

/** 微信支付 APIv3 封装（Native 扫码）。MOCK_PAY 模式下此类不应被调用。 */
let pay = null;

export function wxpay() {
  if (!pay) {
    pay = new WxPay({
      appid: config.wx.appid,
      mchid: config.wx.mchid,
      publicKey: config.wx.pubKey,      // 微信支付公钥（公钥模式）；SDK 构造器要求非空
      privateKey: config.wx.privateKey,
      key: config.wx.apiV3Key,
      serial_no: config.wx.serial,      // 商户API证书序列号（请求签名用，与公钥无关）
    });
    // 公钥模式：平台证书接口不下发证书，回调 Wechatpay-Serial = 公钥ID（PUB_KEY_ID_..）。
    // 预置 SDK 静态验签表，verifySign 直接命中，否则 SDK 拉 /v3/certificates 拿不到东西必抛错。
    if (config.wx.pubKeyId) {
      WxPay.certificates[config.wx.pubKeyId] = config.wx.pubKey;
    }
  }
  return pay;
}

/** Native 下单 → code_url。time_expire 由调用方统一计算，保证与本地 expire_at 同源 */
export async function createNativeOrder({ orderId, amountCents, description, timeExpire }) {
  const r = await wxpay().transactions_native({
    description,
    out_trade_no: orderId,
    notify_url: config.wx.notifyUrl,
    amount: { total: amountCents, currency: 'CNY' },
    time_expire: timeExpire, // RFC3339
  });
  if (r.status !== 200 || !r.code_url) {
    throw new Error(`微信下单失败: ${JSON.stringify(r).slice(0, 300)}`);
  }
  return r.code_url;
}

/** 回调验签：必须传 raw body 字符串 */
export async function verifyNotify({ timestamp, nonce, body, serial, signature }) {
  return wxpay().verifySign({ timestamp, nonce, body, serial, signature });
}

/** 回调 resource 解密（AES-256-GCM, key=APIv3Key） */
export function decryptResource({ ciphertext, nonce, associated_data }) {
  return wxpay().decipher_gcm(ciphertext, API_V3_KEY(), nonce, associated_data);
}
const API_V3_KEY = () => config.wx.apiV3Key;

/** 主动查单（对账兜底） */
export async function queryOrder(orderId) {
  const r = await wxpay().query({ out_trade_no: orderId });
  return r.status === 200 ? r : null;
}

/** 关单 */
export async function closeOrder(orderId) {
  try { await wxpay().close(orderId); } catch { /* 已关/已付时忽略 */ }
}

/** 全额退款（out_refund_no 固定保证幂等） */
export async function refundOrder(orderId, amountCents) {
  const r = await wxpay().refunds({
    out_trade_no: orderId,
    out_refund_no: `rf_${orderId}`.slice(0, 64),
    amount: { refund: amountCents, total: amountCents, currency: 'CNY' },
  });
  return r; // status 200 = 受理成功
}
