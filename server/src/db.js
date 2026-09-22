import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
// 库内含下载密钥，收紧权限
try { fs.chmodSync(config.dbPath, 0o600); } catch { /* 非 POSIX 环境忽略 */ }

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_token TEXT NOT NULL,
  content_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL,
  preview_json TEXT,
  cdn_url TEXT,
  xor_key_b64 TEXT,
  enc_len INTEGER,
  file_size INTEGER,
  title TEXT,
  wx_transaction_id TEXT,
  out_refund_no TEXT,
  refund_status TEXT,
  error TEXT,
  resolve_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  resolved_at INTEGER,
  expire_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 匿名账户：余额/已购挂靠点（token 丢失即丢余额，客户端负责落盘保管）
CREATE TABLE IF NOT EXISTS users (
  user_token       TEXT PRIMARY KEY,
  link_quota       INTEGER NOT NULL DEFAULT 0,  -- 直链额度余额（条）
  search_credits   INTEGER NOT NULL DEFAULT 0,  -- 百条检索机会余额（次）
  total_paid_cents INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER
);

-- 消费/购买台账（审计与扣费去重；只记身份不存直链内容）
CREATE TABLE IF NOT EXISTS usage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_token TEXT NOT NULL,
  kind       TEXT NOT NULL,                     -- purchase | resolve | search100
  target     TEXT,                              -- share_url / finder username / package:X
  order_id   TEXT,
  refunded   INTEGER NOT NULL DEFAULT 0,        -- resolve/search100 失败返还标记
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_token, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_dedup ON usage_log(kind, target, user_token, created_at);

