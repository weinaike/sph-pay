import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import zlib from 'node:zlib';
import WebSocket from 'ws';

/**
 * 火山引擎豆包「单向流式语音识别 WebSocket」（sauc bigmodel_nostream）客户端。
 * 协议对齐官方 demo（docs.volcengine.com 单向流式 ASR 页附带 sauc_python.zip 的 protocol.py）：
 *   wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
 *   Headers: X-Api-Key（ARK_API_KEY，新控制台鉴权）/ X-Api-Resource-Id / X-Api-Request-Id
 *   二进制帧：4B 头 [版本<<4|头长, 类型<<4|标志, 序列化<<4|压缩, 0x00] + BE int32 seq
 *            + BE uint32 payloadSize + gzip(JSON) 载荷；音频帧 payload 为 gzip 的裸字节，
 *            最后一包 seq 取负、标志 NEG_WITH_SEQUENCE。
 *   响应：类型 0b1001 full / 0b1111 error；标志 bit0x01=payloadSequence、bit0x02=is_last_package、
 *            bit0x04=event(int32)。终态 = is_last_package 或 code!=0，最终全文在
 *            payload_msg.result.text，分句（含起止毫秒）在 payload_msg.result.utterances。
 */

const PROTOCOL_V1 = 0b0001;
const MSG_CLIENT_FULL_REQUEST = 0b0001;
const MSG_CLIENT_AUDIO_ONLY = 0b0010;
const MSG_SERVER_FULL_RESPONSE = 0b1001;
const MSG_SERVER_ERROR = 0b1111;
const FLAG_POS_SEQUENCE = 0b0001;
const FLAG_NEG_WITH_SEQUENCE = 0b0011; // 末包：seq 取负
const SERIAL_JSON = 0b0001;
const COMP_GZIP = 0b0001;

/** 16k 单声道 pcm_s16le WAV 的 200ms 分片字节数（16000 样本/s × 2B × 0.2s） */
export const DEFAULT_CHUNK_BYTES = 6400;

export class AsrError extends Error {
  constructor(message, { code = 0, detail = null } = {}) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
    this.detail = detail;
  }
}

function frameHeader(messageType, flags) {
  return Buffer.from([
    (PROTOCOL_V1 << 4) | 0x01, // 头长 1×4 字节
    (messageType << 4) | flags,
    (SERIAL_JSON << 4) | COMP_GZIP,
    0x00,
  ]);
}

/** full client request（首包配置；seq 正数，demo 从 1 起） */
export function buildFullRequest(seq, payload) {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([frameHeader(MSG_CLIENT_FULL_REQUEST, FLAG_POS_SEQUENCE), int32(seq), size, compressed]);
}

/** audio only request（音频分片；isLast 时 seq 取负收口） */
export function buildAudioRequest(seq, chunk, isLast = false) {
  const compressed = zlib.gzipSync(chunk);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([
    frameHeader(MSG_CLIENT_AUDIO_ONLY, isLast ? FLAG_NEG_WITH_SEQUENCE : FLAG_POS_SEQUENCE),
    int32(isLast ? -seq : seq),
    size,
    compressed,
  ]);
}

function int32(v) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
}

/** 解析服务端二进制响应帧（对齐 protocol.py ResponseParser.parse_response） */
export function parseResponse(buf) {
  const headerSize = buf[0] & 0x0f; // 4 字节单位
  const messageType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const serialization = buf[2] >> 4;
  const compression = buf[2] & 0x0f;

  const out = {
    messageType,
    code: 0,
    event: 0,
    isLastPackage: false,
    payloadSequence: 0,
    payloadSize: 0,
    payloadMsg: null,
  };
  let p = buf.subarray(headerSize * 4);
  if (flags & 0x01) {
    out.payloadSequence = p.readInt32BE(0);
    p = p.subarray(4);
  }
  if (flags & 0x02) out.isLastPackage = true;
  if (flags & 0x04) {
    out.event = p.readInt32BE(0);
    p = p.subarray(4);
  }
  if (messageType === MSG_SERVER_FULL_RESPONSE) {
    out.payloadSize = p.readUInt32BE(0);
    p = p.subarray(4);
  } else if (messageType === MSG_SERVER_ERROR) {
    out.code = p.readInt32BE(0);
    out.payloadSize = p.readUInt32BE(4);
    p = p.subarray(8);
  }
  if (!p.length) return out;
  if (compression === COMP_GZIP) {
    try {
      p = zlib.gunzipSync(p);
    } catch {
      return out; // 解压失败按空载荷处理（对齐 demo：记日志不抛）
    }
  }
  if (serialization === SERIAL_JSON) {
    try {
      out.payloadMsg = JSON.parse(p.toString('utf8'));
    } catch { /* 载荷非 JSON 视为空 */ }
  }
  return out;
}

