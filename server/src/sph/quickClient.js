import { config } from '../config.js';

/** sph 站改版/响应结构异常 → 显式失败，绝不入库脏数据 */
export class SphChangedError extends Error {}
export class BadSignError extends Error {}

const b64Len = (s) => Buffer.from(String(s || ''), 'base64').length;

export const quickClient = {
  /**
   * 调用 /sph/public/quick。签名失效（HTTP 500 或 error 79）抛 BadSignError 由上层重签。
   * 成功时做严格 schema 校验，任何不符抛 SphChangedError。
   */
  async fetch(contentId, sign) {
    const url = `${config.sph.base}/sph/public/quick?id=${encodeURIComponent(contentId)}&sign=${encodeURIComponent(sign)}&_from=&title=`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: config.sph.base + '/',
        Origin: config.sph.base,
      },
    });

    if (res.status === 500) throw new BadSignError('quick 返回 500 (sign 无效)');
    const j = await res.json().catch(() => { throw new SphChangedError(`quick 返回非 JSON (HTTP ${res.status})`); });

    if (j.error === 79) throw new BadSignError('quick error 79 (sign 缺失/失效)');
    if (j.error !== 0) {
      const err = new Error(j.message || `quick error ${j.error}`);
      err.code = j.error;
      throw err; // 业务错误（链接失效/视频不存在等），重签无用
    }

    // schema 校验
    const problems = [];
    if (!j.url || !/^https:\/\//.test(j.url) || !/\.qq\.com$/.test(new URL(j.url).hostname)) problems.push('url 非法');
    if (!j._data || b64Len(j._data) !== 131072) problems.push(`_data 长度异常 (${b64Len(j._data)})`);
    if (!j.media || !j.media.file_size || !j.media.title) problems.push('media 字段缺失');
    if (problems.length) throw new SphChangedError(`sph 站响应结构变化: ${problems.join('; ')}`);

    return j;
  },
};
