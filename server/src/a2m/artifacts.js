import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { a2mArtifacts } from '../db.js';
import { transcribeStream, AsrError } from './volcAsr.js';
import { buildSrt } from './srt.js';

/**
 * A2M 履约后置产物流水线：音频提取（ffmpeg 拉 CDN MP4 抽 AAC → m4a）+
 * ASR 转写（m4a → 16k 单声道 wav 流 → 火山豆包单向流式 WS）。
 * 设计约束：绝不抛错到调用方（交付主链路只受视频直链影响）；分阶段落库可轮询；
 * 产物落盘 data/a2m-artifacts/<out_trade_no>/，TTL 过期清扫不自动重跑（防重复 ASR 计费）。
 */

const running = new Map(); // out_trade_no → true（进程内防并发；进程重启靠状态+文件幂等续跑）
let ffmpegAvailable;       // 缓存的 ffmpeg 探测结果

const artifactsRoot = () => path.join(path.dirname(config.dbPath), 'a2m-artifacts');
const dirOf = (outTradeNo) => path.join(artifactsRoot(), outTradeNo);
const AUDIO = 'audio.m4a';
const TRANSCRIPT_TXT = 'transcript.txt';
const TRANSCRIPT_SRT = 'transcript.srt';
const TRANSCRIPT_JSON = 'transcript.json';

function newArtifactToken() {
  return crypto.randomBytes(16).toString('hex'); // 同 util/id.js newOrderToken 模式
}

