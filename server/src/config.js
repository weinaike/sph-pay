import 'dotenv/config';
import fs from 'node:fs';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

export const config = {
  port: num(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH || './data/orders.db',
  priceCents: num(process.env.PRICE_CENTS, 199),
  orderTtlSeconds: num(process.env.ORDER_TTL_SECONDS, 900),
  adminToken: process.env.ADMIN_TOKEN || '',
  sph: {
    // 自有解析服务（wx_channels_download sph-api 公开 API）
    base: process.env.SPH_BASE || 'https://sph.yes-tek.com',
    requestTimeoutMs: num(process.env.SPH_REQUEST_TIMEOUT_MS, 10_000),
    pollIntervalMs: num(process.env.SPH_POLL_INTERVAL_MS, 1_500),
    resolveTimeoutMs: num(process.env.SPH_RESOLVE_TIMEOUT_MS, 90_000),
  },
  wx: {
    appid: process.env.WX_APPID || '',
    mchid: process.env.WX_MCHID || '',
    serial: process.env.WX_SERIAL || '',
    privateKey: (() => {
      const p = process.env.WX_PRIVATE_KEY_PATH;
      if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      return process.env.WX_PRIVATE_KEY || '';
    })(),
    apiV3Key: process.env.WX_APIV3KEY || '',
    notifyUrl: process.env.WX_NOTIFY_URL || '',
    // 微信支付公钥模式（2024后新商户默认）：公钥用于验签微信应答/回调
    pubKeyId: process.env.WX_PUB_KEY_ID || '',
    pubKey: (() => {
      const p = process.env.WX_PUB_KEY_PATH;
      if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      return process.env.WX_PUB_KEY || '';
    })(),
  },
};

/** 启动时校验微信必填项，缺失即 fail-fast */
export function validateConfig() {
  const missing = Object.entries({
    WX_APPID: config.wx.appid,
    WX_MCHID: config.wx.mchid,
    WX_SERIAL: config.wx.serial,
    WX_PRIVATE_KEY_OR_PATH: config.wx.privateKey,
    WX_APIV3KEY: config.wx.apiV3Key,
    WX_NOTIFY_URL: config.wx.notifyUrl,
    WX_PUB_KEY_OR_PATH: config.wx.pubKey,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`缺少微信支付配置: ${missing.join(', ')}`);
  }
  if (config.wx.apiV3Key.length !== 32) throw new Error('WX_APIV3KEY 必须为 32 字符');
  if (!config.wx.pubKeyId) {
    console.warn('[config] 未配置 WX_PUB_KEY_ID：微信支付公钥模式下回调验签将失败'
      + '（商户平台 → 账户中心 → API安全 → 微信支付公钥 → 公钥ID，形如 PUB_KEY_ID_01...）');
  }
}
