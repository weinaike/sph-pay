/**
 * 托管订单页 /p/:id（替代 skill 端 render_order.py 的本地渲 HTML）。
 * skill 只需把 page_url 给用户；页面同源轮询 /api/order/:id/status 自推进状态，
 * 无本地渲染的 CORS 死结（rendering.md §五的约束就此消失）。
 *
 * 路由面：
 *   GET  /p/:id             订单页 HTML（服务端渲 bootstrap + QR data URL；noindex）
 *   GET  /p/:id/cover       封面代理（腾讯 CDN 有防盗链，浏览器直连 <img> 会白图）
 *   GET  /p/:id/avatar      头像代理（wx.qlogo.cn 同理）
 *   GET  /p/:id/finder      同达人 Top10 作品（懒加载；免费档，finder_cache 24h）
 *   POST /p/:id/package     页面直购套餐（页面钱包 = localStorage；到账后展示钱包码粘回对话）
 *
 * 安全：页面绝不出现 cdn_url/xor_key（支付前零下发；resolved 态也只报「回对话继续」）。
 * 模板铁律：客户端 JS 一律事件委托（data-* + addEventListener），不用内联 onerror/onclick
 * ——内联属性引号嵌套进模板字符串曾把整段脚本弄成非法语法（#app 空白，2026-09-22 踩坑）。
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import QRCode from 'qrcode';
import { z } from 'zod';
import { orders, users } from '../db.js';
import { config } from '../config.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';
import { createNativeOrder } from '../services/wxpay.js';
import { newOrderId, newOrderToken } from '../util/id.js';
import { searchTop, getFinderVideos } from '../finder/videos.js';
import { FinderError } from '../finder/client.js';

export const pageRouter = Router();

const COMPANY_NAME = '越思科技 Yes-Tek';
const COMPANY_URL = 'https://www.yes-tek.com/';
const MP_NAME = '越思工具';

// 小程序码（免费通道卡）与公司 logo（顶栏）：构建期随 src/ 打进镜像；缺失自动降级
const assetB64 = (file) => {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', file);
    return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  } catch { return ''; }
};
const MP_QR_B64 = assetB64('miniprogram-qr.png');
const LOGO_B64 = assetB64('company-logo-64.png');

const pageLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: ipOf });
const imgLimit = rateLimit({ windowMs: 60_000, max: 90, keyFn: ipOf });
const finderLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: ipOf });
const pkgLimit = rateLimit({ windowMs: 60_000, max: 5, keyFn: ipOf });

/** token 校验（与 orderAuth 同语义，但 token 取 ?t= 或 ?token=，返回 {o} 或 {code}） */
function pageOrder(req) {
  const { id } = req.params;
  const token = String(req.query.t || req.query.token || '');
  const o = orders.get(id);
  if (!o) return { code: 404 };
  const a = Buffer.from(token);
  const b = Buffer.from(String(o.order_token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { code: 403 };
  return { o };
}

const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/** 剥掉标题尾部话题标签串（只剥尾部连续标签，剥空则原样；列表条目服务端预净化） */
function cleanTitle(t) {
  const s = String(t ?? '');
  return s.replace(/(?:\s*#[^\s#]+)+\s*$/, '') || s;
}

const rfc3339 = (epochSec) => new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const qrOpts = { margin: 1, width: 260, errorCorrectionLevel: 'M' };

pageRouter.get('/:id', pageLimit, async (req, res, next) => {
  try {
    const { o, code } = pageOrder(req);
    if (code) return res.status(code).send(renderErrorPage(code));
    const pkg = o.kind === 'package' ? config.packages[o.package] : null;

    // 支付码：code_url 随订单终身有效（未过期未支付均可扫）；QR 生成失败降级为无码卡（不炸页）
    let qrData = '';
    if (o.code_url && ['pending'].includes(o.status)) {
      qrData = await QRCode.toDataURL(o.code_url, qrOpts).catch(() => '');
    }

    const preview = o.preview_json ? JSON.parse(o.preview_json) : {};
    const boot = {
      id: o.id,
      status: o.status,
      kind: o.kind,
      package: o.package,
      amountCents: o.amount_cents,
      expireAt: o.expire_at,
      codeUrl: o.status === 'pending' ? (o.code_url || '') : '',
      qrData,
      shareUrl: o.share_url || '',
      mpQr: MP_QR_B64,
      logo: LOGO_B64,
      mpName: MP_NAME,
      preview: {
        title: cleanTitle(preview.title),
        author: preview.author || '',
        likes: preview.likes || '',
        createdAt: preview.created_at || null,
        hasCover: !!preview.cover,
        hasAvatar: !!preview.avatar,
      },
      meta: { fileSize: o.file_size, durationS: o.duration_s, width: o.width, height: o.height },
      granted: pkg ? { link_quota: pkg.linkQuota, search_credits: pkg.searchCredits } : null,
      packages: Object.fromEntries(Object.entries(config.packages).map(([n, p]) => [n, {
        amount_cents: p.cents, link_quota: p.linkQuota, search_credits: p.searchCredits,
      }])),
      priceCents: config.priceCents,
    };

    res.set({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
    });
    res.send(renderPage(boot));
  } catch (e) { next(e); }
});

/** 封面/头像代理：URL 只来自库内 preview_json（无 SSRF 面），失败 404 由页面移除兜底 */
async function proxyImage(req, res, field) {
  const { o, code } = pageOrder(req);
  if (code) return res.status(code).end();
  const preview = o.preview_json ? JSON.parse(o.preview_json) : {};
  const url = preview[field];
  if (!url) return res.status(404).end();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(404).end();
    res.set({
      'content-type': r.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'public, max-age=3600',
    });
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(404).end();
  }
}
pageRouter.get('/:id/cover', imgLimit, (req, res) => proxyImage(req, res, 'cover'));
pageRouter.get('/:id/avatar', imgLimit, (req, res) => proxyImage(req, res, 'avatar'));

/** 同达人 Top10（懒加载）：昵称精确匹配 → 免费档列表（finder_cache 24h 代际缓存）。
 *  通道故障 503 由页面静默隐藏该卡，不影响支付主流程。 */
pageRouter.get('/:id/finder', finderLimit, async (req, res, next) => {
  try {
    const { o, code } = pageOrder(req);
    if (code) return res.status(code).json({ error: 'bad_token' });
    if (o.kind !== 'video') return res.status(409).json({ error: 'not_video_order' });
    const preview = o.preview_json ? JSON.parse(o.preview_json) : {};
    const author = (preview.author || '').trim();
    if (!author) return res.json({ items: [], total: 0, reason: 'no_author' });

    const hits = await searchTop(author);
    const hit = hits.find(h => (h.nickname || '').trim() === author);
    if (!hit) return res.json({ items: [], total: 0, reason: 'no_exact_match' });

    const r = await getFinderVideos({ username: hit.username });
    res.json({
      nickname: hit.nickname,
      username: hit.username,
      total: r.total,
      items: r.items.slice(0, 10).map(i => ({
        title: cleanTitle(i.title),
        share_url: i.share_url,
        created_at: i.created_at,
        duration: i.duration,
        size: i.size,
      })),
    });
  } catch (e) {
    if (e instanceof FinderError) return res.status(503).json({ error: 'finder_unavailable' });
    next(e);
  }
});

/** 页面直购套餐：页面钱包（localStorage 的 user_token）持有权益，到账后页面展示钱包码
 *  供用户粘回对话写入 agent 侧 ~/.config/sph/user_token 续用。与 /api/package（agent 流）
 *  落同一套 orders/users 表，互不冲突。鉴权 token 走 body（页面 JS fetch 不方便带原 query）。 */
const pkgBodySchema = z.object({
  package: z.enum(['A', 'B', 'C']),
  token: z.string().max(128).optional(),
  user_token: z.string().max(128).optional(),
});

pageRouter.post('/:id/package', pkgLimit, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { package: pkgName, user_token } = pkgBodySchema.parse(req.body || {});
    const o = orders.get(id);
    if (!o) return res.status(404).json({ error: 'order_not_found' });
    const a = Buffer.from(String(req.body?.token || req.query.t || ''));
    const b = Buffer.from(String(o.order_token));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'bad_token' });
    }
    const pkg = config.packages[pkgName];

    // 页面钱包：带旧码则验（无效换新），没带则开户；每次回包都带码，页面落 localStorage
    let token = String(user_token || '');
    if (!token || !users.get(token)) {
      token = newOrderToken();
      users.create(token);
    }

    const orderId = newOrderId();
    const orderToken = newOrderToken();
    const expireAt = Math.floor(Date.now() / 1000) + config.orderTtlSeconds;
    const codeUrl = await createNativeOrder({
      orderId,
      amountCents: pkg.cents,
      description: `视频号资源包${pkgName} ${pkg.linkQuota}条直链额度`
        + (pkg.searchCredits ? `+${pkg.searchCredits}次百条检索` : '') + ` ${orderId}`,
      timeExpire: rfc3339(expireAt),
    });
    orders.create({
      id: orderId, token: orderToken,
      contentId: `package:${pkgName}`,
      kind: 'package', pkg: pkgName, userToken: token,
      amountCents: pkg.cents, expireAt, codeUrl,
    });
    const qrData = await QRCode.toDataURL(codeUrl, qrOpts).catch(() => '');
    res.json({
      order_id: orderId, order_token: orderToken, package: pkgName,
      amount_cents: pkg.cents, expire_at: expireAt, code_url: codeUrl, qr_data: qrData,
      user_token: token,
      granted: { link_quota: pkg.linkQuota, search_credits: pkg.searchCredits },
      notice: '虚拟权益，支付后即时到账，售出不退；余额永久有效',
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'bad_request', message: e.message });
    next(e);
  }
});

