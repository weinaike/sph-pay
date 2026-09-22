import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeMp4Meta } from '../../src/sph/mp4meta.js';

// ---- 测试夹具：手工构造最小 mp4（ftyp + moov(mvhd + trak(tkhd))），配假 fetch 按 Range 切片 ----

function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}

/** mvhd version0: flags(3) created(4) modified(4) timescale(4) duration(4) ... */
function mvhd(timescale, duration) {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box('mvhd', p);
}

/** tkhd：width/height 恒在载荷末 8 字节（16.16 定点） */
function tkhd(w, h) {
  const p = Buffer.alloc(84);
  p.writeInt32BE(w << 16, p.length - 8);
  p.writeInt32BE(h << 16, p.length - 4);
  return box('tkhd', p);
}

function fakeFetchFor(file) {
  return async (_url, { headers }) => {
    const m = /bytes=(\d+)-(\d+)/.exec(headers.Range || '');
    const body = m ? file.subarray(Number(m[1]), Number(m[2]) + 1) : file;
    return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
}

test('probeMp4Meta: faststart 常规载荷（timescale 1000，时长 65s，720p）', async () => {
  const file = Buffer.concat([
    box('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1')),
    box('moov', Buffer.concat([mvhd(1000, 65000), box('trak', tkhd(1280, 720))])),
    box('mdat', Buffer.alloc(32)),
  ]);
  const r = await probeMp4Meta('https://x/', { fetchImpl: fakeFetchFor(file) });
  assert.deepEqual(r, { durationS: 65, width: 1280, height: 720 });
});

test('probeMp4Meta: moov 超出首段 16KB → 二段补拉', async () => {
  const bigTrak = box('trak', tkhd(1920, 1088));
  const moov = box('moov', Buffer.concat([mvhd(90000, 90000 * 12), bigTrak, Buffer.alloc(40 * 1024)])); // ~40KB moov
  const file = Buffer.concat([box('ftyp', Buffer.alloc(16)), moov, box('mdat', Buffer.alloc(16))]);
  let calls = 0;
  const fetchImpl = async (u, o) => { calls++; return fakeFetchFor(file)(u, o); };
  const r = await probeMp4Meta('https://x/', { fetchImpl });
  assert.equal(calls, 2); // 首段 16KB + 按 moov size 精确补拉
  assert.deepEqual(r, { durationS: 12, width: 1920, height: 1088 });
});

test('probeMp4Meta: 无 moov / 网络失败 / 超大 moov → 全 null 不抛', async () => {
  const noMoov = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(64))]);
  assert.deepEqual(await probeMp4Meta('https://x/', { fetchImpl: fakeFetchFor(noMoov) }),
    { durationS: null, width: null, height: null });

  const fail = async () => { throw new Error('net'); };
  assert.deepEqual(await probeMp4Meta('https://x/', { fetchImpl: fail }),
    { durationS: null, width: null, height: null });

  const huge = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', Buffer.alloc(5 * 1024 * 1024))]);
  assert.deepEqual(await probeMp4Meta('https://x/', { fetchImpl: fakeFetchFor(huge) }),
    { durationS: null, width: null, height: null });
});

test('probeMp4Meta: mvhd version1（64bit duration）', async () => {
  const p = Buffer.alloc(108);
  p.writeUInt8(1, 0); // version
  p.writeUInt32BE(1000, 20); // flags(3)+created(8)+modified(8) → timescale @20
  p.writeBigUInt64BE(61000n, 24);
  const file = Buffer.concat([
    box('ftyp', Buffer.alloc(8)),
    box('moov', Buffer.concat([box('mvhd', p), box('trak', tkhd(1080, 1920))])),
  ]);
  const r = await probeMp4Meta('https://x/', { fetchImpl: fakeFetchFor(file) });
  assert.deepEqual(r, { durationS: 61, width: 1080, height: 1920 });
});
