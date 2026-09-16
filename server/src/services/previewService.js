/**
 * 支付前预览：微信免登录 get_feed_info。
 * ⚠️ 仅短码可用；export/数字 id 匿名查询返回"此内容暂时无法播放" → 降级占位预览。
 */
const FEED_API = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info';

export async function fetchPreview(shortUri) {
  if (!shortUri) return degradedPreview();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(FEED_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Origin: 'https://channels.weixin.qq.com',
        Referer: `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${encodeURIComponent(shortUri)}`,
      },
      body: JSON.stringify({ baseReq: { generalToken: '' }, shortUri }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await res.json().catch(() => null);
    const feed = j?.data?.feedInfo;
    if (!j || j.errCode !== 0 || !feed) return degradedPreview();

    return {
      ok: true,
      title: feed.description || '(无标题)',
      author: j.data.authorInfo?.nickname || '',
      avatar: j.data.authorInfo?.headImgUrl || '',
      cover: feed.coverUrl || '',
      description: feed.description || '',
      created_at: feed.createtime || null,
      likes: feed.likeCountFmt || '',
      // dynamicExportId 是更贴近最终内容的标识（export/UzFf...），优先作 content_id
      export_id: j.data.sceneInfo?.dynamicExportId || null,
      expire_hint: j.data.sceneInfo?.expiredTime || null,
    };
  } catch {
    return degradedPreview();
  }
}

function degradedPreview() {
  return { ok: false, title: '视频号视频（详情将在支付后解析时确认）', author: '', avatar: '', cover: '', description: '', created_at: null, likes: '', export_id: null, expire_hint: null };
}
