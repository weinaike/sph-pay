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

const now = () => Math.floor(Date.now() / 1000);

export const orders = {
  create({ id, token, contentId, shareUrl, amountCents, expireAt, previewJson, cdnUrl, fileSize, title,
           kind = 'video', pkg = null, userToken = null }) {
    db.prepare(`INSERT INTO orders (id, order_token, content_id, share_url, status, amount_cents, preview_json, cdn_url, file_size, title, created_at, expire_at, kind, package, user_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, token, contentId, shareUrl ?? null, 'pending', amountCents, previewJson,
        cdnUrl ?? null, fileSize ?? null, title ?? null, now(), expireAt, kind, pkg, userToken);
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
  markResolved(id, { cdnUrl, xorKeyB64, encLen, fileSize, title }) {
    db.prepare(`UPDATE orders SET status='resolved', cdn_url=?, xor_key_b64=?, enc_len=?, file_size=?, title=?, resolved_at=?, error=NULL
      WHERE id=?`).run(cdnUrl, xorKeyB64, encLen, fileSize, title, now(), id);
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
  refreshDelivery(id, { cdnUrl, xorKeyB64, encLen, fileSize }) {
    db.prepare(`UPDATE orders SET cdn_url=?, xor_key_b64=?, enc_len=?, file_size=?, resolved_at=? WHERE id=?`)
      .run(cdnUrl, xorKeyB64, encLen, fileSize, now(), id);
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
  markRefunded(id) {
    db.prepare('UPDATE usage_log SET refunded=1 WHERE id=?').run(id);
  },
  /** 扣费去重：该用户该目标在 sinceS 之后是否已有未返还的计费记录
   *  （resolve 24h 同短链免重扣 / search100 当前缓存代免重扣） */
  chargedSince(kind, target, userToken, sinceS) {
    return !!db.prepare(`SELECT 1 FROM usage_log WHERE kind=? AND target=? AND user_token=? AND refunded=0 AND created_at>=? LIMIT 1`)
      .get(kind, target, userToken, sinceS);
  },
};
