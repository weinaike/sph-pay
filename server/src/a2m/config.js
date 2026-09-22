import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SANDBOX_GATEWAY, SANDBOX_SERVICE_ID } from './protocol.js';

/**
 * AI 按量付费（A2M）支付宝配置加载器。
 *
 * 优先级：
 * 1. 生产：ALIPAY_APP_ID / ALIPAY_APP_PRIVATE_KEY(_PATH) / ALIPAY_PUBLIC_KEY(_PATH) /
 *    ALIPAY_SELLER_ID / ALIPAY_SERVICE_ID / ALIPAY_GATEWAY 全齐 → 生产配置
 *    （网关必须显式给出，禁止生产静默落沙箱网关）。
 * 2. 沙箱：项目根 `.alipay-sandbox.json`（skill 快速沙箱脚本创建并校验，0600）。
 *    Node.js 取 appIds[0].appPrivatePkcsKey（PKCS#1 原始值，不做任何格式加工）；
 *    seller 取 sandboxAccounts.partner.userId；service_id 固定 api_mock_service_id。
 * 3. 都没有 → 抛 A2MConfigError（路由 503，不影响微信主链路）。
 *
 * 路径锚定：沙箱文件从本模块定位项目根（import.meta.url），禁止依赖 cwd。
 */

// src/a2m/config.js → 上两级 = server/（runner 确认的项目根）
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_SANDBOX_CONFIG_PATH = `${PROJECT_ROOT}/.alipay-sandbox.json`;

export class A2MConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'A2MConfigError';
  }
}

/** 读密钥：兼容裸 Base64 与带 PEM 头尾（密钥工具复制原文或 openssl 导出均可，统一裸 Base64 输出） */
const stripPem = (s) => s.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '').replace(/\s+/g, '');

const readKeyMaybePath = (valueEnv, pathEnv) => {
  if (process.env[pathEnv] && fs.existsSync(process.env[pathEnv])) {
    return stripPem(fs.readFileSync(process.env[pathEnv], 'utf8').trim());
  }
  return stripPem((process.env[valueEnv] || '').trim());
};

let cached = null;

/** 加载并缓存 A2M 支付宝配置；不可用时抛 A2MConfigError（每次重试，便于热修配置） */
export function loadAlipayConfig() {
  if (cached) return cached;

  // ---- 生产 env 配置（全齐才启用，缺一即落沙箱/未配置分支） ----
  const prod = {
    appId: (process.env.ALIPAY_APP_ID || '').trim(),
    privateKey: readKeyMaybePath('ALIPAY_APP_PRIVATE_KEY', 'ALIPAY_APP_PRIVATE_KEY_PATH'),
    alipayPublicKey: readKeyMaybePath('ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY_PATH'),
    sellerId: (process.env.ALIPAY_SELLER_ID || '').trim(),
    serviceId: (process.env.ALIPAY_SERVICE_ID || '').trim(),
    gateway: (process.env.ALIPAY_GATEWAY || '').trim(),
  };
  const prodKeys = Object.keys(prod);
  if (prodKeys.every((k) => prod[k])) {
    if (prod.gateway === SANDBOX_GATEWAY) {
      throw new A2MConfigError('ALIPAY_GATEWAY 指向沙箱网关但配置声明为生产，禁止混用');
    }
    cached = { ...prod, sellerName: (process.env.ALIPAY_SELLER_NAME || 'sph-pay').trim(), sandbox: false };
    return cached;
  }
  if (prodKeys.some((k) => prod[k])) {
    const missing = prodKeys.filter((k) => !prod[k]);
    throw new A2MConfigError(`生产配置不完整，缺: ${missing.join(',')}（或全部留空走沙箱）`);
  }

  // ---- 沙箱配置文件 ----
  const sandboxPath = process.env.ALIPAY_A2M_SANDBOX_CONFIG || DEFAULT_SANDBOX_CONFIG_PATH;
  let raw;
  try {
    raw = fs.readFileSync(sandboxPath, 'utf8');
  } catch {
    throw new A2MConfigError(`未配置支付宝 A2M（无生产 env，沙箱配置不存在: ${sandboxPath}）`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new A2MConfigError('沙箱配置不是合法 JSON');
  }
  const app = data?.appIds?.[0];
  const sellerId = data?.sandboxAccounts?.partner?.userId;
  const required = {
    appId: app?.appId,
    appPrivatePkcsKey: app?.appPrivatePkcsKey, // Node.js 用 PKCS#1 原始值（非 Java）
    alipayPublicKey: app?.alipayPublicKey,
    sellerId,
  };
  const missing = Object.entries(required).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
  if (missing.length) throw new A2MConfigError(`沙箱配置缺少必含字段: ${missing.join(',')}`);

  cached = {
    appId: required.appId,
    privateKey: required.appPrivatePkcsKey,
    alipayPublicKey: required.alipayPublicKey,
    sellerId,
    serviceId: SANDBOX_SERVICE_ID, // 沙箱固定；生产禁用
    gateway: process.env.ALIPAY_GATEWAY || SANDBOX_GATEWAY,
    sellerName: (process.env.ALIPAY_SELLER_NAME || 'sph-pay').trim(),
    sandbox: true,
  };
  return cached;
}

/** 精确沙箱模式：沙箱网关 + 固定 mock service_id（验付响应缺字段时的兜底仅此模式允许） */
export function isExactSandboxMode(cfg) {
  return cfg.gateway === SANDBOX_GATEWAY && cfg.serviceId === SANDBOX_SERVICE_ID;
}

/** 测试用：清缓存 */
export function resetAlipayConfigCache() {
  cached = null;
}
