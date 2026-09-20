import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ⚠️ 必须在 import db.js 之前定死测试库路径
process.env.DB_PATH = `/tmp/sph-pay-finder-test-${process.pid}.db`;
const { db, users, usageLog } = await import('../../src/db.js');
const { getFinderVideos, searchTop, invalidateFinderCache, NoSearchCreditsError } = await import('../../src/finder/videos.js');
const { FinderError } = await import('../../src/finder/client.js');

const U = 'v2_test@finder';
const OTHER = 'v2_other@finder';

const mkItem = (i) => ({ object_id: `obj_${i}`, title: `视频${i}`, created_at: 1789900000 + i, duration: 60, width: 720, height: 1280, size: 1000, share_url: null });

/** 造桩上游：pages 数组按页返回；shareOk 控制短链生成成功率 */
function stubDeps({ pages, total = 100, shareOkFrom = 0 } = {}) {
  const calls = { feed: [], share: [] };
  return {
    calls,
    async fetchFeedPage(username, marker) {
      calls.feed.push({ username, marker });
      const idx = marker ? 1 : 0; // 简化：最多两页
      const p = pages[idx];
      if (p === undefined) throw new FinderError('上游断连');
      if (p instanceof Error) throw p;
      return p;
    },
    async shareUrlFor(objectId) {
      calls.share.push(objectId);
      const n = Number(objectId.split('_')[1]);
      return n >= shareOkFrom ? `https://weixin.qq.com/sph/S${n}` : null;
    },
  };
}

const page = (n, { continueFlag = 0, total } = {}) => ({
  items: Array.from({ length: n }, (_, i) => mkItem(i)),
  feedsCount: total ?? null, // 模拟上游：首页带 feedsCount、续页缺失（total 参数省略时）
  total: total ?? n, continueFlag, lastBuffer: continueFlag ? 'buf1' : '',
});

const newUser = (name, { linkQuota = 0, searchCredits = 0 } = {}) => {
  const t = `tok_${name}`;
  users.create(t);
  if (linkQuota || searchCredits) db.prepare('UPDATE users SET link_quota=?, search_credits=? WHERE user_token=?').run(linkQuota, searchCredits, t);
  return t;
};

before(() => { db.prepare('DELETE FROM finder_cache').run(); });
after(() => {
  db.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch { /* ignore */ } }
});

test('免费档：前 10 条、不扣费、cache miss 走上游、短链已补齐', async () => {
  invalidateFinderCache(U);
  const deps = stubDeps({ pages: [page(15, { total: 120 })] });
  const r = await getFinderVideos({ username: U }, deps);
  assert.equal(r.items.length, 10);
  assert.equal(r.total, 120);
  assert.equal(r.charged, false);
  assert.equal(r.cacheHit, false);
  assert.equal(deps.calls.feed.length, 1);
  assert.ok(r.items.every(i => i.share_url?.startsWith('https://weixin.qq.com/sph/')), '免费档 10 条短链必须补齐');
});

test('full 首拉：扣 1 次机会、落缓存、翻页凑 100、share_url 补齐', async () => {
  invalidateFinderCache(U);
  const token = newUser('full1', { searchCredits: 3 });
  // 续页不带 feedsCount（上游实测行为），总数须保留首页的 120
  // 续页实测 feedsCount=0（不是缺失），0 绝不能覆盖首页总数
  const deps = stubDeps({ pages: [page(15, { continueFlag: 1, total: 120 }), page(15, { total: 0 })] });
  const r = await getFinderVideos({ username: U, full: true, userToken: token }, deps);
  assert.equal(r.charged, true);
  assert.equal(r.items.length, 30); // 桩两页
  assert.equal(r.total, 120); // 续页的 items.length 兜底不覆盖首页 feedsCount
  assert.ok(r.items.every(i => i.share_url));
  assert.equal(users.get(token).search_credits, 2);
  assert.ok(usageLog.chargedSince('search100', U, token, 0));

  // 缓存已落：再来一次（同代）免扣直回、零上游调用
  const deps2 = stubDeps({ pages: [] });
  const r2 = await getFinderVideos({ username: U, full: true, userToken: token }, deps2);
  assert.equal(r2.charged, false);
  assert.equal(r2.deduped, true);
  assert.equal(r2.cacheHit, true);
  assert.equal(deps2.calls.feed.length, 0);
  assert.equal(users.get(token).search_credits, 2); // 未再扣
});