-- 达人作品列表缓存（落盘而非内存：扣费代际须跨进程重启稳定，见 plan §1）
CREATE TABLE IF NOT EXISTS finder_cache (
  username   TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  total      INTEGER NOT NULL,                  -- 达人作品总数（feedsCount）
  fetched_at INTEGER NOT NULL                   -- 缓存代起点，TTL 24h 隔天刷新
);
`);

// 增量迁移：share_url 列（解析身份 = sph 短链；旧 ##1 短链订单回填恢复可刷新能力）
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
if (!orderColumns.includes('share_url')) {
  db.exec('ALTER TABLE orders ADD COLUMN share_url TEXT');
  db.prepare(`UPDATE orders SET share_url = 'https://weixin.qq.com/sph/' || substr(content_id, 1, length(content_id) - 3)
    WHERE content_id LIKE '%##1'`).run();
}
// 双渠道计费（plan-dual-channel-pricing）：kind 区分视频单/套餐单；套餐单复用整套支付生命周期
if (!orderColumns.includes('kind')) db.exec("ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'");
if (!orderColumns.includes('package')) db.exec('ALTER TABLE orders ADD COLUMN package TEXT');
if (!orderColumns.includes('user_token')) db.exec('ALTER TABLE orders ADD COLUMN user_token TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_token)');
// 托管订单页（/p/:id）：渲染支付码需要 code_url 落库（微信 Native 码随订单终身有效）
if (!orderColumns.includes('code_url')) db.exec('ALTER TABLE orders ADD COLUMN code_url TEXT');
// 媒体元数据（mp4 头解析，替代客户端 ffprobe）：时长秒/宽/高
if (!orderColumns.includes('duration_s')) db.exec('ALTER TABLE orders ADD COLUMN duration_s INTEGER');
if (!orderColumns.includes('width')) db.exec('ALTER TABLE orders ADD COLUMN width INTEGER');
if (!orderColumns.includes('height')) db.exec('ALTER TABLE orders ADD COLUMN height INTEGER');

// 批量解析（POST /api/resolve/batch）：任务与逐条明细落盘，进程重启可续跑；
// cdn_url 属敏感字段（同 orders.cdn_url，只进 sqlite 与属主鉴权的响应）
db.exec(`
CREATE TABLE IF NOT EXISTS resolve_batches (
  id          TEXT PRIMARY KEY,
  user_token  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | done
  total       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS resolve_batch_items (
  batch_id  TEXT NOT NULL,
  idx       INTEGER NOT NULL,                    -- 输入序（稳定展示顺序）
  url       TEXT NOT NULL,                       -- share_url（解析与计费身份）
  status    TEXT NOT NULL DEFAULT 'pending',     -- pending|resolving|resolved|failed|refunded|skipped
  cdn_url   TEXT,
  title     TEXT,
  file_size INTEGER,
  duration_s INTEGER,
  width     INTEGER,
  height    INTEGER,
  charged   INTEGER NOT NULL DEFAULT 0,          -- 本批是否对该条扣过额度（重启恢复时免重扣）
  usage_log_id INTEGER,                          -- 扣费台账 id（失败返还用）
  error     TEXT,
  PRIMARY KEY (batch_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_batches_user ON resolve_batches(user_token, created_at);
`);

const now = () => Math.floor(Date.now() / 1000);

export const orders = {
  create({ id, token, contentId, shareUrl, amountCents, expireAt, previewJson, cdnUrl, fileSize, title,
           kind = 'video', pkg = null, userToken = null, codeUrl = null,
           durationS = null, width = null, height = null }) {
    db.prepare(`INSERT INTO orders (id, order_token, content_id, share_url, status, amount_cents, preview_json, cdn_url, file_size, title, created_at, expire_at, kind, package, user_token, code_url, duration_s, width, height)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, token, contentId, shareUrl ?? null, 'pending', amountCents, previewJson,
        cdnUrl ?? null, fileSize ?? null, title ?? null, now(), expireAt, kind, pkg, userToken,
        codeUrl ?? null, durationS ?? null, width ?? null, height ?? null);
  },
  get(id) {
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  },
  /** 支付落账（幂等，回调与 sweeper 的唯一入口）：pending→paid 抢到变更权后，
   *  套餐单在同事务里入账余额并直落 credited（paid 只是事务内中间态，外部不可见）。
   *  返回 { kind, package, userToken } 或 null（重复通知/已处理/非 pending）。 */
  markPaidAndApply(id, transactionId) {
    const apply = db.transaction(() => {
      const r = db.prepare(`UPDATE orders SET status='paid', paid_at=?, wx_transaction_id=?
        WHERE id=? AND status='pending'`).run(now(), transactionId, id);
      if (r.changes === 0) return null;
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (o.kind === 'package') {
        const pkg = config.packages[o.package];
        if (!pkg) throw new Error(`未知套餐: ${o.package}`);
        const c = db.prepare(`UPDATE users SET link_quota=link_quota+?, search_credits=search_credits+?, total_paid_cents=total_paid_cents+?
          WHERE user_token=?`).run(pkg.linkQuota, pkg.searchCredits, o.amount_cents, o.user_token);
        if (c.changes === 0) throw new Error(`套餐订单 ${id} 的购买用户不存在`);
        db.prepare(`UPDATE orders SET status='credited' WHERE id=? AND status='paid'`).run(id);
        db.prepare(`INSERT INTO usage_log (user_token, kind, target, order_id, created_at) VALUES (?,?,?,?,?)`)
          .run(o.user_token, 'purchase', `package:${o.package}`, id, now());
      }
      return { kind: o.kind, package: o.package, userToken: o.user_token };
    });
    return apply();
  },
  markResolving(id) {
    db.prepare(`UPDATE orders SET status='resolving' WHERE id=? AND status IN ('paid','resolving')`).run(id);
  },
  markResolved(id, { cdnUrl, xorKeyB64, encLen, fileSize, title, durationS, width, height }) {
    db.prepare(`UPDATE orders SET status='resolved', cdn_url=?, xor_key_b64=?, enc_len=?, file_size=?, title=?, duration_s=?, width=?, height=?, resolved_at=?, error=NULL
      WHERE id=?`).run(cdnUrl, xorKeyB64, encLen, fileSize, title,
      durationS ?? null, width ?? null, height ?? null, now(), id);
  },
  markFailed(id, error) {
    db.prepare(`UPDATE orders SET status='failed', error=? WHERE id=?`).run(error, id);
  },
  markRefunded(id, outRefundNo) {
    db.prepare(`UPDATE orders SET status='refunded', out_refund_no=?, refund_status='ok' WHERE id=?`).run(outRefundNo, id);
  },
  markRefundRetry(id, outRefundNo, error) {
    db.prepare(`UPDATE orders SET status='refunded', out_refund_no=?, refund_status='retry', error=? WHERE id=?`)
      .run(outRefundNo, error, id);
  },
  bumpAttempts(id) {
    db.prepare(`UPDATE orders SET resolve_attempts=resolve_attempts+1 WHERE id=?`).run(id);
  },
  markExpired(id) {
    db.prepare(`UPDATE orders SET status='expired' WHERE id=? AND status='pending'`).run(id);
  },
  /** deliver 后刷新过的 url/key（CDN 时效续期） */
  refreshDelivery(id, { cdnUrl, xorKeyB64, encLen, fileSize, durationS, width, height }) {
    db.prepare(`UPDATE orders SET cdn_url=?, xor_key_b64=?, enc_len=?, file_size=?, duration_s=COALESCE(?, duration_s), width=COALESCE(?, width), height=COALESCE(?, height), resolved_at=? WHERE id=?`)
      .run(cdnUrl, xorKeyB64, encLen, fileSize, durationS ?? null, width ?? null, height ?? null, now(), id);
  },
  listByStatus(status) {
    return db.prepare('SELECT * FROM orders WHERE status=?').all(status);
  },
};

