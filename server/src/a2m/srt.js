/**
 * ASR 分句 → SRT 字幕（utterances[].start_time/end_time 毫秒，火山返回字段）。
 */

/** 毫秒 → SRT 时间戳 HH:MM:SS,mmm（负值/缺失按 0 处理） */
export function msToSrtTime(ms) {
  const v = Math.max(0, Math.floor(Number(ms) || 0));
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  const msec = v % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(msec, 3)}`;
}

/** utterances → SRT 全文；无可用分句（缺时间戳/文本）返回空串 */
export function buildSrt(utterances) {
  if (!Array.isArray(utterances)) return '';
  const blocks = [];
  for (const u of utterances) {
    const text = String(u?.text || '').trim();
    if (!text) continue;
    const start = Number.isFinite(Number(u?.start_time)) ? u.start_time : null;
    const end = Number.isFinite(Number(u?.end_time)) ? u.end_time : null;
    if (start === null || end === null) continue;
    blocks.push(`${blocks.length + 1}\n${msToSrtTime(start)} --> ${msToSrtTime(end)}\n${text}\n`);
  }
  return blocks.join('\n');
}
