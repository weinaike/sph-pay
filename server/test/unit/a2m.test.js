import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

// ⚠️ 必须在 import db.js 之前定死测试库路径（db 模块 import 时即建库）
process.env.DB_PATH = `/tmp/sph-pay-a2m-test-${process.pid}.db`;
const { db, a2mOrders } = await import('../../src/db.js');
const { config } = await import('../../src/config.js');
const {
  base64UrlEncode, base64UrlDecode, normalizeAmount, amountsEqual, centsToYuan,
  formatAlipayTimestamp, formatISO8601WithTimezone,
  generateSellerSignature, verifySellerSignature, buildPaymentNeeded, encodePaymentNeeded, parsePaymentProof,
  SANDBOX_SERVICE_ID,
} = await import('../../src/a2m/protocol.js');
const { loadAlipayConfig, resetAlipayConfigCache, isExactSandboxMode, A2MConfigError } = await import('../../src/a2m/config.js');

before(() => {
  assert.equal(config.a2m.priceCents, config.priceCents);
});

after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在即忽略 */ }
  }
});

// ---------- 协议纯函数 ----------

test('base64url 往返（含 + / = 字符）', () => {
  const s = JSON.stringify({ a: 'a+b/c=d', n: 123 });
  const enc = base64UrlEncode(s);
  assert.ok(!/[+/=]/.test(enc));
  assert.equal(base64UrlDecode(enc), s);
});

test('金额归一化与相等比较', () => {
  assert.equal(normalizeAmount('1'), '1.00');
  assert.equal(normalizeAmount('1.0'), '1.00');
  assert.equal(normalizeAmount('1.5'), '1.50');
  assert.equal(normalizeAmount('0.01'), '0.01');
  assert.equal(normalizeAmount('1.999'), null);
  assert.equal(normalizeAmount('-1'), null);
  assert.equal(normalizeAmount('abc'), null);
  assert.ok(amountsEqual('1', '1.00'));
  assert.ok(amountsEqual('0.01', '0.010'.slice(0, 4)));
  assert.ok(!amountsEqual('1.00', '1.01'));
  assert.equal(centsToYuan(100), '1.00');
  assert.equal(centsToYuan(1), '0.01');
  assert.equal(centsToYuan(3050), '30.50');
});

