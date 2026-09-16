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
`);

// 增量迁移：share_url 列（解析身份 = sph 短链；旧 ##1 短链订单回填恢复可刷新能力）
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
if (!orderColumns.includes('share_url')) {
  db.exec('ALTER TABLE orders ADD COLUMN share_url TEXT');
  db.prepare(`UPDATE orders SET share_url = 'https://weixin.qq.com/sph/' || substr(content_id, 1, length(content_id) - 3)
    WHERE content_id LIKE '%##1'`).run();
}

const now = () => Math.floor(Date.now() / 1000);

export const orders = {
  create({ id, token, contentId, shareUrl, amountCents, expireAt, previewJson, cdnUrl, fileSize, title }) {
    db.prepare(`INSERT INTO orders (id, order_token, content_id, share_url, status, amount_cents, preview_json, cdn_url, file_size, title, created_at, expire_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, token, contentId, shareUrl ?? null, 'pending', amountCents, previewJson,
        cdnUrl ?? null, fileSize ?? null, title ?? null, now(), expireAt);
  },
  get(id) {
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  },
  /** 幂等标记已支付：仅 pending 可转 paid，返回是否发生变更 */
  markPaid(id, transactionId) {
    const r = db.prepare(`UPDATE orders SET status='paid', paid_at=?, wx_transaction_id=?
      WHERE id=? AND status='pending'`).run(now(), transactionId, id);
    return r.changes > 0;
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