/**
 * 单向流式转写一段 16k 单声道 pcm_s16le WAV 字节流（Readable）。
 * 返回 { text, utterances, durationMs, logId }；失败 reject AsrError。
 * opts: { apiKey, resourceId, endpoint, chunkBytes, chunkIntervalMs, timeoutMs }
 */
export function transcribeStream(wavStream, {
  apiKey, resourceId, endpoint, chunkBytes = DEFAULT_CHUNK_BYTES, chunkIntervalMs = 0, timeoutMs = 300_000,
}) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new AsrError('缺少 ARK_API_KEY（X-Api-Key），无法转写'));
    let settled = false;
    let seq = 1;
    let finalResult = null;
    let lastError = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupStream();
      try { ws.close(); } catch { /* 已关闭 */ }
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupStream();
      try { ws.close(); } catch { /* 已关闭 */ }
      if (finalResult?.result?.text !== undefined) return resolve({
        text: String(finalResult.result.text || ''),
        utterances: Array.isArray(finalResult.result.utterances) ? finalResult.result.utterances : [],
        durationMs: finalResult.audio_info?.duration ?? null,
        logId: finalResult.result?.additions?.log_id ?? null,
      });
      reject(new AsrError(lastError ?? '识别结束但未返回最终结果', { detail: finalResult }));
    };

    const ws = new WebSocket(endpoint, { headers: {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
    } });
    const timer = setTimeout(() => fail(new AsrError(`ASR 超时（${timeoutMs}ms）`)), timeoutMs);

    const onWsMessage = (data) => {
      const resp = parseResponse(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (resp.code !== 0) {
        lastError = `火山 ASR 错误 code=${resp.code}: ${resp.payloadMsg?.message || JSON.stringify(resp.payloadMsg) || ''}`;
        return fail(new AsrError(lastError, { code: resp.code, detail: resp.payloadMsg }));
      }
      if (resp.payloadMsg) finalResult = resp.payloadMsg;
      if (resp.isLastPackage) done();
    };
    ws.on('message', onWsMessage);
    ws.on('error', (err) => fail(new AsrError(`ASR WebSocket 错误: ${err.message}`)));
    ws.on('close', () => { if (!settled) fail(new AsrError('ASR WebSocket 提前关闭（音频未发完或服务端断开）')); });

    // WAV 字节流 → 固定大小分片（含 WAV 头，demo 同款整文件切法）。
    // 上游在 ws open 前保持暂停（flowing 未启动），避免向 CONNECTING 套接字发送；
    // 分片与末包经串行队列发送，await 背压期间不会交错。
    let pending = Buffer.alloc(0);
    let chain = Promise.resolve();
    const enqueue = (fn) => {
      chain = chain.then(fn).catch((e) => {
        fail(e instanceof AsrError ? e : new AsrError(`发送音频失败: ${e.message}`));
      });
    };
    const onStreamError = (err) => fail(new AsrError(`音频流错误: ${err.message}`));
    const sendFrame = async (frame) => {
      const p = ws.send(frame);
      if (p && typeof p.then === 'function') await p; // 背压：等 ws 缓冲排空
    };
    const sendSlices = async () => {
      while (pending.length >= chunkBytes) {
        const piece = pending.subarray(0, chunkBytes);
        pending = pending.subarray(chunkBytes);
        seq += 1;
        await sendFrame(buildAudioRequest(seq, piece, false));
        if (chunkIntervalMs > 0) await sleep(chunkIntervalMs);
      }
    };
    const cleanupStream = () => {
      wavStream.removeListener('error', onStreamError);
      wavStream.destroy?.();
    };
    wavStream.on('error', onStreamError);

    ws.on('open', () => {
      try {
        seq = 1;
        ws.send(buildFullRequest(seq, {
          audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
          request: {
            model_name: 'bigmodel',
            enable_itn: true,       // 口语数字/金额/日期 → 书面形式（文档默认 true）
            enable_punc: true,      // 标点（默认 true）
            show_utterances: true,  // 分句 + 起止毫秒（SRT 用）
            result_type: 'full',    // 每响应带全量结果，取末帧即终稿
          },
        }));
        // open 后才挂 data/end：进入 flowing 模式，此前上游数据只是待读（暂停态）
        wavStream.on('data', (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          enqueue(sendSlices);
        });
        wavStream.on('end', () => {
          enqueue(async () => {
            seq += 1;
            await sendFrame(buildAudioRequest(seq, pending, true)); // 余量即末包（seq 取负；整除边界为空包）
          });
        });
      } catch (e) {
        fail(new AsrError(`发送配置包失败: ${e.message}`));
      }
    });
  });
}