// ---------- 模板 ----------

function renderPage(boot) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f5f6f8">
${LOGO_B64 ? `<link rel="icon" type="image/png" href="${LOGO_B64}">` : ''}
<title>${boot.kind === 'package' ? `资源包 ${boot.package} · ${MP_NAME}` : `${boot.preview.title || '视频号视频'} · ${MP_NAME}`}</title>
<style>
:root{--green:#07c160;--ink:#1a1a1a;--sub:#68727e;--line:#ecedef;--bg:#f5f6f8}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);line-height:1.6;-webkit-font-smoothing:antialiased}
::selection{background:rgba(7,193,96,.16)}
:focus-visible{outline:2px solid var(--green);outline-offset:2px;border-radius:4px}
.wrap{max-width:560px;margin:0 auto;padding:0 14px 96px}
.brandbar{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;padding:12px 2px 10px;font-size:13px;color:var(--sub);background:rgba(245,246,248,.92);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.brandbar a{color:var(--sub);text-decoration:none;display:flex;align-items:center;gap:6px}
.brandlogo{width:20px;height:20px;border-radius:5px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 16px;margin-top:14px;box-shadow:0 1px 2px rgba(20,32,46,.04);animation:cardin .3s ease both}
.card h2{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--line);margin-bottom:12px}
.card h2::before{content:"";width:4px;height:14px;background:var(--green);border-radius:2px;flex:none}
@keyframes cardin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
/* 双栏对齐：桌面=两个独立纵向堆叠（列间互不牵扯，卡片节奏一致 12px）；
   手机=display:contents 打散包装层，按 order 单列（信息→支付→直购→套餐→同达人→免费） */
.cols{display:flex;flex-direction:column}
.col-left,.col-right{display:contents}
.c-info{order:1}.c-pay{order:2}.c-wallet{order:3}.c-pkgpay{order:4}.c-pkg{order:5}.c-finder{order:6}.c-free{order:7}.c-faq{order:8}
@media (min-width:900px){
  .wrap{max-width:980px}
  .cols{display:grid;grid-template-columns:1fr 380px;gap:0 16px;align-items:start}
  .col-left,.col-right{display:flex;flex-direction:column}
  .col-left{grid-column:1}
  .col-right{grid-column:2}
  .c-pkg,.c-faq{grid-column:1/-1} /* 套餐三档与 FAQ 桌面通栏：三张小卡在 380px 竖条里太局促 */
  .c-full{grid-column:1/-1;display:block !important}
}
h1{font-size:17px;font-weight:600;margin:8px 0 4px;word-break:break-word}
.sub{font-size:13px;color:var(--sub)}
.meta{font-size:13px;color:var(--sub);margin-top:6px}
.meta b{color:var(--ink);font-weight:600}
.cover{width:100%;border-radius:10px;aspect-ratio:16/9;object-fit:cover;background:#eee;display:block;margin-top:10px}
.row{display:flex;gap:10px;align-items:center;margin-top:10px}
.avatar{width:34px;height:34px;border-radius:50%;background:#eee;flex:none}
.price{font-size:26px;font-weight:700;color:var(--ink)}
.price small{font-size:13px;color:var(--sub);font-weight:400}
/* 主行动卡（本单支付）：绿框浅底 + 绿色大价 + 微标题，视觉权重高于套餐卡 */
.paycard{border-color:#b9eccf;background:linear-gradient(180deg,#f2fcf6,#fff 58%)}
.paytitle{font-size:12px;font-weight:600;color:var(--green);letter-spacing:2px}
.paycard .price{color:var(--green);font-size:32px;font-variant-numeric:tabular-nums}
.steps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--sub);margin-top:2px}
.steps .on{color:var(--green);font-weight:600}
.steps i{font-style:normal;opacity:.45}
.trust{display:flex;justify-content:center;gap:4px 12px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--sub)}
.trust span::before{content:"✓ ";color:var(--green);font-weight:700}
/* 临期紧迫感：橙/红 + 红色脉动 */
.cd-warn{color:#f0883a !important}
.cd-danger{color:#fa5151 !important;animation:pulse 1s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45}}
.qrbox{display:flex;flex-direction:column;align-items:center;margin-top:14px}
.qr{position:relative;background:#fff;padding:12px;border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(20,32,46,.05)}
.qr::after{content:"";position:absolute;left:14px;right:14px;top:12px;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,rgba(7,193,96,.5),transparent);animation:scan 2.4s ease-in-out infinite}
@keyframes scan{0%,100%{transform:translateY(0)}50%{transform:translateY(198px)}}
.qr img{display:block;width:200px;height:200px}
.tippay{font-size:12px;color:var(--sub);margin-top:8px;text-align:center}
.tapay{display:none;text-align:center;margin-top:12px;padding:12px 14px;background:var(--green);color:#fff;border-radius:11px;font-size:15px;font-weight:600;text-decoration:none;box-shadow:0 4px 14px rgba(7,193,96,.28)}
.tapay:active{transform:scale(.98)}
@media (pointer:coarse),(max-width:760px){.tapay{display:block}} /* 点按直付仅移动端有意义；桌面点了没反应还占位 */
/* 移动端悬浮支付条：支付卡滚出视口才浮现，一键滚回支付位置（长页不丢支付入口） */
.paybar{position:fixed;left:12px;right:12px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:60;display:none;align-items:center;justify-content:space-between;gap:10px;max-width:532px;margin:0 auto;padding:10px 12px 10px 16px;background:rgba(255,255,255,.96);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 28px rgba(20,32,46,.16);transform:translateY(130%);transition:transform .25s ease}
.paybar.show{transform:none}
.pb-price{font-size:19px;font-weight:800;color:var(--green)}
.pb-cd{font-size:12px;color:var(--sub);margin-left:8px;font-variant-numeric:tabular-nums}
.pb-btn{background:var(--green);color:#fff;border:none;border-radius:10px;padding:10px 22px;font-size:15px;font-weight:600;cursor:pointer}
@media (max-width:760px){.paybar{display:flex}}
.countdown{font-size:14px;color:var(--ink);font-variant-numeric:tabular-nums}
.state-icon{font-size:34px;text-align:center;margin-top:6px}
.state-title{font-size:18px;font-weight:600;text-align:center;margin-top:6px}
.spinner{width:30px;height:30px;border:3px solid var(--line);border-top-color:var(--green);border-radius:50%;margin:12px auto 0;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:6px}
/* 小卡：flex 列 + 尾部（折算价+按钮）钉底 → 三档内容/按钮严格底对齐；
   bonus 行固定高度 → 有无百条检索的档位上部也对齐 */
.pkg{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;border:1px solid var(--line);border-radius:12px;padding:16px 10px 14px;background:#fafbfc;transition:border-color .15s,transform .15s,box-shadow .15s}
.pkg:hover{border-color:#b9eccf;transform:translateY(-2px);box-shadow:0 6px 18px rgba(20,32,46,.07)}
.pkg.cur{border-color:var(--green);background:#f4fdf8}
.pkg .badge{position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:var(--green);color:#fff;font-size:10px;line-height:1;padding:3px 8px;border-radius:99px;white-space:nowrap}
.pkg .n{font-size:13.5px;font-weight:600;color:var(--sub)}
.pkg .p{font-size:26px;font-weight:800;margin:6px 0 4px;letter-spacing:-.5px;line-height:1.1}
.pkg .p small{font-size:13px;font-weight:500;color:var(--sub);vertical-align:3px}
.pkg .g{font-size:14.5px;color:var(--ink);line-height:1.35}
.pkg .g b{font-size:17px}
.pkg .bonus{min-height:20px;font-size:12px;color:var(--green);display:flex;align-items:center;gap:2px;margin-top:3px}
.pkg .bonus.none{visibility:hidden} /* 占位对齐：A 档无百条检索也留一行高 */
.pkg .tail{margin-top:auto;width:100%;display:flex;flex-direction:column;align-items:center;padding-top:8px}
.pkg .unit{font-size:12.5px;color:var(--sub);margin-bottom:8px}
.pkg .unit b{color:var(--ink);font-weight:600}
.pkg .unit .sv{color:var(--green)}
.pkg button{width:100%;padding:9px 0;border:1px solid var(--green);background:#fff;color:var(--green);border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s}
.pkg button:hover{background:#f4fdf8}
.pkg.hot button{background:var(--green);color:#fff}
.pkg.hot button:hover{background:#06ad56}
.pkg.cur button{background:var(--green);color:#fff}
.pkg button:disabled{border-color:var(--line);background:#fff;color:var(--sub);cursor:default}
.legend{font-size:12.5px;color:var(--sub);margin-top:10px;line-height:1.6}
.legend b{color:var(--ink);font-weight:600}
.legend .ls{display:none}
/* 手机：资源包卡收身（免费通道/同达人不被推太深）——短版权益说明、隐藏套餐卡操作提示 */
@media (max-width:760px){
  .legend{font-size:11px}
  .legend .lf{display:none}
  .legend .ls{display:inline}
  .c-pkg .hint{display:none}
}
@media (max-width:480px){
  .grid{gap:7px}
  .pkg{padding:13px 5px 11px}
  .pkg .n{font-size:12px}
  .pkg .p{font-size:19px}
  .pkg .g{font-size:12px}
  .pkg .g b{font-size:14px}
  .pkg .bonus{font-size:10.5px;min-height:16px}
  .pkg .unit{font-size:11px;margin-bottom:6px}
  .pkg button{font-size:12px;padding:7px 0;white-space:nowrap}
}
.terms{font-size:11px;color:var(--sub);text-align:center;margin-top:8px}
.hint{font-size:12px;color:var(--sub);margin-top:8px}
.freerow{display:flex;gap:14px;align-items:center;margin-top:8px}
.freerow img{width:84px;height:84px;border-radius:10px;border:1px solid var(--line);flex:none} /* 备选通道：视觉权重低于支付码 */
.btn{display:inline-block;padding:6px 12px;border:1px solid var(--line);background:#fff;border-radius:7px;font-size:12px;color:var(--ink);cursor:pointer}
.btn.primary{border-color:var(--green);color:var(--green)}
.wallet{margin-top:10px;padding:10px;border:1px dashed var(--green);border-radius:10px;word-break:break-all;font-size:12px;background:#f4fdf8}
/* 页面钱包卡（有额度时展示：余额 + 复制入口） */
.walletchip{display:inline-flex;align-items:center;gap:4px;background:#eef7f1;border-radius:99px;padding:1px 9px;font-size:11.5px;color:var(--ink)}
/* 到账弹窗：钱包码必须被明确复制/知晓后才关闭 */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:99;padding:16px;animation:cardin .2s ease both}
.modal .mcard{background:#fff;border-radius:16px;max-width:380px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.18);animation:cardin .28s ease both}
.modal .code{margin:12px 0;padding:12px 8px;background:#f4fdf8;border:1px dashed var(--green);border-radius:10px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all;user-select:all;line-height:1.7}
.modal .warn{font-size:12px;color:#b8860b;background:#fffbe8;border-radius:8px;padding:8px 10px;margin-top:10px;text-align:left;line-height:1.7}
.modal .btns{display:flex;gap:8px;margin-top:14px}
.modal .btns .btn{flex:1;padding:9px 0;text-align:center}
.vlist{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
.vlist td{padding:8px 6px;vertical-align:top}
.vlist tbody tr:nth-child(even){background:#fafbfc} /* 斑马纹提扫视性 */
.vlist .idx{width:26px}
.vlist .idx span{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;border-radius:50%;background:#eef7f1;color:var(--sub);font-size:11px}
.vlist .tt{word-break:break-word}
.vlist .tt .sub{font-size:11.5px}
.vlist .dd{text-align:right;white-space:nowrap}
.vlist .pill{display:inline-block;padding:1px 8px;border-radius:99px;background:#eef7f1;color:var(--ink);font-size:12px;font-variant-numeric:tabular-nums}
.tag{display:inline-block;font-size:11px;color:var(--green);border:1px solid var(--green);border-radius:5px;padding:0 6px;margin-left:6px;vertical-align:2px}
.foot{font-size:11px;color:var(--sub);margin-top:16px;text-align:center}
/* FAQ：折叠式（<details> 原生，零 JS），默认收起不扰支付主流程 */
.faq details{border-bottom:1px solid var(--line)}
.faq details:last-child{border-bottom:none}
.faq summary{cursor:pointer;font-size:13.5px;font-weight:600;padding:10px 2px;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--sub);font-size:16px;flex:none}
.faq details[open] summary::after{content:"−"}
.faq .a{font-size:12.5px;color:var(--sub);padding:0 2px 12px;line-height:1.75}
.faq .a b{color:var(--ink);font-weight:600}
.ok{color:var(--green);font-weight:600}
/* 尊重系统「减弱动态效果」设置 */
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}.qr::after{display:none}}
</style>
</head>
<body>
<div class="wrap">
  <div class="brandbar"><a href="${COMPANY_URL}" target="_blank" rel="noopener">${LOGO_B64 ? `<img class="brandlogo" src="${LOGO_B64}" alt="">` : ''}${COMPANY_NAME}</a><span>${MP_NAME}</span></div>
  <div id="app"></div>
  <div class="foot">支付完成后自动解析并下载 · 视频仅供个人学习备份，请勿用于商业用途</div>
</div>
<script>
const B = ${jsonForScript(boot)};
const T = new URLSearchParams(location.search).get('t') || new URLSearchParams(location.search).get('token') || '';
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yuan = c => '¥' + (c/100).toFixed(2);
const bytes = n => { if (n==null||!n) return ''; const u=['B','KB','MB','GB']; let i=0,v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} return (v>=100||i===0?Math.round(v):v.toFixed(1))+u[i]; };
const dur = s => { if (s==null) return ''; return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
const dt = e => e ? new Date(e*1000).toLocaleDateString('zh-CN') : '';
let PKG = null;      // 页面直购的套餐订单 {order_id, order_token, amount_cents, expire_at, qr_data, package, granted, credited}
let WALLET = localStorage.getItem('sph_user_token') || '';
let WALLET_INFO = null;   // 页面钱包余额（/api/user/me；有钱包才有）
let WALLET_MODAL_SHOWN = false;

/** 拉页面钱包余额（匿名端点，公网白名单内）；有变化才重渲染 */
async function fetchWalletInfo(){
  if (!WALLET) return;
  try {
    const r = await fetch('/api/user/me', { cache: 'no-store', headers: { 'x-user-token': WALLET } });
    if (!r.ok) { if (r.status === 401) { WALLET_INFO = null; } return; }
    const j = await r.json();
    const prev = WALLET_INFO;
    WALLET_INFO = { quota: j.link_quota, credits: j.search_credits };
    if (!prev || prev.quota !== WALLET_INFO.quota) renderAll();
  } catch { /* 网络抖动忽略 */ }
}

/** 页面钱包卡：有额度时展示余额 + 复制钱包码（这是「免付这 ¥1」与「跨设备续用」的入口） */
function walletCard(){
  if (!WALLET_INFO || (WALLET_INFO.quota <= 0 && WALLET_INFO.credits <= 0)) return '';
  return '<div class="card"><h2>本页钱包</h2>'
    + '<div class="g" style="font-size:14px"><span class="walletchip"><b>'+WALLET_INFO.quota+'</b> 条视频额度</span>'
    + (WALLET_INFO.credits ? ' <span class="walletchip"><b>'+WALLET_INFO.credits+'</b> 次百条列表</span>' : '')
    + ' <span class="sub" style="font-size:12px">永久有效</span></div>'
    + '<div class="meta">钱包码：<span style="font-family:ui-monospace,Menlo,monospace;word-break:break-all">'+esc(WALLET)+'</span></div>'
    + '<button class="btn primary" data-act="copy-wallet" style="margin-top:8px">复制钱包码</button>'
    + '<div class="hint">复制后回到对话粘贴给助手，可<b>用额度直接下载本视频（免 ¥1）</b>，也可批量下载。</div></div>';
}

// 静态资源一律绝对路径 + 带 token（相对路径会以 /p/ 为基底丢掉订单 id；图省 token 会 403）
const purl = (suffix) => '/p/'+encodeURIComponent(B.id)+'/'+suffix+'?t='+encodeURIComponent(T);

function videoInfoCard(){
  if (B.kind !== 'video') return '';
  const m = [];
  if (B.meta.fileSize) m.push('体积 <b>'+bytes(B.meta.fileSize)+'</b>');
  if (B.meta.durationS != null) m.push('时长 <b>'+dur(B.meta.durationS)+'</b>');
  if (B.meta.width) m.push('分辨率 <b>'+B.meta.width+'×'+B.meta.height+'</b>');
  return '<div class="card">'
    + '<div class="row"><img class="avatar" src="'+purl('avatar')+'">'
    + '<div><b>'+esc(B.preview.author||'视频号作者')+'</b>'+(B.preview.likes?' <span class="tag">'+esc(B.preview.likes)+' 赞</span>':'')+'</div></div>'
    + '<h1>'+esc(B.preview.title||'视频号视频')+'</h1>'
    + (B.preview.createdAt?'<div class="sub">'+dt(B.preview.createdAt)+'</div>':'')
    + (B.preview.hasCover?'<img class="cover" src="'+purl('cover')+'" loading="lazy">':'')
    + (m.length?'<div class="meta">'+m.join(' · ')+'</div>':'')
    + '</div>';
}

function qrBlock(qrData, codeUrl, tip){
  let h = '';
  if (qrData) {
    h = '<div class="qrbox"><div class="qr"><img src="'+qrData+'"></div><div class="tippay">'+tip+'</div>'
      + (codeUrl ? '<a class="tapay" href="'+esc(codeUrl)+'">手机微信内打开本页？点此直接拉起支付</a>' : '')
      + '</div>';
  } else {
    h = '<div class="tippay">支付码生成失败，请回到对话重新发起</div>';
  }
  return h;
}

function payCard(){
  if (B.status !== 'pending' || !B.qrData && !B.codeUrl) return '';
  return '<div class="card paycard" id="paycard">'
    + '<div class="row" style="justify-content:space-between;margin-top:0"><div>'
    + '<div class="paytitle">'+(B.kind==='video'?'扫码支付 · 本视频':'扫码支付 · 资源包 '+esc(B.package))+'</div>'
    + '<div class="price">'+yuan(B.amountCents)
    + (B.kind==='video'?' <small>单视频原画直链</small>':' <small>套餐权益即时到账</small>')+'</div></div>'
    + '<div class="countdown" data-cd="'+B.expireAt+'">--:--</div></div>'
    + '<div class="steps"><span class="on">① 微信扫码支付</span><i>→</i><span>② 自动解析</span><i>→</i><span>③ 回对话交付</span></div>'
    + qrBlock(B.qrData, B.codeUrl, '微信扫码支付')
    + '<div class="trust"><span>官方商户收款</span><span>失败自动退款</span><span>本地交付不留存</span></div></div>';
}

/** 页面直购卡：未支付=套餐码+倒计时；到账=钱包码+复制（粘回对话续用） */
function pkgPayCard(){
  if (!PKG) return '';
  if (PKG.credited) {
    return '<div class="card"><div class="state-icon">🎉</div><div class="state-title ok">套餐已到账</div>'
      + '<div class="meta" style="text-align:center;margin-top:8px">资源包 '+esc(PKG.package)+'：<b>'+PKG.granted.link_quota+' 条直链额度</b>'
      + (PKG.granted.search_credits?' + <b>'+PKG.granted.search_credits+' 次百条检索</b>':'')+'（永久有效）</div>'
      + '<div class="wallet"><b>钱包码（权益在这里）：</b><br>'+esc(WALLET)
      + '<br><button class="btn primary" data-act="copy-wallet" style="margin-top:6px">复制钱包码</button>'
      + '<br><span class="sub">回到对话，把这段码发给助手即可继续批量下载。</span></div></div>';
  }
  return '<div class="card" id="pkgcard"><div class="row" style="justify-content:space-between"><div class="price">'+yuan(PKG.amount_cents)
    + ' <small>资源包 '+esc(PKG.package)+'（页面直购）</small></div>'
    + '<div class="countdown" data-cd="'+PKG.expire_at+'">--:--</div></div>'
    + qrBlock(PKG.qr_data, PKG.code_url, '微信扫码支付 · 支付后此处显示钱包码') + '</div>';
}

function freeCard(){
  let body = '打开微信 → 发现 → 小程序 → 搜索<b>《'+esc(B.mpName)+'》</b> → 粘贴这条链接即可下载。';
  if (B.mpQr) {
    body = '<div class="freerow"><img src="'+B.mpQr+'"><div>'+body
      + (B.shareUrl ? '<br><button class="btn" data-act="copy-link" style="margin-top:8px">复制本视频链接</button>' : '')
      + '<br><span class="sub">微信扫左码直达小程序。</span></div></div>';
  }
  return '<div class="card"><h2>免费通道 · 不想付费？</h2>'+body+'</div>';
}

const PKG_NAMES = {A:'A · 尝鲜', B:'B · 批量', C:'C · 重度'};
const PKG_HOT = 'B'; // 推荐档：批量场景性价比最高
function pkgCard(){
  const cur = PKG && !PKG.credited ? PKG.package : null;
  let h = '<div class="card"><h2>资源包 · 经常下载更划算</h2><div class="grid">'
    + Object.entries(B.packages).map(([n,p]) => {
      const per = (p.amount_cents / p.link_quota / 100).toFixed(2).replace(/0$/, '');
      const save = B.priceCents ? Math.round((1 - p.amount_cents / p.link_quota / B.priceCents) * 100) : 0;
      return '<div class="pkg'+(n===PKG_HOT?' hot':'')+(cur===n?' cur':'')+'">'
      + (n===PKG_HOT?'<div class="badge">推荐</div>':'')
      + '<div class="n">'+PKG_NAMES[n]+'</div>'
      + '<div class="p"><small>¥</small>'+(p.amount_cents/100).toFixed(p.amount_cents%100?2:0)+'</div>'
      + '<div class="g"><b>'+p.link_quota+'</b> 个视频</div>'
      + '<div class="bonus'+(p.search_credits?'':' none')+'">'+(p.search_credits?'+'+p.search_credits+' 次百条列表':'-')+'</div>'
      + '<div class="tail"><div class="unit">≈ <b>¥'+per+'</b> /个'+(save>0?' · <b class="sv">省'+save+'%</b>':'')+'</div>'
      + '<button data-act="buy" data-pkg="'+n+'"'+(cur?' disabled':'')+'>'+(cur===n?'支付中…':'直接购买')+'</button></div></div>';
    }).join('')
    + '</div>'
    + '<div class="legend"><span class="lf">权益说明：<b>视频额度</b>＝1 个额度下载 1 个视频（原画无水印 MP4，永久有效）；<b>百条列表</b>＝一次拉全某达人前 100 条作品清单的机会，方便批量挑选。</span><span class="ls">权益：<b>1 额度</b>＝1 个视频（原画无水印）；<b>百条列表</b>＝拉全达人前 100 条清单。</span></div>'
    + '<div class="terms">即时到账 · 永久有效 · 售出不退</div>'
    + '<div class="hint">点「直接购买」当前页出码支付，无需另开链接；到账后展示钱包码，粘回对话即可批量下载。也可回到对话对助手说「买套餐 A/B/C」。</div></div>';
  return h;
}

// 同达人 Top10：数据缓存于 FINDER_DATA，重渲染不丢（状态推进不再把已加载的列表冲掉）
let FINDER_DATA = null, FINDER_TRIED = false;
function finderCard(){
  if (B.kind !== 'video' || !B.preview.author) return '';
  if (FINDER_DATA) return finderInner(FINDER_DATA);
  return '<div class="card" id="findercard"><h2>同达人其他作品 Top10 <span class="sub">（免费）</span></h2>'
    + '<div class="spinner" style="margin:8px auto 0"></div>'
    + '<div class="tippay">加载中…首次最多约 1 分钟</div></div>';
}

function finderInner(j){
  if (!j || !j.items || !j.items.length) return '';
  let rows = j.items.map((v,i) => {
    const cur = v.share_url && B.shareUrl && v.share_url === B.shareUrl;
    return '<tr><td class="idx"><span>'+(i+1)+'</span></td><td class="tt">'+esc(v.title||'(无标题)')
      + (cur?'<span class="tag">本条</span>':'')
      + '<br><span class="sub">'+dt(v.created_at)+(v.size?' · '+bytes(v.size):'')+'</span></td>'
      + '<td class="dd">'+(v.duration?'<span class="pill">'+dur(v.duration)+'</span>':'')+'</td></tr>';
  }).join('');
  return '<div class="card" id="findercard"><h2>'+esc(j.nickname)+' 的作品 Top10 </h2>'
    + '<table class="vlist"><tbody>'+rows+'</tbody></table>'
    + '<div class="hint">共 '+j.total+' 条。要下载哪几条，回到对话报序号即可（批量走额度，见资源包）</div></div>';
}

async function loadFinder(){
  if (FINDER_TRIED || B.kind !== 'video' || !B.preview.author) return;
  FINDER_TRIED = true;
  try {
    const r = await fetch(purl('finder'), { cache: 'no-store' });
    if (!r.ok) { const el = document.getElementById('findercard'); if (el) el.remove(); return; }
    FINDER_DATA = await r.json();
    const el = document.getElementById('findercard');
    if (el) { if (FINDER_DATA.items && FINDER_DATA.items.length) el.outerHTML = finderInner(FINDER_DATA); else el.remove(); }
  } catch { const el = document.getElementById('findercard'); if (el) el.remove(); }
}

/** 常见问题（折叠 */
function faqCard(){
  const qa = [
    ['支付后解析失败，会白花钱吗？', '不会。下单前已做真实解析预检，预检不过根本不会创建订单；支付后若解析失败，费用<b>自动全额退款、原路退回</b>，无需任何申请。'],
    ['收款安全吗？', '微信支付<b>官方商户通道</b>（Native 扫码支付），不是个人收款码；支付后在微信「服务-钱包-账单」可查官方凭证。'],
    ['视频文件存在哪？会云端保存吗？', '不做云端保存。解析取得腾讯 CDN <b>原画直链</b>后，由助手下载到<b>你电脑的本地</b>——本地文件是唯一副本，请妥善保管。'],
    ['和小程序免费下载有什么区别？', '三点：①<b>原画直链</b>，非第三方转存降质；②<b>全程自动</b>，本地零配置，还能批量下载达人全部作品；③<b>失败退款</b>。免费通道适合单条手动自取。'],
    ['支付成功后多久出结果？', '通常<b>几秒到十几秒</b>（本单下单时已预解析），本页自动跳转，无需刷新。'],
    ['二维码扫不了 / 订单过期了？', '订单 15 分钟内有效，过期未支付<b>不扣任何费用</b>；回到对话对助手说「重新发起」即可。'],
  ];
  return '<div class="card faq"><h2>常见问题</h2>'
    + qa.map(([q, a]) => '<details><summary>'+q+'</summary><div class="a">'+a+'</div></details>').join('')
    + '</div>';
}

function grantedPreview(){
  const g = B.granted || {};
  return '<div class="card"><h2>支付后到账</h2><div class="meta">资源包 '+esc(B.package)+'：<b>'+(g.link_quota||0)+' 条直链额度</b>'
    + (g.search_credits?' + <b>'+g.search_credits+' 次百条检索</b>':'')+'，即时到账、永久有效、售出不退。</div>'
    + '<div class="grid" style="margin-top:10px">' + Object.entries(B.packages).map(([n,p]) =>
      '<div class="pkg'+(n===B.package?' cur':'')+'"><div class="n">'+PKG_NAMES[n]+'</div>'
      + '<div class="p">'+yuan(p.amount_cents)+'</div>'
      + '<div class="g"><b>'+p.link_quota+'</b> 条直链</div></div>').join('') + '</div></div>';
}

// 卡片套壳：c-* 类控制手机 order；桌面由 col-left/col-right 两个堆叠容器分栏
const wrap = (area, html) => html ? '<div class="c-'+area+'">'+html+'</div>' : '';

function render(){
  const s = B.status;
  if (s === 'pending') {
    app.innerHTML = '<div class="cols">'
      + '<div class="col-left">'
      + wrap('info', videoInfoCard())
      + wrap('finder', finderCard())
      + (B.kind === 'package' ? wrap('full', grantedPreview()) : '')
      + '</div><div class="col-right">'
      + wrap('pay', payCard())
      + wrap('wallet', walletCard())
      + wrap('pkgpay', pkgPayCard())
      + wrap('free', freeCard())
      + '</div>'
      + wrap('pkg', pkgCard())
      + wrap('faq', faqCard())
      + '</div>';
  } else if (s === 'paid' || s === 'resolving') {
    app.innerHTML = '<div class="cols">'
      + '<div class="col-left">'
      + wrap('info', videoInfoCard())
      + wrap('full', '<div class="card"><div class="spinner"></div><div class="state-title">支付成功，正在解析视频源…</div><div class="meta" style="text-align:center;margin-top:6px">解析完成前请勿关闭本页对应的对话。</div></div>')
      + '</div><div class="col-right">'
      + wrap('pkgpay', pkgPayCard())
      + '</div></div>';
  } else if (s === 'resolved') {
    const m = [];
    if (B.meta.fileSize) m.push('体积 <b>'+bytes(B.meta.fileSize)+'</b>');
    if (B.meta.durationS != null) m.push('时长 <b>'+dur(B.meta.durationS)+'</b>');
    if (B.meta.width) m.push('分辨率 <b>'+B.meta.width+'×'+B.meta.height+'</b>');
    app.innerHTML = '<div class="cols">'
      + '<div class="col-left">'
      + wrap('info', videoInfoCard())
      + wrap('full', '<div class="card"><div class="state-icon">✅</div><div class="state-title ok">解析完成</div>'
        + (m.length?'<div class="meta" style="text-align:center;margin-top:8px">'+m.join(' · ')+'</div>':'')
        + '<div class="meta" style="text-align:center;margin-top:6px">正在下载到本地，回到对话窗口查看<span class="ok">文件保存路径</span>。</div></div>')
      + '</div><div class="col-right">'
      + wrap('pkgpay', pkgPayCard())
      + '</div></div>';
  } else if (s === 'credited') {
    const g = B.granted || {};
    app.innerHTML = wrap('full', '<div class="card"><div class="state-icon">🎉</div><div class="state-title">权益已到账</div>'
      + '<div class="meta" style="text-align:center;margin-top:8px">资源包 '+esc(B.package)+'：<b>'+(g.link_quota||0)+' 条直链额度</b>'
      + (g.search_credits?' + <b>'+g.search_credits+' 次百条检索</b>':'')+'（永久有效）</div>'
      + '<div class="meta" style="text-align:center;margin-top:6px">回到对话窗口继续，说「继续」即可开始批量下载。</div></div>');
  } else if (s === 'expired' || s === 'refunded') {
    // 终止但未成交：给双出口——①回对话重新发起（¥1 按次）②本页直购资源包后用额度下载（免再付 ¥1）。
    // 已购权益（pkgpay/wallet）保留展示；套餐/免费/FAQ 留在页面，买完套餐的完整路径在本页闭环。
    const expired = s === 'expired';
    const hasQuota = WALLET_INFO && WALLET_INFO.quota > 0;
    const stateCard = '<div class="card">'
      + '<div class="state-icon">'+(expired?'⏱️':'💸')+'</div>'
      + '<div class="state-title">'+(expired?'订单已过期（未支付，未扣费）':'解析失败，费用已原路退回')+'</div>'
      + (hasQuota
        ? '<div class="meta" style="margin-top:8px"><b>你的钱包还有 '+WALLET_INFO.quota+' 条额度</b>——无需再付这 ¥1：</div>'
          + '<div class="meta">复制下方钱包码，回到对话粘贴并对助手说「<b>用额度下载这条</b>」。</div>'
        : '<div class="meta" style="margin-top:8px">两条路继续：</div>'
          + '<div class="meta">① 回到对话对助手说「<b>重新发起</b>」——按次 ¥1；</div>'
          + '<div class="meta">② 本页直接买资源包（右侧）——到账后复制钱包码回对话说「用额度下载这条」，<b>免再付 ¥1</b>，还能批量下载达人作品。</div>')
      + '</div>';
    app.innerHTML = '<div class="cols">'
      + '<div class="col-left">'
      + wrap('full', stateCard)
      + '</div><div class="col-right">'
      + wrap('wallet', walletCard())
      + wrap('pkgpay', pkgPayCard())
      + wrap('free', freeCard())
      + '</div>'
      + wrap('pkg', pkgCard())
      + wrap('faq', faqCard())
      + '</div>';
  } else {
    app.innerHTML = wrap('full', '<div class="card"><div class="state-icon">⚠️</div><div class="state-title">订单异常（'+esc(s)+'）</div><div class="meta" style="text-align:center;margin-top:6px">请回到对话说明情况。</div></div>') + wrap('pkgpay', pkgPayCard());
  }
}

// 渲染后统一挂事件（图片失败兜底 + 按钮 + 同达人懒加载），不用内联 handler（引号嵌套坑）
function renderAll(){
  const oldBar = document.getElementById('paybar');
  if (oldBar) oldBar.remove();
  render();
  app.querySelectorAll('img').forEach(im => im.addEventListener('error', () => im.remove(), { once: true }));
  app.querySelectorAll('[data-cd]').forEach(el => countdowns.push({ el, at: Number(el.dataset.cd) }));
  app.querySelectorAll('[data-act=buy]').forEach(b => b.addEventListener('click', () => buyPkg(b.dataset.pkg)));
  app.querySelectorAll('[data-act=copy-wallet]').forEach(b => b.addEventListener('click', () => copyText(WALLET, b)));
  app.querySelectorAll('[data-act=copy-link]').forEach(b => b.addEventListener('click', () => copyText(B.shareUrl, b)));
  loadFinder();
  setupPaybar();
}

/** 移动端悬浮支付条：支付码卡（本单或页面直购）滚出视口才浮现，点击平滑滚回 */
function setupPaybar(){
  if (B.status !== 'pending') return;
  if (!(typeof matchMedia === 'function' && matchMedia('(max-width:760px)').matches)) return;
  const target = document.getElementById('pkgcard') || document.getElementById('paycard');
  if (!target || document.getElementById('paybar')) return;
  const isPkg = target.id === 'pkgcard';
  const amt = isPkg ? PKG.amount_cents : B.amountCents;
  const at = isPkg ? PKG.expire_at : B.expireAt;
  const bar = document.createElement('div');
  bar.className = 'paybar'; bar.id = 'paybar';
  bar.innerHTML = '<div><span class="pb-price">'+yuan(amt)+'</span>'
    + '<span class="pb-cd" data-cd="'+at+'">--:--</span></div>'
    + '<button class="pb-btn">去支付</button>';
  bar.querySelector('button').addEventListener('click', () => target.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  document.body.appendChild(bar);
  countdowns.push({ el: bar.querySelector('.pb-cd'), at });
  new IntersectionObserver(es => { for (const en of es) bar.classList.toggle('show', !en.isIntersecting); }, { threshold: .1 }).observe(target);
}

function copyText(t, btn){
  const done = ok => { if (btn) { btn.textContent = ok ? '已复制 ✓' : '复制失败，手动选择'; setTimeout(()=>{ if(btn) btn.textContent = btn.dataset.orig; }, 2000); } };
  if (btn) { btn.dataset.orig = btn.textContent; }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(()=>done(true)).catch(()=>fallback());
  else fallback();
  function fallback(){
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.remove(); done(ok);
  }
}

// 本地倒计时（纯时间运算；临期变色：<3min 橙、<60s 红脉动；到期显示已截止）
let countdowns = [];
function tick(){
  countdowns = countdowns.filter(({el}) => document.contains(el));
  for (const {el, at} of countdowns) {
    const left = at - Date.now()/1000;
    if (left <= 0) { el.textContent = '已截止'; el.classList.remove('cd-warn','cd-danger'); continue; }
    const m = Math.floor(left/60), s = Math.floor(left%60);
    el.textContent = '剩余 '+m+':'+String(s).padStart(2,'0');
    el.classList.toggle('cd-warn', left <= 180 && left > 60);
    el.classList.toggle('cd-danger', left <= 60);
  }
  setTimeout(tick, 1000);
}

// ---- 页面直购：点套餐 → 本页出码 → 轮询到账 → 展示钱包码 ----
async function buyPkg(n){
  const btn = app.querySelector('[data-act=buy][data-pkg="'+n+'"]');
  if (btn) { btn.disabled = true; btn.textContent = '出码中…'; }
  try {
    const r = await fetch('/p/'+encodeURIComponent(B.id)+'/package', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: n, token: T, user_token: WALLET || undefined }),
    });
    const j = await r.json();
    if (!r.ok) { alert(j.message || '下单失败，请回对话购买'); renderAll(); return; }
    WALLET = j.user_token;
    localStorage.setItem('sph_user_token', WALLET);
    PKG = { order_id: j.order_id, order_token: j.order_token, package: j.package,
            amount_cents: j.amount_cents, expire_at: j.expire_at,
            code_url: j.code_url, qr_data: j.qr_data,
            granted: j.granted, credited: false };
    renderAll();
    pollPkg();
  } catch (e) {
    alert('网络异常：' + e.message);
    renderAll();
  }
}

async function pollPkg(){
  if (!PKG || PKG.credited) return;
  try {
    const r = await fetch('/api/order/'+encodeURIComponent(PKG.order_id)+'/status?token='+encodeURIComponent(PKG.order_token), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j.status === 'credited') {
        PKG.credited = true;
        renderAll();
        fetchWalletInfo();          // 刷新余额卡
        if (!WALLET_MODAL_SHOWN) { WALLET_MODAL_SHOWN = true; showWalletModal(); }
        return;
      }
      if (['refunded','failed','expired'].includes(j.status)) { PKG = null; renderAll(); return; }
    }
  } catch {}
  setTimeout(pollPkg, 3000);
}

/** 到账弹窗：钱包码必须被明确复制/保存后才关闭；关闭后卡内仍留有码 */
function showWalletModal(){
  const g = PKG?.granted || {};
  const m = document.createElement('div');
  m.className = 'modal'; m.id = 'walletModal';
  m.innerHTML = '<div class="mcard">'
    + '<div class="state-icon">🎉</div><div class="state-title ok">套餐已到账</div>'
    + '<div class="meta" style="margin-top:4px">资源包 '+esc(PKG?.package||'')+'：<b>'+ (g.link_quota||0) + ' 条视频额度</b>'
    + (g.search_credits?' + <b>'+g.search_credits+' 次百条列表</b>':'') +'（永久有效）</div>'
    + '<div class="code">'+esc(WALLET)+'</div>'
    + '<div class="warn">⚠️ <b>钱包码是余额的唯一凭证，丢失无法找回。</b>请立即复制保存：<br>① 粘贴回对话窗口，助手用额度继续下载（本视频也免再付 ¥1）；<br>② 自行留存——换设备/换对话粘贴同一码即可续用余额。</div>'
    + '<div class="btns"><button class="btn primary" data-act="copy-wallet">复制钱包码</button>'
    + '<button class="btn" data-act="close-modal">我已保存，关闭</button></div></div>';
  document.body.appendChild(m);
  document.body.style.overflow = 'hidden'; // 弹窗期间锁背景滚动，关闭时恢复
  m.querySelector('[data-act=copy-wallet]').addEventListener('click', e => copyText(WALLET, e.currentTarget));
  m.querySelector('[data-act=close-modal]').addEventListener('click', () => { m.remove(); document.body.style.overflow = ''; });
}

// 同源轮询主订单状态；终态即停
const POLL = { pending: 5000, paid: 3000, resolving: 3000 };
async function poll(){
  try {
    const r = await fetch('/api/order/'+encodeURIComponent(B.id)+'/status?token='+encodeURIComponent(T), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j.status !== B.status) { B.status = j.status; renderAll(); }
      const wait = POLL[B.status];
      if (wait) { setTimeout(poll, wait); return; }
    }
  } catch (e) { /* 网络抖动，按原节奏重试 */ }
  if (POLL[B.status]) setTimeout(poll, POLL[B.status]);
}

renderAll(); tick(); if (POLL[B.status]) poll(); fetchWalletInfo();
</script>
</body>
</html>`;
}

function renderErrorPage(code) {
  const msg = code === 404 ? '订单不存在' : '链接无效或已失效';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${MP_NAME}</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f6f7f8;color:#1a1a1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.c{background:#fff;border:1px solid #ececec;border-radius:14px;padding:32px 28px;text-align:center;max-width:320px}
a{color:#8a8a8a;font-size:12px;text-decoration:none}</style></head>
<body><div class="c"><div style="font-size:30px">🔍</div><p style="margin:10px 0 4px;font-weight:600">${msg}</p>
<p style="font-size:13px;color:#8a8a8a;margin:0 0 12px">请回到对话窗口重新获取支付链接。</p>
<a href="${COMPANY_URL}" target="_blank" rel="noopener">${COMPANY_NAME}</a></div></body></html>`;
}
