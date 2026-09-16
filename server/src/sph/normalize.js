/**
 * 归一化用户输入 → 解析身份。
 *   - weixin.qq.com/sph/<code>                       → <code>##1
 *   - channels.weixin.qq.com/finder-preview/pages/sph…?id=<code> → <code>##1
 *   - export/<id>                                     → export/<id>##2（仅台账，不可解析）
 *   - 微信库 JSON 里的 objectId                       → <数字objectId>（仅台账，不可解析）
 * 返回 { contentId, shortUri|null }：shortUri 短码是自有解析服务与微信预览的唯一有效身份，
 * export/objectId 输入 shortUri 为 null → 订单 share_url 为 NULL → 支付后 fail-fast 退款。
 */
const RE_EXPORT = /export\/([A-Za-z0-9+/=_-]{8,})/;
const RE_SHORT = /weixin\.qq\.com\/sph\/([A-Za-z0-9]+)/;
const RE_PREVIEW = /channels\.weixin\.qq\.com\/finder-preview\/pages\/sph[^"\s]*[?&]id=([A-Za-z0-9=_-]+)/;
const RE_OBJECT_ID = /objectId[^0-9]{0,20}(\d{10,25})/;

export class NormalizeError extends Error {}

export function normalize(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new NormalizeError('关键词错误');

  const mExport = input.match(RE_EXPORT);
  if (mExport) {
    const id = `export/${mExport[1]}`;
    return { contentId: `${id}##2`, shortUri: null };
  }

  const mShort = input.match(RE_SHORT);
  if (mShort) {
    return { contentId: `${mShort[1]}##1`, shortUri: mShort[1] };
  }

  const mPreview = input.match(RE_PREVIEW);
  if (mPreview) {
    return { contentId: `${mPreview[1]}##1`, shortUri: mPreview[1] };
  }

  // 裸短码 / 裸 export id / 裸数字 objectId
  if (/^export\//.test(input)) {
    return { contentId: `${input}##2`, shortUri: null };
  }
  if (/^[A-Za-z0-9]{6,16}$/.test(input)) {
    return { contentId: `${input}##1`, shortUri: input };
  }
  const mObj = input.match(RE_OBJECT_ID);
  if (mObj) {
    return { contentId: mObj[1], shortUri: null };
  }

  throw new NormalizeError('无法识别的视频号链接');
}