test('换代（缓存过期 24h）后重新计费', async () => {
  const token = newUser('full2', { searchCredits: 3 });
  const deps = stubDeps({ pages: [page(15, { total: 120 })] });
  await getFinderVideos({ username: U, full: true, userToken: token }, deps);
  assert.equal(users.get(token).search_credits, 2);
  // 把缓存代际改到 25h 前 → 过期 → 重新拉+重新扣
  db.prepare('UPDATE finder_cache SET fetched_at = fetched_at - 90000 WHERE username=?').run(U);
  await getFinderVideos({ username: U, full: true, userToken: token }, deps);
  assert.equal(users.get(token).search_credits, 1);
});

test('达人总数 ≤10：自动免扣（哪怕零机会也免费给全量）', async () => {
  invalidateFinderCache(OTHER);
  const token = newUser('small', { searchCredits: 0 });
  const deps = stubDeps({ pages: [page(7, { total: 7 })] });
  const r = await getFinderVideos({ username: OTHER, full: true, userToken: token }, deps);
  assert.equal(r.charged, false);
  assert.equal(r.items.length, 7);
  assert.equal(users.get(token).search_credits, 0);
});

test('零机会且 total>10 → NoSearchCreditsError；缓存已建，买包后直接扣不再拉', async () => {
  invalidateFinderCache(OTHER);
  const broke = newUser('broke', { searchCredits: 0 });
  const deps = stubDeps({ pages: [page(15, { total: 120 })] });
  await assert.rejects(() => getFinderVideos({ username: OTHER, full: true, userToken: broke }, deps), NoSearchCreditsError);

  // 同代内买包（补机会）→ 命中缓存：0 上游调用、扣 1
  db.prepare('UPDATE users SET search_credits=5 WHERE user_token=?').run(broke);
  const deps2 = stubDeps({ pages: [] });
  const r = await getFinderVideos({ username: OTHER, full: true, userToken: broke }, deps2);
  assert.equal(r.charged, true);
  assert.equal(r.cacheHit, true);
  assert.equal(deps2.calls.feed.length, 0);
});

test('部分失败：可用交付 <10 条 → 全额返还机会', async () => {
  invalidateFinderCache(OTHER);
  const token = newUser('partial', { searchCredits: 2 });
  // 15 条但只有 3 条能生成短链
  const deps = stubDeps({ pages: [page(15, { total: 120 })], shareOkFrom: 12 });
  const r = await getFinderVideos({ username: OTHER, full: true, userToken: token }, deps);
  assert.equal(r.charged, false);
  assert.equal(r.refunded, true);
  assert.equal(r.items.length, 15);
  assert.equal(users.get(token).search_credits, 2); // 返还后原封不动
});

test('中途断页：首页成功第 2 页断 → 交付已有页（≥10 照扣）', async () => {
  invalidateFinderCache(OTHER);
  const token = newUser('break', { searchCredits: 2 });
  const deps = stubDeps({ pages: [page(15, { continueFlag: 1, total: 120 })] }); // 第 2 页桩抛 FinderError
  const r = await getFinderVideos({ username: OTHER, full: true, userToken: token }, deps);
  assert.equal(r.charged, true);
  assert.equal(r.items.length, 15);
  assert.equal(users.get(token).search_credits, 1);
});

test('首页就断：FinderError 上抛（未扣费），不落缓存', async () => {
  invalidateFinderCache(OTHER);
  const token = newUser('down', { searchCredits: 2 });
  const deps = { calls: { feed: [], share: [] }, async fetchFeedPage() { throw new FinderError('webtop 不可达'); }, async shareUrlFor() { return null; } };
  await assert.rejects(() => getFinderVideos({ username: OTHER, full: true, userToken: token }, deps), FinderError);
  assert.equal(users.get(token).search_credits, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM finder_cache WHERE username=?').get(OTHER).c, 0);
});

test('非法 username 拒绝', async () => {
  await assert.rejects(() => getFinderVideos({ username: 'not-a-finder' }), Error);
});

test('searchTop：Top10 截断 + 命中缓存零上游', async () => {
  let n = 0;
  const deps = { searchFinders: async () => { n++; return { items: Array.from({ length: 12 }, (_, i) => ({ username: `v2_x${i}@finder`, nickname: `达人${i}`, avatar: '', signature: '' })), continueFlag: 0, lastBuff: '' }; } };
  const a = await searchTop('测试关键词', deps);
  assert.equal(a.length, 10);
  const b = await searchTop('测试关键词', deps);
  assert.equal(b.length, 10);
  assert.equal(n, 1); // 第二次走缓存
});
