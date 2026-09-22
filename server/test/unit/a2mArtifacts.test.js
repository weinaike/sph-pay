import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ⚠️ 必须在 import db.js 之前定死测试库路径（db 模块 import 时即建库）；
// artifacts 目录 = dirname(dbPath)/a2m-artifacts，一并落临时区
process.env.DB_PATH = `/tmp/sph-pay-artifacts-test-${process.pid}/orders.db`;
const { db, a2mArtifacts } = await import('../../src/db.js');
const { config } = await import('../../src/config.js');
const { ensurePipeline, artifactState, artifactFile, artifactUrl, sweepExpiredArtifacts } = await import('../../src/a2m/artifacts.js');

const ROOT = path.join(path.dirname(config.dbPath), 'a2m-artifacts');
const dirOf = (id) => path.join(ROOT, id);

after(() => {
  db.close();
  fs.rmSync(path.dirname(process.env.DB_PATH), { recursive: true, force: true });
});

test('ensure：建行幂等，token 稳定；setStatus 分段更新', () => {
  const row1 = a2mArtifacts.ensure('otn-1', 'tok-aaa');
  assert.equal(row1.audio_status, 'pending');
  assert.equal(row1.asr_status, 'pending');
  const row2 = a2mArtifacts.ensure('otn-1', 'tok-bbb'); // 已存在 → 旧 token 保留
  assert.equal(row2.token, 'tok-aaa');

  a2mArtifacts.setStatus('otn-1', { audioStatus: 'ready' });
  let row = a2mArtifacts.get('otn-1');
  assert.equal(row.audio_status, 'ready');
  assert.equal(row.asr_status, 'pending'); // 音频状态不覆盖 ASR 状态
  a2mArtifacts.setStatus('otn-1', { asrStatus: 'failed', error: 'boom' });
  row = a2mArtifacts.get('otn-1');
  assert.equal(row.asr_status, 'failed');
  assert.equal(row.error, 'boom');
  a2mArtifacts.setStatus('otn-1', { error: null }); // error: null 显式清空
  assert.equal(a2mArtifacts.get('otn-1').error, null);
});

test('ensurePipeline：缺 cdn_url → 双 failed 落终态，且终态不重跑', async () => {
  assert.equal(a2mArtifacts.get('otn-2'), undefined);
  ensurePipeline('otn-2', {}); // 无 cdn_url：ffmpeg 探测后立即失败（或 ffmpeg 缺失同样失败）
  await new Promise((r) => setTimeout(r, 500));
  const row = a2mArtifacts.get('otn-2');
  assert.equal(row.audio_status, 'failed');
  assert.equal(row.asr_status, 'failed');
  assert.ok(row.error);
  const updatedAt = row.updated_at;
  ensurePipeline('otn-2', {}); // 终态重入：不再触发流水线
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a2mArtifacts.get('otn-2').updated_at, updatedAt);
});

test('artifactState/artifactFile：ready 产物 → URL + 内联 text/srt；鉴权与缺失路径', () => {
  const id = 'otn-3';
  const dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio.m4a'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({
    text: '全文文本', srt: '1\n00:00:00,000 --> 00:00:01,000\n全文文本\n', duration_ms: 1000,
  }));
  fs.writeFileSync(path.join(dir, 'transcript.txt'), '全文文本');
  fs.writeFileSync(path.join(dir, 'transcript.srt'), 'srt-body');
  a2mArtifacts.ensure(id, 'tok-3');
  a2mArtifacts.setStatus(id, { audioStatus: 'ready', asrStatus: 'ready' });

  const state = artifactState(id);
  assert.equal(state.audio.status, 'ready');
  assert.equal(state.audio.file_size, 2048);
  assert.ok(state.audio.url.includes(`/api/a2m/artifact/${id}/audio.m4a?token=tok-3`));
  assert.equal(state.transcript.status, 'ready');
  assert.equal(state.transcript.text, '全文文本');
  assert.match(state.transcript.srt, /00:00:01,000/);
  assert.ok(state.transcript.json_url.includes('transcript.json?token=tok-3'));

  // 下载校验：token 错 403、类型未知 400、正常 200 拿文件
  assert.equal(artifactFile(id, 'tok-wrong', 'audio.m4a').error, 403);
  assert.equal(artifactFile(id, 'tok-3', 'evil.exe').error, 400);
  assert.equal(artifactFile(id, 'tok-3', 'transcript.srt').file, path.join(dir, 'transcript.srt'));

  // 无产物行（老订单未触发流水线）→ null
  assert.equal(artifactState('otn-not-exist'), null);
  assert.equal(artifactFile('otn-not-exist', 'x', 'audio.m4a').error, 403);
});

test('artifactState：pending/failed/skipped 状态透出（无 URL）', () => {
  a2mArtifacts.ensure('otn-4', 'tok-4');
  a2mArtifacts.setStatus('otn-4', { asrStatus: 'failed', error: 'ASR 炸了' });
  const state = artifactState('otn-4');
  assert.deepEqual(state.audio, { status: 'pending' });
  assert.deepEqual(state.transcript, { status: 'failed', error: 'ASR 炸了' });

  a2mArtifacts.setStatus('otn-4', { audioStatus: 'skipped' });
  assert.deepEqual(artifactState('otn-4').audio, { status: 'skipped' });
});

test('TTL 清扫：过期目录删除、状态置 expired；未过期保留', () => {
  const fresh = 'otn-fresh';
  fs.mkdirSync(dirOf(fresh), { recursive: true });
  fs.writeFileSync(path.join(dirOf(fresh), 'audio.m4a'), Buffer.alloc(10));
  a2mArtifacts.ensure(fresh, 't');

  const old = 'otn-old';
  fs.mkdirSync(dirOf(old), { recursive: true });
  fs.writeFileSync(path.join(dirOf(old), 'audio.m4a'), Buffer.alloc(10));
  const oldTime = new Date(Date.now() - (config.a2m.artifactTtlHours + 1) * 3600 * 1000);
  fs.utimesSync(dirOf(old), oldTime, oldTime);
  a2mArtifacts.ensure(old, 't');
  a2mArtifacts.setStatus(old, { audioStatus: 'ready', asrStatus: 'ready' });

  sweepExpiredArtifacts();
  assert.ok(fs.existsSync(dirOf(fresh)), '未过期目录保留');
  assert.ok(!fs.existsSync(dirOf(old)), '过期目录删除');
  const row = a2mArtifacts.get(old);
  assert.equal(row.audio_status, 'expired');
  assert.equal(row.asr_status, 'expired');
  const state = artifactState(old); // 状态 ready 但文件没了 → 兜底 expired
  assert.equal(state.transcript.status, 'expired');
});

test('artifactUrl：publicBase + 转义', () => {
  const u = artifactUrl('a2m_abc', 'audio.m4a', 'tok/x');
  assert.equal(u, `${config.publicBase}/api/a2m/artifact/a2m_abc/audio.m4a?token=tok%2Fx`);
});