test('时间戳格式：支付宝 yyyy-MM-dd HH:mm:ss 与 pay_before ISO8601 带时区', () => {
  const d = new Date('2026-05-15T12:08:36+08:00');
  assert.match(formatAlipayTimestamp(d), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(!formatAlipayTimestamp(d).includes('T'));
  const iso = formatISO8601WithTimezone(d);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('商家签名：字典序拼接 + RSA2 可被公钥验签；缺字段拒绝', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privB64 = privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const bill = {
    amount: '1.00', currency: 'CNY', goods_name: '视频号视频直链解析', out_trade_no: 'a2m_test_001',
    pay_before: '2026-05-15T12:38:36+08:00', resource_id: '/api/a2m/resolve?url=https://weixin.qq.com/sph/abc',
    seller_id: '2088000000000000', service_id: SANDBOX_SERVICE_ID,
  };
  const sig = generateSellerSignature(bill, privB64);
  assert.ok(sig.length > 0);
  assert.ok(verifySellerSignature(bill, pubB64, sig));
  // 篡改任一字段验签失败（字典序与内容都参与）
  assert.ok(!verifySellerSignature({ ...bill, amount: '2.00' }, pubB64, sig));
  // 缺字段直接抛错（不静默出无签名账单）
  assert.throws(() => generateSellerSignature({ ...bill, service_id: '' }, privB64), /缺少签名字段/);
});

test('Payment-Needed 账单必含字段（protocol/method）', () => {
  const bill = {
    outTradeNo: 'a2m_x', amount: '1.00', currency: 'CNY', resourceId: '/r', payBefore: '2026-05-15T12:38:36+08:00',
    sellerSignature: 'sig', sellerId: '2088', appId: '9021', goodsName: 'g', serviceId: SANDBOX_SERVICE_ID,
  };
  const pn = buildPaymentNeeded({ bill, sellerName: 'sph-pay' });
  for (const k of ['out_trade_no', 'amount', 'currency', 'resource_id', 'pay_before', 'seller_signature', 'seller_sign_type', 'seller_unique_id']) {
    assert.ok(pn.protocol[k] !== undefined, `protocol 缺 ${k}`);
  }
  for (const k of ['seller_name', 'seller_id', 'seller_app_id', 'goods_name', 'seller_unique_id_key', 'service_id']) {
    assert.ok(pn.method[k] !== undefined, `method 缺 ${k}`);
  }
  assert.equal(pn.method.seller_unique_id_key, 'seller_id');
  const enc = encodePaymentNeeded(pn);
  assert.ok(!/[+/=]/.test(enc));
  assert.deepEqual(JSON.parse(base64UrlDecode(enc)), pn);
});

test('Payment-Proof 解析：合法/缺字段/坏 JSON', () => {
  const good = base64UrlEncode(JSON.stringify({
    protocol: { payment_proof: 'PROOF_ABC', trade_no: '202609220001' },
    method: { client_session: 'sess-1' },
  }));
  const parsed = parsePaymentProof(good);
  assert.equal(parsed.paymentProof, 'PROOF_ABC');
  assert.equal(parsed.tradeNo, '202609220001');
  assert.equal(parsed.clientSession, 'sess-1');
  // client_session 可选
  const noSession = parsePaymentProof(base64UrlEncode(JSON.stringify({
    protocol: { payment_proof: 'P', trade_no: 'T' }, method: {},
  })));
  assert.equal(noSession.clientSession, undefined);
  // 缺 payment_proof / 缺 trade_no / 坏 Base64 → null（按未支付处理）
  assert.equal(parsePaymentProof(base64UrlEncode(JSON.stringify({ protocol: { trade_no: 'T' } }))), null);
  assert.equal(parsePaymentProof(base64UrlEncode(JSON.stringify({ protocol: { payment_proof: 'P' } }))), null);
  assert.equal(parsePaymentProof('!!!not-base64!!!'), null);
});

// ---------- 订单仓储与幂等状态机 ----------

const mkOrder = (id, opts = {}) => a2mOrders.createPending({
  outTradeNo: id, resourceId: `/api/a2m/resolve?url=https://weixin.qq.com/sph/${id}`,
  shareUrl: `https://weixin.qq.com/sph/${id}`, goodsName: '视频号视频直链解析：t',
  amount: '1.00', currency: 'CNY',
  payBefore: opts.payBefore || '2026-05-15T12:38:36+08:00',
  payBeforeAt: opts.payBeforeAt ?? Math.floor(Date.now() / 1000) + 900,
  deliverable: { share_url: 'https://weixin.qq.com/sph/x', title: 't', cdn_url: 'https://cdn/x.mp4', file_size: 1 },
});

test('A2M 订单状态机：bindTrade → prepareDeliverable → markFulfilled 全链幂等', () => {
  mkOrder('a2m_sm_1');
  assert.equal(a2mOrders.get('a2m_sm_1').status, 'PENDING_PAYMENT');
  assert.equal(a2mOrders.bindTrade('a2m_sm_1', 'TRADE_1'), 'bound');
  assert.equal(a2mOrders.get('a2m_sm_1').status, 'PAID');
  assert.equal(a2mOrders.bindTrade('a2m_sm_1', 'TRADE_1'), 'idempotent'); // 同单同号重试
  assert.equal(a2mOrders.bindTrade('a2m_sm_1', 'TRADE_OTHER'), 'trade_mismatch'); // 同单不同号拒绝

  const row = a2mOrders.prepareDeliverable('a2m_sm_1');
  assert.equal(row.status, 'PENDING_CONFIRM');
  assert.ok(JSON.parse(row.deliverable).cdn_url);
  assert.equal(a2mOrders.prepareDeliverable('a2m_sm_1').status, 'PENDING_CONFIRM'); // 幂等

  a2mOrders.markFulfilled('a2m_sm_1');
  assert.equal(a2mOrders.get('a2m_sm_1').status, 'FULFILLED');
  a2mOrders.markFulfilled('a2m_sm_1'); // 幂等不抛
  assert.equal(a2mOrders.get('a2m_sm_1').status, 'FULFILLED');
  // 完成态不再被新 trade 绑定
  assert.equal(a2mOrders.bindTrade('a2m_sm_1', 'TRADE_2'), 'trade_mismatch');
});

test('trade_no 全表唯一：同一平台交易号不可履约两单', () => {
  mkOrder('a2m_dup_1');
  mkOrder('a2m_dup_2');
  assert.equal(a2mOrders.bindTrade('a2m_dup_1', 'TRADE_DUP'), 'bound');
  assert.equal(a2mOrders.bindTrade('a2m_dup_2', 'TRADE_DUP'), 'trade_reused');
  // 第一单不受影响，仍可完成
  assert.equal(a2mOrders.prepareDeliverable('a2m_dup_1').status, 'PENDING_CONFIRM');
});

test('未付订单按 pay_before 懒过期；PAID/确认态永不过期', () => {
  mkOrder('a2m_exp_1', { payBeforeAt: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(a2mOrders.get('a2m_exp_1').status, 'EXPIRED');
  assert.equal(a2mOrders.bindTrade('a2m_exp_1', 'TRADE_EXP'), 'unpayable'); // 过期不可再支付

  mkOrder('a2m_exp_2'); // 先在有效期内支付绑定
  a2mOrders.bindTrade('a2m_exp_2', 'TRADE_EXP2');
  // 之后到期（先 PAID 后过线）：get 不回收
  db.prepare(`UPDATE a2m_orders SET pay_before_at=? WHERE out_trade_no=?`)
    .run(Math.floor(Date.now() / 1000) - 1, 'a2m_exp_2');
  assert.equal(a2mOrders.get('a2m_exp_2').status, 'PAID');
  a2mOrders.prepareDeliverable('a2m_exp_2');
  assert.equal(a2mOrders.get('a2m_exp_2').status, 'PENDING_CONFIRM'); // 确认态同样不回收
});

// ---------- 配置加载 ----------

test('沙箱配置加载：字段映射（Node.js 取 PKCS#1）与精确沙箱模式；缺失即 A2MConfigError', () => {
  const tmp = `/tmp/sph-pay-a2m-cfg-${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify({
    appIds: [{ appId: '9021000000000000', appPrivateKey: 'PKCS8', appPrivatePkcsKey: 'PKCS1_RAW', appPublicKey: 'PUB', alipayPublicKey: 'ALIPAY_PUB' }],
    sandboxAccounts: { partner: { userId: '2088000000000001' }, user: { userId: 'u', email: 'e', logonPassword: 'x', payPassword: 'y' } },
  }));
  process.env.ALIPAY_A2M_SANDBOX_CONFIG = tmp;
  delete process.env.ALIPAY_GATEWAY;
  resetAlipayConfigCache();
  const cfg = loadAlipayConfig();
  assert.equal(cfg.appId, '9021000000000000');
  assert.equal(cfg.privateKey, 'PKCS1_RAW'); // 非 Java 必须取 appPrivatePkcsKey 原始值
  assert.equal(cfg.alipayPublicKey, 'ALIPAY_PUB');
  assert.equal(cfg.sellerId, '2088000000000001');
  assert.equal(cfg.serviceId, SANDBOX_SERVICE_ID);
  assert.ok(cfg.sandbox);
  assert.ok(isExactSandboxMode(cfg));

  // 文件缺失 → 明确错误（不回退示例值）
  process.env.ALIPAY_A2M_SANDBOX_CONFIG = '/tmp/sph-pay-a2m-not-exist.json';
  resetAlipayConfigCache();
  assert.throws(() => loadAlipayConfig(), A2MConfigError);
  delete process.env.ALIPAY_A2M_SANDBOX_CONFIG;
  fs.unlinkSync(tmp);
});