function execFileP(file, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.stderrText = String(stderr || '').slice(-400);
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

async function probeFfmpeg() {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable;
  try {
    await execFileP(config.asr.ffmpegPath, ['-version'], { timeoutMs: 10_000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    console.error(`[a2m-artifacts] ffmpeg（${config.asr.ffmpegPath}）不可用：音频提取与 ASR 将失败（容器镜像需安装 ffmpeg）`);
  }
  return ffmpegAvailable;
}

/** ffmpeg 抽音轨：优先流拷贝（无损且快），容器不兼容时回退 AAC 重编码 */
async function extractAudio(cdnUrl, outPath) {
  const base = ['-hide_banner', '-loglevel', 'error', '-y',
    '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    '-i', cdnUrl, '-vn'];
  try {
    await execFileP(config.asr.ffmpegPath, [...base, '-acodec', 'copy', '-f', 'ipod', outPath]);
  } catch (e) {
    if (e.killed || /timed out/.test(String(e.message))) throw new Error(`音频提取超时: ${e.stderrText || e.message}`);
    console.warn(`[a2m-artifacts] 音轨流拷贝失败，回退 AAC 重编码: ${e.stderrText || e.message}`);
    await execFileP(config.asr.ffmpegPath, [...base, '-c:a', 'aac', '-b:a', '128k', '-f', 'ipod', outPath]);
  }
  const size = fs.statSync(outPath).size;
  if (size <= 0) throw new Error('音频提取产物为空（视频可能无音轨）');
  return size;
}

/** m4a → 16k 单声道 pcm_s16le WAV 流（stdout），供 ASR 分片直发 */
function wavStream(m4aPath) {
  const p = spawn(config.asr.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', m4aPath,
    '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  p.stderr.on('data', (d) => { if (chunks.length < 10) chunks.push(d); }); // 只留尾部诊断
  p.on('error', (e) => p.stdout.destroy(e));
  const stderrTail = () => Buffer.concat(chunks).toString('utf8').slice(-300);
  return { stdout: p.stdout, stderrTail };
}

async function runTranscription(outTradeNo, m4aPath) {
  const { stdout, stderrTail } = wavStream(m4aPath);
  let result;
  try {
    result = await transcribeStream(stdout, {
      apiKey: config.asr.apiKey,
      resourceId: config.asr.resourceId,
      endpoint: config.asr.endpoint,
      chunkBytes: config.asr.chunkBytes,
      chunkIntervalMs: config.asr.chunkIntervalMs,
      timeoutMs: config.asr.timeoutMs,
    });
  } catch (e) {
    if (e instanceof AsrError) throw new Error(`${e.message}${stdout.errored ? `；ffmpeg: ${stderrTail()}` : ''}`);
    throw e;
  }
  if (!result.text || !result.text.trim()) throw new Error('ASR 返回空文本（视频可能无语音内容）');

  const dir = dirOf(outTradeNo);
  const srt = buildSrt(result.utterances);
  const payload = {
    out_trade_no: outTradeNo,
    text: result.text,
    srt,
    utterances: result.utterances,
    duration_ms: result.durationMs,
    log_id: result.logId,
    provider: { endpoint: config.asr.endpoint, resource_id: config.asr.resourceId },
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, TRANSCRIPT_TXT), result.text, 'utf8');
  fs.writeFileSync(path.join(dir, TRANSCRIPT_SRT), srt, 'utf8');
  fs.writeFileSync(path.join(dir, TRANSCRIPT_JSON), JSON.stringify(payload), 'utf8');
  return payload;
}

/** 流水线主体：文件存在即跳过对应阶段（进程重启/中断后续跑不重复计费 ASR） */
async function runPipeline(outTradeNo, deliverable) {
  const dir = dirOf(outTradeNo);
  fs.mkdirSync(dir, { recursive: true });
  const audioPath = path.join(dir, AUDIO);
  const setStatus = (patch) => a2mArtifacts.setStatus(outTradeNo, patch);

  if (!(await probeFfmpeg())) {
    setStatus({ audioStatus: 'failed', asrStatus: 'failed', error: '服务端 ffmpeg 不可用，音频提取与 ASR 均无法执行' });
    return;
  }
  if (!deliverable?.cdn_url) {
    setStatus({ audioStatus: 'failed', asrStatus: 'failed', error: '订单缺 cdn_url，无法提取音频' });
    return;
  }

  // 阶段 1：音频提取
  if (!fs.existsSync(audioPath)) {
    setStatus({ audioStatus: 'processing', error: null });
    try {
      await extractAudio(deliverable.cdn_url, audioPath);
    } catch (e) {
      setStatus({ audioStatus: 'failed', asrStatus: 'failed', error: `音频提取失败: ${e.stderrText || e.message}` });
      return;
    }
  }
  setStatus({ audioStatus: 'ready' });

  // 阶段 2：ASR 转写（无 Key 优雅跳过，不影响已 ready 的音频）
  if (!config.asr.apiKey) {
    setStatus({ asrStatus: 'skipped', error: '未配置 ARK_API_KEY，文字提取未执行' });
    return;
  }
  if (!fs.existsSync(path.join(dir, TRANSCRIPT_JSON))) {
    setStatus({ asrStatus: 'processing' });
    try {
      await runTranscription(outTradeNo, audioPath);
    } catch (e) {
      setStatus({ asrStatus: 'failed', error: `文字提取失败: ${e.message}` });
      return;
    }
  }
  setStatus({ asrStatus: 'ready', error: null });
}

/** 首次履约/重放时调用：幂等建行 + 触发异步流水线（fire-and-forget），返回当前行 */
export function ensurePipeline(outTradeNo, deliverable) {
  let row = a2mArtifacts.get(outTradeNo);
  if (!row) row = a2mArtifacts.ensure(outTradeNo, newArtifactToken());
  const settled = (s) => !['pending', 'processing'].includes(s);
  if (settled(row.audio_status) && settled(row.asr_status)) return row; // 终态（ready/failed/skipped/expired）不重跑
  if (running.has(outTradeNo)) return row;
  running.set(outTradeNo, true);
  console.log(`[a2m-artifacts] 启动产物流水线 outTradeNo=${outTradeNo}`);
  runPipeline(outTradeNo, deliverable)
    .then(() => console.log(`[a2m-artifacts] 流水线结束 outTradeNo=${outTradeNo}`))
    .catch((e) => {
      // 兜底：分阶段 catch 之外的意外错误也落终态，避免客户端永远轮询 processing
      console.error(`[a2m-artifacts] 流水线异常 outTradeNo=${outTradeNo}:`, e);
      a2mArtifacts.setStatus(outTradeNo, { audioStatus: 'failed', asrStatus: 'failed', error: `内部错误: ${e.message}` });
    })
    .finally(() => running.delete(outTradeNo));
  return a2mArtifacts.get(outTradeNo);
}

/** 产物下载 URL（只随已验付交付响应出现；token 在 a2m_artifacts 行内） */
export function artifactUrl(outTradeNo, kind, token) {
  return `${config.publicBase}/api/a2m/artifact/${encodeURIComponent(outTradeNo)}/${kind}?token=${encodeURIComponent(token)}`;
}

const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return null; } };

/** 组装交付响应里的 audio/transcript 状态对象；无产物行（老订单未触发流水线）返回 null */
export function artifactState(outTradeNo) {
  const row = a2mArtifacts.get(outTradeNo);
  if (!row) return null;
  const dir = dirOf(outTradeNo);
  const audioPath = path.join(dir, AUDIO);
  const audio = row.audio_status === 'ready' && fileSize(audioPath)
    ? { status: 'ready', url: artifactUrl(outTradeNo, AUDIO, row.token), file_size: fileSize(audioPath) }
    : { status: row.audio_status, ...(row.audio_status === 'failed' && row.error ? { error: row.error } : {}) };

  let transcript = { status: row.asr_status };
  if (row.asr_status === 'failed' && row.error) transcript.error = row.error;
  if (row.asr_status === 'skipped' && row.error) transcript.error = row.error;
  if (row.asr_status === 'ready') {
    try {
      // 内联 text/srt（KB 量级，客户端免二次拉取）；完整 utterances/words 走 transcript.json
      const j = JSON.parse(fs.readFileSync(path.join(dir, TRANSCRIPT_JSON), 'utf8'));
      transcript = {
        status: 'ready', text: j.text, srt: j.srt || '',
        url: artifactUrl(outTradeNo, TRANSCRIPT_TXT, row.token),
        srt_url: artifactUrl(outTradeNo, TRANSCRIPT_SRT, row.token),
        json_url: artifactUrl(outTradeNo, TRANSCRIPT_JSON, row.token),
        duration_ms: j.duration_ms ?? null,
      };
    } catch {
      transcript = { status: 'expired', error: '产物文件已过期清理' };
    }
  }
  return { audio, transcript };
}

/** TTL 清扫（挂 sweeper）：删产物目录并把双状态置 expired；进行中的不动 */
export function sweepExpiredArtifacts() {
  const ttlMs = config.a2m.artifactTtlHours * 3600 * 1000;
  if (ttlMs <= 0) return;
  const root = artifactsRoot();
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return; }
  const nowMs = Date.now();
  for (const name of entries) {
    if (running.has(name)) continue;
    const dir = path.join(root, name);
    try {
      const mtimeMs = fs.statSync(dir).mtimeMs;
      if (nowMs - mtimeMs < ttlMs) continue;
      const row = a2mArtifacts.get(name);
      if (row && (row.audio_status === 'expired' && row.asr_status === 'expired')) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      if (row) {
        a2mArtifacts.setStatus(name, { audioStatus: 'expired', asrStatus: 'expired', error: '产物已过期清理（TTL）' });
        console.log(`[a2m-artifacts] TTL 清扫 outTradeNo=${name}`);
      }
    } catch (e) {
      console.error(`[a2m-artifacts] 清扫失败 ${name}: ${e.message}`);
    }
  }
}

/** 供下载路由校验与取文件 */
export function artifactFile(outTradeNo, token, kind) {
  const allowed = new Set([AUDIO, TRANSCRIPT_TXT, TRANSCRIPT_SRT, TRANSCRIPT_JSON]);
  if (!allowed.has(kind)) return { error: 400 };
  const row = a2mArtifacts.get(outTradeNo);
  if (!row || row.token !== token) return { error: 403 };
  const file = path.join(dirOf(outTradeNo), kind);
  if (!fileSize(file)) return { error: 404 };
  return { file, kind };
}

export const ARTIFACT_FILES = { AUDIO, TRANSCRIPT_TXT, TRANSCRIPT_SRT, TRANSCRIPT_JSON };
