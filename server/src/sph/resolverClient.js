/**
 * 自有解析服务客户端（sph.yes-tek.com = wx_channels_download sph-api 的公开 API）。
 * 契约：POST /api/scraper/fetch {url, force_refresh?} → {code:0, data:{id}}；
 *       GET /api/scraper/job?id= → data.status ∈ pending/running/completed/failed/interrupted，
 *       completed 时 data.content.url 为 qq.com 域明文 MP4 直链（无 XOR、无 x-enclen）。
 * 错误分类决定上层重试策略：
 *   ResolverTransientError（网络/超时/提交失败/任务被中断）→ 上层重试；
 *   ResolverFatalError（job failed / 响应结构变化）→ 立即终止进退款，绝不入库脏数据。
 */
import { config } from '../config.js';

export class ResolverError extends Error {}
export class ResolverTransientError extends ResolverError {}
export class ResolverFatalError extends ResolverError {}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** completed 载荷校验（纯函数，供单测）。结构变化是 Fatal：重试无意义。 */
export function validateCompleted(data) {
  const problems = [];
  const url = data?.content?.url;
  if (!url || typeof url !== 'string' || !/^https:\/\//.test(url)) problems.push('content.url 缺失或非 https');
  else if (!/(^|\.)qq\.com$/.test(new URL(url).hostname)) problems.push(`content.url 域名非法 (${new URL(url).hostname})`);
  if (!data?.content?.title) problems.push('content.title 缺失');
  if (problems.length) throw new ResolverFatalError(`解析服务响应结构变化: ${problems.join('; ')}`);
  // 互动计数（可选增强）：上游 sph-api ≥ 计数透传版才有；缺失/非法一律 0，不参与 Fatal 校验
  const toCount = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
  return {
    cdnUrl: url,
    title: String(data.content.title),
    author: String(data?.account?.nickname || ''),
    likeCount: toCount(data?.content?.like_count),
    favCount: toCount(data?.content?.collect_count),       // 收藏（model.Content.collect_count）
    forwardCount: toCount(data?.content?.share_count),     // 转发（model.Content.share_count）
    commentCount: toCount(data?.content?.comment_count),
  };
}

/** 提交解析任务 → 轮询到终态。超时/网络中断抛 Transient。 */
export async function resolveVideo(shareUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? config.sph.resolveTimeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? config.sph.pollIntervalMs;

  const jobId = await submitJob(shareUrl, opts.forceRefresh, fetchImpl);
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let j;
    try {
      j = await fetchJson(fetchImpl, `${config.sph.base}/api/scraper/job?id=${encodeURIComponent(jobId)}`,
        { timeoutMs: config.sph.requestTimeoutMs });
    } catch (e) {
      if (++consecutiveFailures >= 3) throw new ResolverTransientError(`查询解析任务失败: ${e.message}`);
      continue;
    }
    consecutiveFailures = 0;
    const data = j?.data;
    const status = data?.status;
    if (status === 'completed') return validateCompleted(data);
    if (status === 'failed') throw new ResolverFatalError(`解析失败: ${data?.error || '未知错误'}`);
    if (status === 'interrupted') throw new ResolverTransientError(`解析任务被中断: ${data?.error || ''}`);
    if (status && !TERMINAL_STATUSES.has(status) && !['pending', 'running'].includes(status)) {
      throw new ResolverTransientError(`解析任务未知状态: ${status}`);
    }
  }
  throw new ResolverTransientError(`解析超时 (${Math.round(timeoutMs / 1000)}s)`);
}

async function submitJob(shareUrl, forceRefresh, fetchImpl) {
  const body = { url: shareUrl };
  if (forceRefresh) body.force_refresh = true;
  const j = await fetchJson(fetchImpl, `${config.sph.base}/api/scraper/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: config.sph.requestTimeoutMs,
  });
  if (j?.code !== 0 || !j?.data?.id) throw new ResolverTransientError(`提交解析任务失败: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data.id;
}

async function fetchJson(fetchImpl, url, { method = 'GET', headers, body, timeoutMs = config.sph.requestTimeoutMs } = {}) {
  const res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
