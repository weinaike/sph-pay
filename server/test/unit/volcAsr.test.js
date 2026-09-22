import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import net from 'node:net';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';

const {
  buildFullRequest, buildAudioRequest, parseResponse, transcribeStream, DEFAULT_CHUNK_BYTES,
} = await import('../../src/a2m/volcAsr.js');

// ---------- 帧构建（对齐官方 protocol.py 的字节级结构） ----------

test('full client request：头/seq/长度/gzip JSON', () => {
  const payload = { audio: { format: 'wav' }, request: { model_name: 'bigmodel' } };
  const frame = buildFullRequest(1, payload);
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x11, 0x11, 0x00]); // 版本1|头长1，类型1|正seq，JSON|GZIP
  assert.equal(frame.readInt32BE(4), 1);
  const size = frame.readUInt32BE(8);
  assert.equal(frame.length, 12 + size);
  assert.deepEqual(zlib.gunzipSync(frame.subarray(12, 12 + size)), Buffer.from(JSON.stringify(payload)));
});

test('audio only request：普通分片与末包（seq 取负）', () => {
  const chunk = Buffer.from('0123456789abcdef');
  const normal = buildAudioRequest(2, chunk, false);
  assert.deepEqual([...normal.subarray(0, 4)], [0x11, 0x21, 0x11, 0x00]); // 类型2|标志0b0001
  assert.equal(normal.readInt32BE(4), 2);
  assert.deepEqual(zlib.gunzipSync(normal.subarray(12)), chunk);

  const last = buildAudioRequest(3, chunk, true);
  assert.deepEqual([...last.subarray(0, 4)], [0x11, 0x23, 0x11, 0x00]); // 类型2|标志0b0011（NEG_WITH_SEQUENCE）
  assert.equal(last.readInt32BE(4), -3);
  assert.deepEqual(zlib.gunzipSync(last.subarray(12)), chunk);
});

// ---------- 响应解析（自造服务端帧） ----------

/** 构造 full server response / error 帧 */
function serverFrame({ messageType = 0b1001, flags = 0b0001, seq = 1, event = null, code = null, payload = null }) {
  const head = Buffer.from([0x11, (messageType << 4) | flags, 0x11, 0x00]);
  const parts = [head];
  if (flags & 0x01) { const b = Buffer.alloc(4); b.writeInt32BE(seq); parts.push(b); }
  if (flags & 0x04) { const b = Buffer.alloc(4); b.writeInt32BE(event ?? 0); parts.push(b); }
  let body = Buffer.alloc(0);
  if (code !== null) { const b = Buffer.alloc(4); b.writeInt32BE(code); body = Buffer.concat([b, body]); }
  if (payload) {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
    const size = Buffer.alloc(4);
    if (messageType === 0b1001) { size.writeUInt32BE(gz.length); body = size; }
    else { const s2 = Buffer.alloc(4); s2.writeUInt32BE(gz.length); body = Buffer.concat([body, s2]); }
    body = Buffer.concat([body, gz]);
  } else if (messageType === 0b1001) { const size = Buffer.alloc(4); body = size; }
  return Buffer.concat([...parts, body]);
}

test('parseResponse：full server response（seq/last/event/payload）', () => {
  const frame = serverFrame({ flags: 0b0111, seq: 42, event: 0, payload: { result: { text: '你好' } } });
  const r = parseResponse(frame);
  assert.equal(r.messageType, 0b1001);
  assert.equal(r.code, 0);
  assert.equal(r.payloadSequence, 42);
  assert.equal(r.isLastPackage, true);
  assert.equal(r.event, 0);
  assert.equal(r.payloadMsg.result.text, '你好');
});

test('parseResponse：error 帧（code + 错误消息）', () => {
  const frame = serverFrame({ messageType: 0b1111, flags: 0b0101, seq: 7, event: 0, code: 45000001, payload: { message: 'audio empty' } });
  const r = parseResponse(frame);
  assert.equal(r.messageType, 0b1111);
  assert.equal(r.code, 45000001);
  assert.equal(r.isLastPackage, false);
  assert.equal(r.payloadMsg.message, 'audio empty');
});

test('parseResponse：非 last 中间帧不置位', () => {
  const frame = serverFrame({ flags: 0b0001, seq: 1, payload: { result: { text: '部分' } } });
  const r = parseResponse(frame);
  assert.equal(r.isLastPackage, false);
  assert.equal(r.payloadMsg.result.text, '部分');
});

