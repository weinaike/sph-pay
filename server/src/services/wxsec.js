/**
 * 微信内容安全服务端 SDK（ESM）
 *
 * 覆盖三个接口（按 2026-09 官方文档核对）：
 *   1. msgSecCheck      POST /wxa/msg_sec_check        2.0 同步，openid 必填
 *   2. imgSecCheck      POST /wxa/img_sec_check        1.0 同步（官方 FAQ：2.0 暂无同步图片接口）
 *                       multipart media 字段，≤1MB，≤750x1334，PNG/JPEG/JPG/GIF，不需要 openid
 *   3. mediaCheckAsync  POST /wxa/media_check_async    2.0 异步，只支持图片(2)/音频(1)，不支持视频
 *                       结果 30 分钟内经「消息推送」Event=wxa_media_check 推到开发者服务器
 *
 * 另含 getAccessToken（内存缓存 + 40001 强刷重试）与 code2Session（wx.login code 换 openid）。
 * 纯 Node 原生实现（fetch），零第三方依赖。
 */

const WX_API = 'https://api.weixin.qq.com';

/** 内存 access_token 缓存，按 appid 隔离 */
const tokenCache = new Map(); // appid -> { token, expiresAt }

const nowSec = () => Math.floor(Date.now() / 1000);

async function wxFetch(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 15000), ...opts.http });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`微信接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  return { status: res.status, data };
}

/**
 * 获取 access_token（稳定凭证，与 wx.login 的 code 无关）。
 * @returns {Promise<string>}
 */
export async function getAccessToken(appid, secret, opts = {}) {
  const cached = tokenCache.get(appid);
  if (!opts.force && cached && cached.expiresAt > nowSec() + 300) return cached.token;

  const url =
    `${WX_API}/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
  const { data } = await wxFetch(url);
  if (!data.access_token) {
    // 40013 appid 错 / 40125 secret 错 / 40001 已被别处刷新
    const err = new Error(`获取 access_token 失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
    err.errcode = data.errcode;
    throw err;
  }
  tokenCache.set(appid, { token: data.access_token, expiresAt: nowSec() + (Number(data.expires_in) || 7200) });
  return data.access_token;
}

/** 清空 token 缓存（测试用） */
export function resetTokenCache() {
  tokenCache.clear();
}

/**
 * wx.login 的 code 换 openid。
 * 前提：code 由对应 appid 的小程序前端产生，5 分钟内、只能用一次。
 * @returns {Promise<{openid: string, session_key: string}>}
 */
export async function code2Session(appid, secret, code) {
  const url =
    `${WX_API}/sns/jscode2session?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const { data } = await wxFetch(url);
  if (!data.openid) {
    // 40029 code 无效 / 45011 频率限制 / 40226 高风险用户
    const err = new Error(`code2Session 失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
    err.errcode = data.errcode;
    throw err;
  }
  return { openid: data.openid, session_key: data.session_key };
}

/** 统一包一层：40001 时强刷 token 重试一次 */
async function withTokenRetry(appid, secret, fn) {
  const token = await getAccessToken(appid, secret);
  let r = await fn(token);
  if (r && r.errcode === 40001) {
    const fresh = await getAccessToken(appid, secret, { force: true });
    r = await fn(fresh);
  }
  return r;
}

/**
 * 文本内容安全识别（msgSecCheck 2.0）。
 * @param {object} p - content(≤2500字) / openid(必填) / scene(1资料 2评论 3论坛 4社交日志) / title? / nickname?
 * @returns {Promise<object>} 微信原始返回 { errcode, errmsg, result:{suggest,label}, detail[], trace_id }
 */
export async function msgSecCheck(appid, secret, p) {
  const body = {
    version: 2,
    scene: p.scene || 1,
    openid: p.openid,
    content: String(p.content || ''),
  };
  if (p.title) body.title = p.title;
  if (p.nickname) body.nickname = p.nickname;

  return withTokenRetry(appid, secret, async (token) => {
    const { data } = await wxFetch(`${WX_API}/wxa/msg_sec_check?access_token=${token}`, {
      http: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    });
    return data;
  });
}

/* ---------------- imgSecCheck 辅助 ---------------- */

/** 从 URL 读出图片 Buffer（≤1MB），并识别类型 */
export async function loadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 1024 * 1024) {
    const err = new Error(`图片 ${(buf.length / 1024).toFixed(0)}KB 超过 imgSecCheck 1MB 上限，请改用 mediaCheckAsync(media_type=2)`);
    err.code = 'IMG_TOO_LARGE';
    throw err;
  }
  let mime = 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
  else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
  return { buffer: buf, mime };
}

/** 读 PNG IHDR / JPEG SOF 的宽高；读不出返回 null */
export function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* 忽略，返回 null */ }
  return null;
}

function buildMultipart(boundary, fieldName, filename, mime, buffer) {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), buffer, Buffer.from(tail, 'utf8')]);
}

/**
 * 图片内容安全识别（imgSecCheck 1.0，同步）。
 * @param {object} p - source: 图片 URL
 * @returns {Promise<object>} { errcode, errmsg }  0=正常 87014=内容可能潜在风险
 */
export async function imgSecCheck(appid, secret, p) {
  const img = await loadImage(p.source);
  const size = imageSize(img.buffer);
  if (size && (size.width > 750 || size.height > 1334)) {
    const err = new Error(`图片 ${size.width}x${size.height} 超出 imgSecCheck 限制(750x1334)，请改用 mediaCheckAsync(media_type=2)`);
    err.code = 'IMG_TOO_BIG';
    err.size = size;
    throw err;
  }

  return withTokenRetry(appid, secret, async (token) => {
    const boundary = '----seccheck' + Date.now();
    const body = buildMultipart(boundary, 'media', 'check.jpg', img.mime, img.buffer);
    const { data } = await wxFetch(`${WX_API}/wxa/img_sec_check?access_token=${token}`, {
      timeoutMs: 20000,
      http: {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: new Uint8Array(body),
      },
    });
    return data;
  });
}

/**
 * 多媒体内容安全识别（mediaCheckAsync 2.0，异步）。
 * 只支持图片(2)/音频(1)；结果经「消息推送」Event=wxa_media_check 回调。
 * @param {object} p - mediaUrl(必填) / mediaType(1|2) / openid(必填) / scene
 * @returns {Promise<object>} { errcode, errmsg, trace_id }
 */
export async function mediaCheckAsync(appid, secret, p) {
  const body = {
    media_url: p.mediaUrl,
    media_type: Number(p.mediaType) || 2,
    version: 2,
    scene: p.scene || 1,
    openid: p.openid,
  };
  return withTokenRetry(appid, secret, async (token) => {
    const { data } = await wxFetch(`${WX_API}/wxa/media_check_async?access_token=${token}`, {
      http: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    });
    return data;
  });
}

/** suggest/label 的中文说明 */
export const LABEL_TEXT = {
  100: '正常',
  10001: '广告',
  20001: '时政',
  20002: '色情',
  20003: '辱骂',
  20006: '违法犯罪',
  20008: '欺诈',
  20012: '低俗',
  20013: '版权',
  21000: '其他',
};

/** 综合判定：2.0 看 result.suggest；1.0 看 errcode 87014 */
export function judge(r) {
  if (!r) return { pass: false, reason: 'no-response' };
  if (typeof r.errcode !== 'number') return { pass: false, reason: 'bad-response' };
  if (r.errcode !== 0) return { pass: false, reason: `errcode-${r.errcode}`, errcode: r.errcode };
  if (r.result) return { pass: r.result.suggest !== 'risky', suggest: r.result.suggest, label: r.result.label };
  return { pass: r.errmsg === 'ok', suggest: r.errmsg === 'ok' ? 'pass' : 'risky' };
}
