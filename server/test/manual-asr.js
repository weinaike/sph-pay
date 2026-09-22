#!/usr/bin/env node
/**
 * 火山豆包「单向流式语音识别」真连通实测（A2M 文字提取通道）：
 *   node test/manual-asr.js [--wav <已有音频文件>] [--resource-id <id>] [--interval <ms>]
 * 不传 --wav 时用 macOS `say` 现合成一段中文语音再转 16k 单声道 wav。
 * ARK_API_KEY 优先取环境变量，其次读 ../deploy/sph.env。
 * 实证点：resource id 是否开通、nostream 不限速发送是否被断开（被断开则 --interval 200 重试）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../src/config.js';
import { transcribeStream } from '../src/a2m/volcAsr.js';
import { buildSrt } from '../src/a2m/srt.js';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function resolveApiKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  const envPath = path.resolve(import.meta.dirname, '../../deploy/sph.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*ARK_API_KEY\s*=\s*(\S+)\s*$/);
    if (m) return m[1];
  }
  throw new Error(`未找到 ARK_API_KEY（环境变量或 ${envPath}）`);
}

function prepareWav() {
  const given = argOf('--wav');
  if (given) return given;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-'));
  const aiff = path.join(tmp, 'speech.aiff');
  const wav = path.join(tmp, 'speech.wav');
  execFileSync('say', ['-o', aiff, '-v', 'Tingting', '大家好，这是一段用于测试语音识别的中文音频。今天天气不错，我们聊一聊视频号下载。']);
  execFileSync(config.asr.ffmpegPath, ['-y', '-i', aiff, '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 'wav', wav]);
  return wav;
}

const wavPath = prepareWav();
const stat = fs.statSync(wavPath);
const interval = Number(argOf('--interval') ?? 0);
const opts = {
  apiKey: resolveApiKey(),
  resourceId: argOf('--resource-id') || config.asr.resourceId,
  endpoint: config.asr.endpoint,
  chunkIntervalMs: interval,
  timeoutMs: 120_000,
};
console.log(`[manual-asr] wav=${wavPath} (${(stat.size / 1024).toFixed(0)}KB) resource=${opts.resourceId} interval=${interval}ms endpoint=${opts.endpoint}`);

const t0 = Date.now();
const result = await transcribeStream(Readable.from([fs.readFileSync(wavPath)]), opts);
console.log(`[manual-asr] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s 时长 ${result.durationMs}ms logId=${result.logId}`);
console.log(`[manual-asr] text: ${result.text}`);
console.log(`[manual-asr] utterances: ${result.utterances.length} 句`);
if (result.utterances.length) {
  console.log('[manual-asr] SRT 预览:\n' + buildSrt(result.utterances.slice(0, 5)));
}
if (!result.text.trim()) throw new Error('返回空文本');
console.log('[manual-asr] ✅ 连通与识别正常');
