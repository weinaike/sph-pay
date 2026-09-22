import { AlipaySdk } from 'alipay-sdk';
import { loadAlipayConfig, isExactSandboxMode } from './config.js';

/**
 * A2M 支付宝 SDK 封装：验付 alipay.aipay.agent.payment.verify 与
 * 履约确认 alipay.aipay.agent.fulfillment.confirm。
 * 导入方式按本项目实际安装的 alipay-sdk@4（ESM，命名导出 AlipaySdk）类型定义确定。
 * 私钥直接使用已校验配置原始值（PKCS#1），SDK 自行包装，不做格式加工。
 */

let sdk = null;

export function getAlipaySdk() {
  if (sdk) return sdk;
  const cfg = loadAlipayConfig();
  sdk = new AlipaySdk({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    alipayPublicKey: cfg.alipayPublicKey,
    gateway: cfg.gateway,
    timeout: 30_000,
  });
  return sdk;
}

/** 测试用：重置懒加载单例 */
export function resetAlipaySdk() {
  sdk = null;
}

/** 兼容 SDK 驼峰转换：响应可能是嵌套 envelope，也可能是扁平业务字段 */
function pickBiz(response, envelopeKey) {
  const nested = response?.[envelopeKey];
  return nested && typeof nested === 'object' ? nested : response;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只读接口的瞬时错误重试（HTTP 404/5xx 沙箱网关抖动）：最多 3 次，间隔 1s/2s */
async function execWithRetry(method, params, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await getAlipaySdk().exec(method, params);
    } catch (e) {
      lastErr = e;
      const transient = /status: (404|5\d\d)|HttpClient Request error|timeout|ECONNRESET|EAI_AGAIN/.test(String(e.message));
      if (!transient || i === attempts) throw e;
      console.warn(`[a2m] ${method} 瞬时错误（第 ${i}/${attempts} 次）：${e.message}，退避重试`);
      await sleep(i * 1000);
    }
  }
  throw lastErr;
}

/**
 * 验付：入参 payment_proof + trade_no（+可选 client_session）。
 * 返回归一化结果 { code, ok, tradeNo, outTradeNo, amount, resourceId, active }；
 * 沙箱精确模式下响应缺字段允许回退本地值（与 skill 示例一致），生产缺字段视为无效。
 * verify 是只读调用：沙箱网关对 agent 方法存在间歇 404/5xx 抖动，短暂退避重试（不放大写副作用）。
 */
export async function verifyAgentPayment({ paymentProof, tradeNo, clientSession, fallbackOrder = null }) {
  const bizContent = { payment_proof: paymentProof, trade_no: tradeNo };
  if (clientSession) bizContent.client_session = clientSession;

  const response = await execWithRetry('alipay.aipay.agent.payment.verify', { bizContent });
  const d = pickBiz(response, 'alipay_aipay_agent_payment_verify_response');
  const code = d.code !== undefined ? String(d.code) : '';
  const sandboxMode = isExactSandboxMode(loadAlipayConfig());
  return {
    code,
    ok: code === '10000',
    tradeNo: d.trade_no || d.tradeNo || (sandboxMode && fallbackOrder ? tradeNo : ''),
    outTradeNo: d.out_trade_no || d.outTradeNo || '',
    amount: d.amount || (sandboxMode && fallbackOrder ? fallbackOrder.amount : ''),
    resourceId: d.resource_id || d.resourceId || (sandboxMode && fallbackOrder ? fallbackOrder.resource_id : ''),
    active: d.active,
  };
}

/** 履约确认：入参仅 trade_no；成功返回 true，业务失败/异常返回 false（可用同一 Proof 重试） */
export async function confirmAgentFulfillment(tradeNo) {
  if (!tradeNo) return false;
  try {
    const response = await getAlipaySdk().exec('alipay.aipay.agent.fulfillment.confirm', {
      bizContent: { trade_no: tradeNo },
    });
    const d = pickBiz(response, 'alipay_aipay_agent_fulfillment_confirm_response');
    return String(d.code) === '10000';
  } catch (e) {
    console.error(`[a2m] 履约确认异常 tradeNo=${tradeNo}: ${e.message}`);
    return false;
  }
}
