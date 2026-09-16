// 手动验证自有解析服务全链路（提交 job → 轮询 → HEAD 校准）：
//   node test/manual-resolve.js 'https://weixin.qq.com/sph/<code>'
// 改过 resolverClient / resolveService 后必跑；退出码 0 = 链路健康。
import { normalize } from '../src/sph/normalize.js';
import { resolveOnce } from '../src/services/resolveService.js';

const link = process.argv[2];
if (!link) {
  console.error('用法: node test/manual-resolve.js "<sph 分享链接>"');
  process.exit(1);
}

const norm = normalize(link);
if (!norm.shortUri) {
  console.error(`仅支持短链输入（当前输入归一化为 ${norm.contentId}）`);
  process.exit(1);
}

const t0 = Date.now();
const r = await resolveOnce(`https://weixin.qq.com/sph/${norm.shortUri}`);
console.log(JSON.stringify({
  title: r.title,
  cdn_host: new URL(r.cdnUrl).hostname,
  cdn_url_head: r.cdnUrl.slice(0, 90),
  file_size: r.fileSize,
  enc_len: r.encLen,           // 恒为 0：明文直链
  took_ms: Date.now() - t0,
}, null, 2));
