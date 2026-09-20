import JSONBig from 'json-bigint';
import { config } from '../config.js';

/**
 * 达人检索上游（wx-webtop-old 下载器 API）客户端。
 * 三接口（字段契约来自 wx_channels_download pkg/scraper/wxchannels/types.go）：
 *   GET /api/channels/contact/search?keyword=          → infoList[]（达人）
 *   GET /api/channels/contact/feed/list?username=&next_marker= → object[]（15条/页，lastBuffer 翻页）
 *   GET /api/channels/feed/share_url?oid=               → feedH5Url（weixin.qq.com/sph/xxx）
 * 统一错误：FinderError → 路由层 503 finder_unavailable（runbook：search 超时=微信掉线）。
 */

export class FinderError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'FinderError';
    if (cause) this.cause = cause;
  }
}

// ⚠️ 无损解析：object id 是 20 位数字（超 Number.MAX_SAFE_INTEGER），
// r.json() 会精度丢失成 ...000（上游 Go 端为此写了 flexibleString 兼容，数字 id 是常态）
const jsonBig = JSONBig({ storeAsString: true });

/** GET + 单次网络级重试；HTTP/结构级 FinderError 立即终止不重试 */
async function getJson(path) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${config.finder.base}${path}`, {
        signal: AbortSignal.timeout(config.finder.requestTimeoutMs),
      });
      if (r.status >= 500) throw new FinderError(`上游 HTTP ${r.status}`);
      try {
        return jsonBig.parse(await r.text());
      } catch {
        throw new FinderError('上游响应非 JSON');
      }
    } catch (e) {
      if (e instanceof FinderError) throw e; // HTTP/结构级：确定性失败，不重试
      lastErr = e; // 网络/超时：重试一次（微信掉线最常见的表现就是超时）
    }
  }
  throw new FinderError(`webtop 不可达或超时: ${lastErr?.message}`, { cause: lastErr });
}

function expectOk(body, what) {
  // 外层 {code,msg}：code=400「请先初始化客户端 socket 连接」= 注入断（runbook L2 探活的死法）
  if (!body || typeof body !== 'object') throw new FinderError(`${what}: 响应结构异常`);
  if (body.code !== 0) throw new FinderError(`${what}: ${body.msg || `code=${body.code}`}`);
  const d = body.data;
  if (!d || d.errCode !== 0) throw new FinderError(`${what}: ${d?.errMsg || 'errCode!=0'}`);
  const proto = d.data;
  if (!proto || proto.BaseResponse?.Ret !== 0) {
    throw new FinderError(`${what}: 微信侧错误 Ret=${proto?.BaseResponse?.Ret}`);
  }
  return proto;
}

/* ---------------- 纯函数归一化（单测直测） ---------------- */

/** 达人条目 → 对外形状 */
export function normFinderContact(c) {
  return {
    username: String(c?.username || ''),
    nickname: String(c?.nickname || ''),
    avatar: String(c?.headUrl || ''),
    signature: String(c?.signature || ''),
  };
}

/** search 响应 → { items, continueFlag, lastBuff } */
export function normalizeSearchBody(body) {
  const proto = expectOk(body, '达人检索');
  const items = (proto.infoList || [])
    .map(i => normFinderContact(i.contact))
    .filter(i => i.username && i.username.endsWith('@finder'));
  return { items, continueFlag: proto.continueFlag || 0, lastBuff: proto.lastBuff || '' };
}

/** 作品条目 → 对外形状（id 兼容数字/字符串——上游 flexibleString 的坑；share_url 由调用方补齐） */
export function normFeedObject(o) {
  const m = o?.objectDesc?.media?.[0] || {};
  const desc = String(o?.objectDesc?.description || '').trim();
  return {
    object_id: String(o?.id ?? ''),
    title: (desc.split('\n')[0] || `视频 ${String(o?.id ?? '').slice(-6)}`).slice(0, 80),
    created_at: Number(o?.createtime) || 0,
    duration: Number(m.videoPlayLen) || 0,
    width: Math.round(Number(m.width) || 0),
    height: Math.round(Number(m.height) || 0),
    size: Number(m.fileSize) || 0,
    share_url: null,
  };
}

/** feed/list 响应 → { items, feedsCount(仅首页 >0 可信：续页实测恒 0), total, continueFlag, lastBuffer } */
export function normalizeFeedPageBody(body) {
  const proto = expectOk(body, '达人作品列表');
  const items = (proto.object || []).map(normFeedObject).filter(i => i.object_id);
  const n = Number(proto.feedsCount);
  const feedsCount = n > 0 ? n : null; // ⚠️ 续页 feedsCount=0，不是缺失——0 绝不能覆盖首页总数
  return {
    items,
    feedsCount,
    total: feedsCount ?? items.length, // 兜底展示值；翻页聚合须用 feedsCount（见 pullFullList）
    continueFlag: proto.continueFlag || 0,
    lastBuffer: proto.lastBuffer || '',
  };
}

/** share_url 响应 → 短链 | null */
export function normalizeShareUrlBody(body) {
  const proto = expectOk(body, '短链生成');
  const url = String(proto.feedH5Url || '');
  return url.startsWith('https://weixin.qq.com/sph/') ? url : null;
}

/* ---------------- 上游封装 ---------------- */

export async function searchFinders(keyword) {
  return normalizeSearchBody(await getJson(`/api/channels/contact/search?keyword=${encodeURIComponent(keyword)}`));
}

export async function fetchFeedPage(username, nextMarker = '') {
  let q = `/api/channels/contact/feed/list?username=${encodeURIComponent(username)}`;
  if (nextMarker) q += `&next_marker=${encodeURIComponent(nextMarker)}`;
  return normalizeFeedPageBody(await getJson(q));
}

/** 条目级降级：失败返回 null（计入交付阈值口径，由服务层决定返还） */
export async function shareUrlFor(objectId) {
  try {
    return normalizeShareUrlBody(await getJson(`/api/channels/feed/share_url?oid=${encodeURIComponent(objectId)}`));
  } catch {
    return null;
  }
}
