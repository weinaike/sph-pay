/**
 * 风险前置验证：headless 浏览器能否生成有效 sign 并走通 quick。
 * 用法: node test/manual-sign.js 'https://weixin.qq.com/sph/AzGEWrdqgP'
 * 失败时: HEADED=1 xvfb-run -a node test/manual-sign.js '...'
 */
import { normalize } from '../src/sph/normalize.js';
import { signer } from '../src/sph/signer.js';
import { quickClient } from '../src/sph/quickClient.js';
import { pool } from '../src/sph/browserPool.js';
import { config } from '../src/config.js';

const link = process.argv[2] || 'https://weixin.qq.com/sph/AzGEWrdqgP';

const { contentId } = normalize(link);
console.log(`contentId: ${contentId}`);
console.log(`SPH_BASE:  ${config.sph.base}\n`);

try {
  const t0 = Date.now();
  const sign = await signer.getSign(contentId);
  console.log(`✅ sign 生成成功 (${Date.now() - t0}ms): ${sign.slice(0, 60)}...`);

  const res = await quickClient.fetch(contentId, sign);
  console.log(`✅ quick 返回: error=${res.error}`);
  console.log(`   title:    ${res.media.title.slice(0, 50)}`);
  console.log(`   url host: ${new URL(res.url).host}`);
  console.log(`   file_size(标称): ${res.media.file_size}`);
  console.log(`   _data 解码长度: ${Buffer.from(res._data, 'base64').length} (期望 131072)`);
  console.log(`\n🎉 全链路 OK`);
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.close();
}
