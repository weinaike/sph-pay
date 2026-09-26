import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVideo, validateCompleted, ResolverTransientError, ResolverFatalError,
} from '../../src/sph/resolverClient.js';

const SUBMIT_OK = { code: 0, data: { id: 'fetch-abc' } };
const OPTS = { pollIntervalMs: 1, timeoutMs: 5000 };

const completedBody = {
  data: {
    status: 'completed',
    content: { url: 'https://finder.video.qq.com/302/20304/abcde.mp4', title: '演示标题' },
    account: { nickname: '作者' },
  },
};

/** submit 响应 + 轮询队列；轮询耗尽后重复最后一个响应 */
function mockFetch({ submit = SUBMIT_OK, polls = [completedBody] } = {}) {
  const calls = [];
  const queue = [...polls];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const json = obj => ({ ok: true, status: 200, json: async () => obj });
    if (String(url).includes('/api/scraper/fetch')) {
      if (submit instanceof Error) throw submit;
      return json(typeof submit === 'function' ? submit(opts) : submit);
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return json(next);
  };
  impl.calls = calls;
  return impl;
}

// ---- validateCompleted 纯函数 ----

test('validateCompleted: 合法载荷', () => {
  const r = validateCompleted(completedBody.data);
  assert.equal(r.cdnUrl, 'https://finder.video.qq.com/302/20304/abcde.mp4');
  assert.equal(r.title, '演示标题');
  assert.equal(r.author, '作者');
});

test('validateCompleted: 互动计数透传（新上游）', () => {
  const r = validateCompleted({
    ...completedBody.data,
    content: {
      ...completedBody.data.content,
      like_count: 12000, collect_count: 356, share_count: 89, comment_count: 2048,
    },
  });
  assert.equal(r.likeCount, 12000);
  assert.equal(r.favCount, 356);
  assert.equal(r.forwardCount, 89);
  assert.equal(r.commentCount, 2048);
});

test('validateCompleted: 计数缺失/非法归零（旧上游/滚动部署期）', () => {
  const base = validateCompleted(completedBody.data);
  assert.equal(base.likeCount, 0);
  assert.equal(base.favCount, 0);
  assert.equal(base.forwardCount, 0);
  assert.equal(base.commentCount, 0);

  const dirty = validateCompleted({
    ...completedBody.data,
    content: { ...completedBody.data.content, like_count: 'x', collect_count: -5 },
  });
  assert.equal(dirty.likeCount, 0);
  assert.equal(dirty.favCount, 0);
});

test('validateCompleted: 非 qq 域名 → Fatal', () => {
  assert.throws(
    () => validateCompleted({ ...completedBody.data, content: { url: 'https://evil.com/x.mp4', title: 't' } }),
    ResolverFatalError,
  );
});

test('validateCompleted: 缺 title → Fatal', () => {
  assert.throws(
    () => validateCompleted({ status: 'completed', content: { url: 'https://finder.video.qq.com/x.mp4' } }),
    ResolverFatalError,
  );
});

test('validateCompleted: 非 https → Fatal', () => {
  assert.throws(
    () => validateCompleted({ content: { url: 'http://finder.video.qq.com/x.mp4', title: 't' } }),
    ResolverFatalError,
  );
});

// ---- resolveVideo 状态机 ----

test('pending → running → completed 序列', async () => {
  const f = mockFetch({ polls: [
    { data: { status: 'pending' } },
    { data: { status: 'running' } },
    completedBody,
  ] });
  const r = await resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f });
  assert.equal(r.cdnUrl, 'https://finder.video.qq.com/302/20304/abcde.mp4');
});

test('failed → Fatal 且带 error 信息', async () => {
  const f = mockFetch({ polls: [{ data: { status: 'failed', error: 'cookie 失效' } }] });
  await assert.rejects(
    resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f }),
    e => e instanceof ResolverFatalError && e.message.includes('cookie 失效'),
  );
});

test('interrupted → Transient', async () => {
  const f = mockFetch({ polls: [{ data: { status: 'interrupted', error: '' } }] });
  await assert.rejects(
    resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f }),
    ResolverTransientError,
  );
});

test('未知状态 → Transient', async () => {
  const f = mockFetch({ polls: [{ data: { status: 'weird_state' } }] });
  await assert.rejects(
    resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f }),
    ResolverTransientError,
  );
});

// ---- 提交阶段 ----

test('提交 code≠0 → Transient', async () => {
  const f = mockFetch({ submit: { code: 1001, message: 'invalid url' } });
  await assert.rejects(
    resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f }),
    ResolverTransientError,
  );
});

test('force_refresh 时提交体带 force_refresh', async () => {
  let seen = null;
  const f = mockFetch({ submit: (opts) => { seen = JSON.parse(opts.body); return SUBMIT_OK; } });
  await resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, forceRefresh: true, fetchImpl: f });
  assert.equal(seen.force_refresh, true);
  assert.equal(seen.url, 'https://weixin.qq.com/sph/Ab12cd');
});

test('默认提交体不带 force_refresh', async () => {
  let seen = null;
  const f = mockFetch({ submit: (opts) => { seen = JSON.parse(opts.body); return SUBMIT_OK; } });
  await resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f });
  assert.equal('force_refresh' in seen, false);
});

// ---- 网络层 ----

test('连续 3 次轮询网络失败 → Transient', async () => {
  const f = mockFetch({ polls: [new Error('ECONNRESET')] });
  await assert.rejects(
    resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f }),
    ResolverTransientError,
  );
});

test('总超时 → Transient', async () => {
  const f = mockFetch({ polls: [{ data: { status: 'running' } }] });
  await assert.rejects(
    resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, timeoutMs: 60, pollIntervalMs: 30, fetchImpl: f }),
    ResolverTransientError,
  );
});

test('completed 但载荷结构破坏 → Fatal', async () => {
  const f = mockFetch({ polls: [{ data: { status: 'completed', content: {} } }] });
  await assert.rejects(
    resolveVideo('https://weixin.qq.com/sph/Ab12cd', { ...OPTS, fetchImpl: f }),
    ResolverFatalError,
  );
});