export const users = {
  create(token) {
    db.prepare('INSERT INTO users (user_token, created_at, last_seen_at) VALUES (?,?,?)').run(token, now(), now());
  },
  get(token) {
    return db.prepare('SELECT * FROM users WHERE user_token=?').get(token);
  },
  touch(token) {
    db.prepare('UPDATE users SET last_seen_at=? WHERE user_token=?').run(now(), token);
  },
  /** 原子扣 1 条直链额度（余额守卫防并发超扣，changes>0 即扣成功） */
  consumeLinkQuota(token) {
    return db.prepare('UPDATE users SET link_quota=link_quota-1 WHERE user_token=? AND link_quota>0').run(token).changes > 0;
  },
  refundLinkQuota(token) {
    db.prepare('UPDATE users SET link_quota=link_quota+1 WHERE user_token=?').run(token);
  },
  /** 原子扣 1 次百条检索机会 */
  consumeSearchCredit(token) {
    return db.prepare('UPDATE users SET search_credits=search_credits-1 WHERE user_token=? AND search_credits>0').run(token).changes > 0;
  },
  refundSearchCredit(token) {
    db.prepare('UPDATE users SET search_credits=search_credits+1 WHERE user_token=?').run(token);
  },
  /** 已购套餐（/api/user/me 展示） */
  listPurchases(token) {
    return db.prepare(`SELECT id, package, amount_cents, created_at FROM orders
      WHERE user_token=? AND kind='package' AND status='credited' ORDER BY created_at DESC LIMIT 20`).all(token);
  },
};

export const usageLog = {
  insert({ userToken, kind, target = null, orderId = null }) {
    return Number(db.prepare(`INSERT INTO usage_log (user_token, kind, target, order_id, created_at) VALUES (?,?,?,?,?)`)
      .run(userToken, kind, target, orderId, now()).lastInsertRowid);
  },
  get(id) {
    return db.prepare('SELECT * FROM usage_log WHERE id=?').get(id);
  },
  markRefunded(id) {
    db.prepare('UPDATE usage_log SET refunded=1 WHERE id=?').run(id);
  },
  /** 扣费去重：该用户该目标在 sinceS 之后是否已有未返还的计费记录
   *  （resolve 24h 同短链免重扣 / search100 当前缓存代免重扣） */
  chargedSince(kind, target, userToken, sinceS) {
    return !!db.prepare(`SELECT 1 FROM usage_log WHERE kind=? AND target=? AND user_token=? AND refunded=0 AND created_at>=? LIMIT 1`)
      .get(kind, target, userToken, sinceS);
  },
}

export const batches = {
  create({ id, userToken, urls }) {
    const ins = db.prepare(`INSERT INTO resolve_batch_items (batch_id, idx, url) VALUES (?,?,?)`);
    db.transaction(() => {
      db.prepare(`INSERT INTO resolve_batches (id, user_token, status, total, created_at) VALUES (?,?,?,?,?)`)
        .run(id, userToken, 'running', urls.length, now());
      urls.forEach((u, i) => ins.run(id, i, u));
    })();
  },
  get(id) {
    return db.prepare('SELECT * FROM resolve_batches WHERE id=?').get(id);
  },
  items(id) {
    return db.prepare('SELECT * FROM resolve_batch_items WHERE batch_id=? ORDER BY idx').all(id);
  },
  listRunning() {
    return db.prepare(`SELECT * FROM resolve_batches WHERE status='running'`).all();
  },
  item(id, idx) {
    return db.prepare('SELECT * FROM resolve_batch_items WHERE batch_id=? AND idx=?').get(id, idx);
  },
  /** 状态流转守卫：仅当当前状态等于 from 时写入 to（防 runner 并发踩踏），changes>0 即成功 */
  transitionItem(id, idx, from, to, patch = {}) {
    const sets = ['status=?'];
    const args = [to];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k}=?`); args.push(v ?? null); }
    args.push(id, idx, from);
    return db.prepare(`UPDATE resolve_batch_items SET ${sets.join(',')} WHERE batch_id=? AND idx=? AND status=?`)
      .run(...args).changes > 0;
  },
  /** 额度耗尽：余下所有 pending 直落 skipped（整批不再逐条撞 402） */
  skipPending(id, error) {
    db.prepare(`UPDATE resolve_batch_items SET status='skipped', error=? WHERE batch_id=? AND status='pending'`).run(error, id);
  },
  finishIfSettled(id) {
    const left = db.prepare(`SELECT COUNT(*) AS n FROM resolve_batch_items WHERE batch_id=? AND status IN ('pending','resolving')`).get(id).n;
    if (left === 0) {
      db.prepare(`UPDATE resolve_batches SET status='done', finished_at=? WHERE id=? AND status='running'`).run(now(), id);
      return true;
    }
    return false;
  },
};