// ---------- transcribeStream：本地假服务端全链 ----------

test('transcribeStream：分片发送 + 鉴权头 + 终帧收口（本地 ws 假服务端）', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const sawHeaders = {};
  const received = []; // { type, seq, payload }
  const PORT = await new Promise((r) => wss.on('listening', () => r(wss.address().port)));
  const allFramesSent = new Promise((done) => {
    wss.on('connection', (ws, req) => {
      for (const k of ['x-api-key', 'x-api-resource-id', 'x-api-request-id']) sawHeaders[k] = req.headers[k];
      ws.on('message', (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const messageType = buf[1] >> 4;
        const seq = buf.readInt32BE(4);
        const size = buf.readUInt32BE(8);
        const raw = buf.subarray(12, 12 + size);
        const payload = messageType === 0b0001 ? JSON.parse(zlib.gunzipSync(raw)) : zlib.gunzipSync(raw);
        received.push({ type: messageType, seq, payload });
        if (seq < 0) {
          // 末包已到：回中间帧 + 终帧（full 结果）
          ws.send(serverFrame({ flags: 0b0001, seq: 1, payload: { result: { text: '中间' } } }));
          ws.send(serverFrame({
            flags: 0b0111, seq: 2, event: 0,
            payload: { audio_info: { duration: 1234 }, result: { text: '最终全文', utterances: [{ text: '最终全文', start_time: 0, end_time: 1234 }] } },
          }));
          done();
        }
      });
    });
  });

  const wav = Buffer.alloc(DEFAULT_CHUNK_BYTES * 2 + 100); // 2 整片 + 余量 → 3 片
  const resultPromise = transcribeStream(Readable.from([wav]), {
    apiKey: 'test-key', resourceId: 'volc.test', endpoint: `ws://127.0.0.1:${PORT}/`,
    chunkIntervalMs: 0, timeoutMs: 5_000,
  });
  await Promise.race([
    allFramesSent,
    new Promise((_, rej) => setTimeout(() => rej(new Error('等客户端发帧超时')), 8_000)),
  ]);
  const result = await resultPromise;
  assert.equal(result.text, '最终全文');
  assert.equal(result.durationMs, 1234);
  assert.equal(result.utterances.length, 1);

  assert.equal(sawHeaders['x-api-key'], 'test-key');
  assert.equal(sawHeaders['x-api-resource-id'], 'volc.test');
  assert.ok(sawHeaders['x-api-request-id']);
  const full = received.find((m) => m.type === 0b0001);
  assert.equal(full.seq, 1);
  assert.equal(full.payload.audio.format, 'wav');
  assert.equal(full.payload.request.model_name, 'bigmodel');
  const audioFrames = received.filter((m) => m.type === 0b0010);
  assert.equal(audioFrames.length, 3);
  assert.equal(audioFrames[0].seq, 2);
  assert.equal(audioFrames[1].seq, 3);
  assert.ok(audioFrames[2].seq < 0, '末包 seq 为负');
  assert.equal(audioFrames[0].payload.length, DEFAULT_CHUNK_BYTES);
  assert.equal(audioFrames[2].payload.length, 100);
  await new Promise((r) => wss.close(r));
});

test('transcribeStream：缺 apiKey 直接拒绝', async () => {
  await assert.rejects(
    () => transcribeStream(Readable.from([Buffer.alloc(10)]), { apiKey: '', resourceId: 'r', endpoint: 'ws://x' }),
    /ARK_API_KEY/,
  );
});

test('transcribeStream：服务端错误帧 → AsrError（含 code）', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const PORT = await new Promise((r) => wss.on('listening', () => r(wss.address().port)));
  wss.on('connection', (ws) => {
    ws.on('message', () => {
      ws.send(serverFrame({ messageType: 0b1111, flags: 0b0101, seq: 1, event: 0, code: 45000001, payload: { message: 'bad audio' } }));
    });
  });
  await assert.rejects(
    () => transcribeStream(Readable.from([Buffer.alloc(64)]), {
      apiKey: 'k', resourceId: 'r', endpoint: `ws://127.0.0.1:${PORT}/`, timeoutMs: 5_000,
    }),
    (e) => e.code === 45000001 && /bad audio/.test(e.message),
  );
  await new Promise((r) => wss.close(r));
});
