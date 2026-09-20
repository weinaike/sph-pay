import { db, users, usageLog } from '../db.js';
import { config } from '../config.js';
import { searchFinders, fetchFeedPage, shareUrlFor } from './client.js';

/**
 * 达人作品列表业务层（计费语义见 docs/plan-dual-channel-pricing.md §0/§1）：
 * - 免费：每达人前 10 条，匿名可取，不限次（限频在路由层）
 * - full：前 100 条，消耗 1 次百条检索机会；同一用户同一达人**当前缓存代内只扣一次**
 *   （finder_cache.fetched_at 即代际起点，落盘跨重启稳定）；达人总数 ≤10 自动免扣
 * - 部分失败：可用交付（share_url 非空）<10 → 全额返还机会
 * 直链不落库（时效 ~1 天）；本层只落 finder_cache（短链是稳定身份，可缓存）。
 */

/** 402 语义：百条机会不足（路由层转 HTTP 402） */
export class NoSearchCreditsError extends Error {
  constructor() {
    super('百条检索机会不足：购买资源包 B（赠 10 次）或 C（赠 20 次）后可用');
    this.name = 'NoSearchCreditsError';
  }
}

/* ---------------- 检索 Top10（内存缓存 TTL 10min） ---------------- */

const searchCache = new Map(); // keyword → { at, items }

export async function searchTop(keyword, deps = {}) {
  const doSearch = deps.searchFinders || searchFinders;
  const key = keyword.trim();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < config.finder.searchCacheMs) return hit.items.slice(0, 10);
  const { items } = await doSearch(key);
  searchCache.set(key, { at: Date.now(), items });
  if (searchCache.size > 200) { // 防膨胀：丢最旧
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
    for (const [k] of oldest) searchCache.delete(k);
  }
  return items.slice(0, 10);
}

/* ---------------- finder_cache（sqlite，代际= fetched_at，TTL 24h） ---------------- */

const nowS = () => Math.floor(Date.now() / 1000);

function cachedRow(username) {
  const row = db.prepare('SELECT * FROM finder_cache WHERE username=?').get(username);
  if (!row) return null;
  if (nowS() - row.fetched_at > config.finder.listTtlS) return null; // 过期 = 换代，隔天刷新数据
  return row;
}

function putCachedRow(username, items, total) {
  db.prepare(`INSERT INTO finder_cache (username, items_json, total, fetched_at) VALUES (?,?,?,?)
    ON CONFLICT(username) DO UPDATE SET items_json=excluded.items_json, total=excluded.total, fetched_at=excluded.fetched_at`)
    .run(username, JSON.stringify(items), total, nowS());
}

/** 清除某达人的缓存代际（测试/运维用：强制下次重新拉取） */
export function invalidateFinderCache(username) {
  db.prepare('DELETE FROM finder_cache WHERE username=?').run(username);
}

/* ---------------- 全量拉取（翻页 + share_url 并发补齐） ---------------- */

async function fillShareUrls(items, deps) {
  const share = deps.shareUrlFor || shareUrlFor;
  let i = 0;
  const workers = Array.from({ length: Math.min(config.finder.shareConcurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      items[idx].share_url = await share(items[idx].object_id);
    }
  });
  await Promise.all(workers);
}

/**
 * 翻页凑满 maxItems。第 1 页失败 → 上抛 FinderError（整体 503，未扣费）；
 * 第 2+ 页失败 → 降级交付已拉到的页（≥10 条照常计费，<10 条由调用方返还）。
 */
async function pullFullList(username, deps) {
  const page = deps.fetchFeedPage || fetchFeedPage;
  const maxItems = config.finder.fullMaxItems;
  const items = [];
  let total = 0;
  let nextMarker = '';
  for (let p = 0; items.length < maxItems; p++) {
    let r;
    try {
      r = await page(username, nextMarker);
    } catch (e) {
      if (p === 0) throw e; // 首页都没有：整体失败
      break; // 中途断页：交付部分
    }
    // ⚠️ 只有 feedsCount>0 的页（首页）才更新总数——续页实测恒 0（或缺失），绝不能覆盖
    if (r.feedsCount > 0) total = r.feedsCount;
    items.push(...r.items);
    if (!r.continueFlag || !r.lastBuffer) break;
    nextMarker = r.lastBuffer;
  }
  const capped = items.slice(0, maxItems);
  await fillShareUrls(capped, deps);
  return { items: capped, total: Math.max(total, capped.length) };
}

/* ---------------- 主入口 ---------------- */

/**
 * @returns {{ items, total, charged, refunded?, truncated, cacheHit }}
 *   charged=true 表示本次实际扣了 1 次机会；refunded=true 表示扣后因 <10 可用条返还
 * @throws NoSearchCreditsError（路由层 402）、FinderError（路由层 503）
 */
export async function getFinderVideos({ username, full = false, userToken = null }, deps = {}) {
  const u = String(username || '').trim();
  if (!/^(v[12]_[A-Za-z0-9]+|[A-Za-z0-9_]+)@finder$/.test(u)) {
    throw new Error(`非法达人 username: ${username}`);
  }
  // —— 免费档：前 10 条（新鲜 finder_cache 直接切片；否则上游第一页 + 补短链）——
  if (!full) {
    const row = cachedRow(u);
    if (row) {
      const all = JSON.parse(row.items_json);
      return { items: all.slice(0, 10), total: row.total, charged: false, truncated: false, cacheHit: true };
    }
    const page = await (deps.fetchFeedPage || fetchFeedPage)(u, ''); // FinderError → 503
    const items = page.items.slice(0, 10);
    await fillShareUrls(items, deps); // 免费档交付物就是短链列表
    return { items, total: page.total, charged: false, truncated: false, cacheHit: false };
  }

  // —— full 档：需要账户（路由层已校验 userToken 存在）——
  const row = cachedRow(u);
  if (row) {
    const all = JSON.parse(row.items_json);
    // 总数 ≤10：与免费档等价，自动免扣
    if (row.total <= 10) {
      return { items: all, total: row.total, charged: false, truncated: false, cacheHit: true };
    }
    // 当前缓存代内已扣过：免重扣直回
    if (userToken && usageLog.chargedSince('search100', u, userToken, row.fetched_at)) {
      return { items: all, total: row.total, charged: false, truncated: false, cacheHit: true, deduped: true };
    }
    if (!userToken || !users.consumeSearchCredit(userToken)) throw new NoSearchCreditsError();
    usageLog.insert({ userToken, kind: 'search100', target: u });
    return { items: all, total: row.total, charged: true, truncated: all.length < row.total, cacheHit: true };
  }

  // 缓存 miss/expired：全量拉取（可能较慢，7 页 + share_url 并发）
  const { items, total } = await pullFullList(u, deps);
  putCachedRow(u, items, total); // 先建缓存代（无论接下来是否收费/402）
  if (total <= 10) {
    return { items, total, charged: false, truncated: false, cacheHit: false }; // 自动免扣
  }
  if (!userToken || !users.consumeSearchCredit(userToken)) {
    throw new NoSearchCreditsError(); // 缓存已建：下次买包后直接扣、无需再拉
  }
  const logId = usageLog.insert({ userToken, kind: 'search100', target: u });

  // 部分失败返还：可用交付（share_url 非空）<10 条 → 全额返还机会（计划 §0 阈值）
  const usable = items.filter(i => i.share_url).length;
  if (usable < 10) {
    users.refundSearchCredit(userToken);
    usageLog.markRefunded(logId);
    return { items, total, charged: false, refunded: true, truncated: true, cacheHit: false };
  }
  return { items, total, charged: true, truncated: items.length < total, cacheHit: false };
}
