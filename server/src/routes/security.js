import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import * as wxsec from '../services/wxsec.js';
import { rateLimit, ipOf } from '../middleware/rateLimit.js';

/**
 * 内容安全路由（小程序前端 utils/security.js 的对端）
 *
 * 契约（与 api/seccheck.json 一致）：业务响应 HTTP 恒 200，看 body.code：
 *   code=0    成功，body.data 为业务数据
 *   4001      参数错误
 *   40101     会话缺失/过期（前端收到后强制重新 wx.login 再试一次）
 *   4101      图片超出 imgSecCheck 限制（前端按可跳过处理）
 *   5002/5003 服务端配置缺失 / 微信上游错误
 *
 * 会话：POST /api/auth/login {code} → code2Session 换 openid → 签发 2h skey（内存态，单进程够用）
 * 检测：POST /api/security/{msg,img,media}-check，header X-SKEY
 * 回调：GET/POST /api/security/media-callback（微信「消息推送」入口，mediaCheckAsync 异步结果）
 */

export const authRouter = Router();
export const securityRouter = Router();

const APPID = config.wx.appid;
const SECRET = config.wx.appsecret;
const PUSH_TOKEN = config.sec.pushToken;

/** skey -> { openid, expiresAt }，2 小时（贴合微信「近 2 小时访问过」约束） */
const sessions = new Map();
/** trace_id -> 微信推送的完整事件（mediaCheckAsync 结果），保留 24h */
const mediaResults = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k);
  for (const [k, v] of mediaResults) if (v._storedAt < now - 24 * 3600e3) mediaResults.delete(k);
}, 60e3).unref();

const ok = (data) => ({ code: 0, msg: 'ok', data });
const biz = (code, msg) => ({ code, msg });
const zodMsg = (e) => (e instanceof z.ZodError ? e.issues[0]?.message || '参数错误' : e.message);

/* ---------------- 登录：code 换 skey ---------------- */

authRouter.use(rateLimit({ windowMs: 60_000, max: 10, keyFn: ipOf }));

authRouter.post('/login', async (req, res) => {
  let code;
  try {
    ({ code } = z.object({ code: z.string().min(1).max(128) }).parse(req.body));
  } catch (e) {
    return res.json(biz(4001, zodMsg(e)));
  }
  if (!SECRET) return res.json(biz(5002, '服务端未配置 WX_APPSECRET'));
  try {
    const { openid } = await wxsec.code2Session(APPID, SECRET, code);
    const skey = crypto.randomBytes(24).toString('hex');
    const expiresIn = 7200;
    sessions.set(skey, { openid, expiresAt: Date.now() + expiresIn * 1000 });
    res.json(ok({ skey, expires_in: expiresIn }));
  } catch (e) {
    console.error('[sec/login] code2Session 失败:', e.message);
    res.json(biz(5003, '登录失败，请稍后重试'));
  }
});

/* ---------------- 微信「消息推送」回调（不鉴权，必须在 skey 中间件之前注册） ---------------- */

/** GET 验签：signature=sha1(sort(token,timestamp,nonce))，通过原样回 echostr（纯文本） */
function verifyPushSignature(q) {
  const signature = q.get('signature') || '';
  const timestamp = q.get('timestamp') || '';
  const nonce = q.get('nonce') || '';
  const echostr = q.get('echostr') || '';
  const expected = crypto.createHash('sha1').update([PUSH_TOKEN, timestamp, nonce].sort().join('')).digest('hex');
  return { ok: PUSH_TOKEN && signature === expected, echostr };
}

securityRouter.get('/media-callback', (req, res) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const v = verifyPushSignature(q);
  if (!v.ok) {
    console.warn('[sec/callback] 验签失败：检查后台 Token 是否与 WX_PUSH_TOKEN 一致');
    return res.status(403).end('verify failed');
  }
  res.status(200).end(v.echostr);
});

securityRouter.post('/media-callback', (req, res) => {
  const body = req.body || {};
  if (body.Event === 'wxa_media_check' && body.trace_id) {
    const prev = mediaResults.get(body.trace_id) || {};
    mediaResults.set(body.trace_id, {
      ...prev,
      ...body,
      _storedAt: prev._storedAt || Date.now(),
      status: 'done',
      suggest: body.result?.suggest || '',
      label: body.result?.label || 0,
    });
    console.log('[sec/callback] mediaCheckAsync 结果:', body.trace_id, body.result?.suggest, body.result?.label);
  }
  // 微信要求回 {"errcode":0} 防重推
  res.json({ errcode: 0, errmsg: 'ok' });
});

