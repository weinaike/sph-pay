import { Router } from 'express';
import { orders } from '../db.js';
import { verifyNotify, decryptResource } from '../services/wxpay.js';
import { resolve } from '../services/resolveService.js';

export const wxpayRouter = Router();

/**
 * 微信支付回调。⚠️ 必须 raw body 验签（index.js 里 express.raw 挂在本路由之前）。
 * 幂等：UPDATE ... WHERE status='pending'，changes===0 视为重复通知直接回 SUCCESS。
 * 业务异常回非 200 → 微信按 15s/15s/30s/.../24h 重试。
 */
wxpayRouter.post('/notify', expressRaw(), async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const ok = await verifyNotify({
      timestamp: req.get('wechatpay-timestamp'),
      nonce: req.get('wechatpay-nonce'),
      body: rawBody,
      serial: req.get('wechatpay-serial'),
      signature: req.get('wechatpay-signature'),
    });
    if (!ok) return res.status(401).json({ code: 'FAIL', message: '验签失败' });

    const envelope = JSON.parse(rawBody);
    if (envelope.event_type !== 'TRANSACTION.SUCCESS') {
      return res.json({ code: 'SUCCESS', message: 'OK' });
    }
    const r = envelope.resource;
    const data = decryptResource({ ciphertext: r.ciphertext, nonce: r.nonce, associated_data: r.associated_data });

    if (data.trade_state === 'SUCCESS') {
      const changed = orders.markPaid(data.out_trade_no, data.transaction_id);
      console.log(`[notify] ${data.out_trade_no} 回调验签+解密通过 (txn ${data.transaction_id}, markPaid=${changed})`);
      if (changed) {
        resolve(data.out_trade_no).catch(e => console.error(`[notify] resolve 启动失败: ${e.message}`));
      }
    }
    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (e) {
    console.error('[notify] 处理异常:', e.message);
    res.status(500).json({ code: 'FAIL', message: '内部错误' });
  }
});

function expressRaw() {
  return (req, res, next) => {
    // body 已由全局 express.raw 处理为 Buffer；防御性兜底
    if (Buffer.isBuffer(req.body)) return next();
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', c => buf += c);
    req.on('end', () => { req.body = Buffer.from(buf); next(); });
  };
}
