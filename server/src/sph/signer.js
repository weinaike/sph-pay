import { pool } from './browserPool.js';
import { config } from '../config.js';

export class SignError extends Error {}

/**
 * AlgoSign 签名器：在常驻页面里执行 sph 站自己的 SDK 生成 _sign。
 * 实测结论（2026-09）：sign 可脱离浏览器在服务端 fetch 复用，TTL 至少数分钟 → 缓存 10min。
 */
class Signer {
  constructor() {
    this.cache = new Map(); // contentId -> { sign, ts }
  }

  async getSign(contentId) {
    const hit = this.cache.get(contentId);
    if (hit && Date.now() - hit.ts < config.sph.signTtlMs) return hit.sign;

    const sign = await pool.run(
      // 在页面上下文执行：返回 undefined 表示被反自动化环境检测拦截
      async ({ id }) => {
        try {
          const s = await new window.AlgoSign({ appId: 'sph' }).sign({ id, path: '/sph/public/quick' });
          return s && s._sign ? s._sign : null;
        } catch (e) {
          return { __err: String(e && e.message || e) };
        }
      },
      { id: contentId }
    );

    if (!sign || typeof sign !== 'string') {
      const detail = sign && sign.__err ? `: ${sign.__err}` : ' (empty _sign — 疑似 headless 被检测，尝试 HEADED=1 xvfb-run)';
      throw new SignError(`AlgoSign 签名失败${detail}`);
    }
    this.cache.set(contentId, { sign, ts: Date.now() });
    return sign;
  }

  invalidate(contentId) {
    this.cache.delete(contentId);
  }

  invalidateAll() {
    this.cache.clear();
  }
}

export const signer = new Signer();