/** 查询异步结果（运维/排查用）：GET /api/security/media-result?id=<trace_id> */
securityRouter.get('/media-result', (req, res) => {
  const id = req.query.id || '';
  if (!id) return res.json(biz(4001, '缺少参数：id'));
  const r = mediaResults.get(String(id));
  if (!r) return res.json(ok({ status: 'unknown', note: '无此 trace_id 或超过保留期' }));
  res.json(ok({ status: r.status, suggest: r.suggest, label: r.label, event: r }));
});

/* ---------------- 检测端点（skey 鉴权） ---------------- */

securityRouter.use(rateLimit({ windowMs: 60_000, max: 60, keyFn: ipOf }));

/** skey 中间件：校验并挂 req.openid */
securityRouter.use((req, res, next) => {
  const skey = String(req.header('x-skey') || '');
  const s = sessions.get(skey);
  if (!s || s.expiresAt < Date.now()) {
    if (s) sessions.delete(skey);
    return res.json(biz(40101, '会话已过期'));
  }
  req.openid = s.openid;
  next();
});

const sceneSchema = z.number().int().min(1).max(4).optional();

securityRouter.post('/msg-check', async (req, res) => {
  let body;
  try {
    body = z
      .object({
        text: z.string().min(1).max(2500),
        title: z.string().max(512).optional(),
        nickname: z.string().max(128).optional(),
        scene: sceneSchema,
      })
      .parse(req.body);
  } catch (e) {
    return res.json(biz(4001, zodMsg(e)));
  }
  if (!SECRET) return res.json(biz(5002, '服务端未配置 WX_APPSECRET'));
  try {
    const r = await wxsec.msgSecCheck(APPID, SECRET, {
      openid: req.openid, scene: body.scene || 1, content: body.text,
      title: body.title, nickname: body.nickname,
    });
    if (r.errcode !== 0) {
      console.error('[sec/msg-check] 上游错误:', r.errcode, r.errmsg);
      return res.json(biz(5003, `内容检测上游错误 errcode=${r.errcode}`));
    }
    const j = wxsec.judge(r);
    res.json(ok({
      pass: j.pass,
      suggest: j.suggest || '',
      label: j.label || 0,
      labelText: wxsec.LABEL_TEXT[j.label] || '',
      trace_id: r.trace_id || '',
    }));
  } catch (e) {
    console.error('[sec/msg-check] 异常:', e.message);
    res.json(biz(5003, '内容检测服务异常'));
  }
});

securityRouter.post('/img-check', async (req, res) => {
  let body;
  try {
    body = z.object({ url: z.string().url().max(2048), scene: sceneSchema }).parse(req.body);
  } catch (e) {
    return res.json(biz(4001, zodMsg(e)));
  }
  if (!SECRET) return res.json(biz(5002, '服务端未配置 WX_APPSECRET'));
  try {
    const r = await wxsec.imgSecCheck(APPID, SECRET, { source: body.url });
    const j = wxsec.judge(r);
    res.json(ok({
      pass: j.pass,
      suggest: j.suggest || '',
      label: j.pass ? 100 : 21000,
      labelText: j.pass ? wxsec.LABEL_TEXT[100] : '内容可能潜在风险',
      trace_id: '',
    }));
  } catch (e) {
    if (e.code === 'IMG_TOO_LARGE' || e.code === 'IMG_TOO_BIG') {
      return res.json(biz(4101, e.message)); // 前端按可跳过处理
    }
    console.error('[sec/img-check] 异常:', e.message);
    res.json(biz(5003, '图片检测服务异常'));
  }
});

securityRouter.post('/media-check', async (req, res) => {
  let body;
  try {
    body = z
      .object({ url: z.string().url().max(2048), media_type: z.union([z.literal(1), z.literal(2)]).optional(), scene: sceneSchema })
      .parse(req.body);
  } catch (e) {
    return res.json(biz(4001, zodMsg(e)));
  }
  if (!SECRET) return res.json(biz(5002, '服务端未配置 WX_APPSECRET'));
  try {
    const r = await wxsec.mediaCheckAsync(APPID, SECRET, {
      mediaUrl: body.url, mediaType: body.media_type || 2, scene: body.scene || 1, openid: req.openid,
    });
    if (r.errcode !== 0) {
      console.error('[sec/media-check] 上游错误:', r.errcode, r.errmsg);
      return res.json(biz(5003, `媒体检测上游错误 errcode=${r.errcode}`));
    }
    // 异步接口：受理即成功，结果 30 分钟内经 media-callback 推回
    res.json(ok({ pass: true, async: true, trace_id: r.trace_id || '' }));
  } catch (e) {
    console.error('[sec/media-check] 异常:', e.message);
    res.json(biz(5003, '媒体检测服务异常'));
  }
});
