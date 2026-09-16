import { chromium } from 'playwright';
import { config } from '../config.js';

/**
 * 常驻浏览器池：单 browser / 单 page，串行执行注入函数。
 * - 预热：等待 window.AlgoSign 就绪（VMP SDK 异步初始化）
 * - 心跳：60s 检查一次 AlgoSign 存活，失败自动重启（指数退避）
 * - 串行：VMP SDK 并发行为未知，promise 链互斥
 */
class BrowserPool {
  constructor() {
    this.browser = null;
    this.page = null;
    this.ready = null;          // Promise<void>，ready 即可用
    this.queue = Promise.resolve();
    this.heartbeatTimer = null;
    this.restartBackoff = [5, 15, 60, 300];
    this.restartIdx = 0;
    this.degraded = false;
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: !config.headed,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
      ],
    });
    const ctx = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      viewport: { width: 1366, height: 900 },
    });
    this.page = await ctx.newPage();
    await this.page.goto(config.sph.base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.waitForFunction(() => typeof window.AlgoSign === 'function', null, { timeout: 30000 });
    this.restartIdx = 0;
    this.degraded = false;
  }

  async restart() {
    const wait = this.restartBackoff[Math.min(this.restartIdx, this.restartBackoff.length - 1)];
    this.restartIdx += 1;
    console.error(`[browserPool] ${wait}s 后重启浏览器 (第 ${this.restartIdx} 次)`);
    await this.close();
    await new Promise(r => setTimeout(r, wait * 1000));
    try {
      await this.launch();
      console.error('[browserPool] 重启成功');
    } catch (e) {
      console.error('[browserPool] 重启失败:', e.message);
      if (this.restartIdx >= 5) this.degraded = true;
      throw e;
    }
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = this.launch()
      .then(() => console.error('[browserPool] ready'))
      .catch(e => { console.error('[browserPool] 启动失败:', e.message); throw e; });
    this.startHeartbeat();
    return this.ready;
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try {
        if (!this.page) return;
        const alive = await this.page.evaluate(() => typeof window.AlgoSign === 'function').catch(() => false);
        if (!alive && !this.restarting) {
          this.restarting = true;
          this.restart()
            .catch(() => {})
            .finally(() => { this.restarting = false; });
        }
      } catch { /* 忽略单次心跳异常 */ }
    }, 60_000);
    this.heartbeatTimer.unref?.();
  }

  /** 串行执行页面内函数，自动确保 ready；页面级异常触发一次重启重试 */
  async run(fnSource, arg) {
    await this.start();
    const attempt = async () => {
      await this.start();
      return this.page.evaluate(`(${fnSource})(${JSON.stringify(arg)})`);
    };
    try {
      return await attempt();
    } catch (e) {
      // 页面崩了：重启一次再试
      await this.restart().catch(() => { throw new Error(`browserPool degraded: ${e.message}`); });
      return attempt();
    }
  }

  async close() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.ready = null;
    try { await this.browser?.close(); } catch { /* 忽略 */ }
    this.browser = null;
    this.page = null;
  }
}

export const pool = new BrowserPool();
