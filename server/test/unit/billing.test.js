import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ⚠️ 必须在 import db.js 之前定死测试库路径（db 模块 import 时即建库）
process.env.DB_PATH = `/tmp/sph-pay-billing-test-${process.pid}.db`;
const { db, orders, users, usageLog } = await import('../../src/db.js');
const { config } = await import('../../src/config.js');

before(() => {
  assert.equal(config.packages.A.cents, 500);
  assert.equal(config.packages.B.linkQuota, 100);
  assert.equal(config.packages.B.searchCredits, 10);
  assert.equal(config.packages.C.linkQuota, 200);
  assert.equal(config.packages.C.searchCredits, 20);
});

after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在即忽略 */ }
  }
});

const newUser = (name) => {
  const token = `tok_${name}`;
  users.create(token);
  return token;
};

const newPackageOrder = (id, pkg, userToken) => {
  orders.create({
    id, token: `t_${id}`, contentId: `package:${pkg}`,
    kind: 'package', pkg, userToken,
    amountCents: config.packages[pkg].cents, expireAt: Math.floor(Date.now() / 1000) + 900,
  });
};

test('套餐支付落账：余额入账 + 直落 credited + 台账', () => {
  const u = newUser('pkg_b');
  newPackageOrder('ord_pkg_b', 'B', u);
  const applied = orders.markPaidAndApply('ord_pkg_b', 'TXN_B');
  assert.equal(applied.kind, 'package');
  assert.equal(applied.userToken, u);

  const user = users.get(u);
  assert.equal(user.link_quota, 100);
  assert.equal(user.search_credits, 10);
  assert.equal(user.total_paid_cents, 3000);

  assert.equal(orders.get('ord_pkg_b').status, 'credited');
  // 已购列表
  const purchases = users.listPurchases(u);
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].package, 'B');
  // 台账 purchase 行
  assert.ok(usageLog.chargedSince('purchase', 'package:B', u, 0));
});

test('幂等：重复落账（回调重发/查单并发）只入账一次', () => {
  const u = newUser('pkg_idem');
  newPackageOrder('ord_idem', 'C', u);
  assert.ok(orders.markPaidAndApply('ord_idem', 'TXN_1'));
  assert.equal(orders.markPaidAndApply('ord_idem', 'TXN_2'), null); // 重复

  const user = users.get(u);
  assert.equal(user.link_quota, 200);       // 不翻倍
  assert.equal(user.search_credits, 20);
  assert.equal(user.total_paid_cents, 5000);
  assert.equal(users.listPurchases(u).length, 1);
});

test('video 订单落账不动余额、状态停在 paid', () => {
  const u = newUser('video');
  orders.create({
    id: 'ord_video', token: 't_v', contentId: 'AzGEWrdqgP##1',
    shareUrl: 'https://weixin.qq.com/sph/AzGEWrdqgP',
    amountCents: config.priceCents, expireAt: Math.floor(Date.now() / 1000) + 900,
  });
  const applied = orders.markPaidAndApply('ord_video', 'TXN_V');
  assert.equal(applied.kind, 'video');
  assert.equal(orders.get('ord_video').status, 'paid');
  const user = users.get(u);
  assert.equal(user.link_quota, 0); // 未挂任何套餐
});

test('未知订单/过期订单落账返回 null', () => {
  assert.equal(orders.markPaidAndApply('ord_missing', 'TXN'), null);
  newPackageOrder('ord_expired', 'A', newUser('expired'));
  orders.markExpired('ord_expired');
  assert.equal(orders.markPaidAndApply('ord_expired', 'TXN'), null); // expired 非 pending
  assert.equal(orders.get('ord_expired').status, 'expired');
});

test('直链额度原子扣减：不越零、不足即败', () => {
  const u = newUser('quota');
  db.prepare('UPDATE users SET link_quota=3 WHERE user_token=?').run(u);
  const results = Array.from({ length: 5 }, () => users.consumeLinkQuota(u));
  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(users.get(u).link_quota, 0); // 永不负数
  users.refundLinkQuota(u);
  assert.equal(users.get(u).link_quota, 1);
});

test('百条检索机会原子扣减：不越零、不足即败', () => {
  const u = newUser('credit');
  db.prepare('UPDATE users SET search_credits=1 WHERE user_token=?').run(u);
  assert.ok(users.consumeSearchCredit(u));
  assert.ok(!users.consumeSearchCredit(u));
  assert.equal(users.get(u).search_credits, 0);
  users.refundSearchCredit(u);
  assert.equal(users.get(u).search_credits, 1);
});

test('扣费去重窗口：chargedSince 按 用户×目标×时间 过滤，返还后失效', () => {
  const u1 = newUser('dedup1');
  const u2 = newUser('dedup2');
  const target = 'https://weixin.qq.com/sph/AbCdEf1234';
  const nowS = Math.floor(Date.now() / 1000);

  assert.ok(!usageLog.chargedSince('resolve', target, u1, nowS - 86400)); // 无记录
  const logId = usageLog.insert({ userToken: u1, kind: 'resolve', target });
  assert.ok(usageLog.chargedSince('resolve', target, u1, nowS - 86400));  // 24h 内已扣
  assert.ok(!usageLog.chargedSince('resolve', target, u2, nowS - 86400)); // 别的用户不算
  assert.ok(!usageLog.chargedSince('resolve', target, u1, nowS + 10));    // 窗口起点晚于记录

  usageLog.markRefunded(logId);
  assert.ok(!usageLog.chargedSince('resolve', target, u1, nowS - 86400)); // 已返还不再免重扣
});
