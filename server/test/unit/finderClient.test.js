import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FinderError,
  normalizeSearchBody, normalizeFeedPageBody, normalizeShareUrlBody, fetchFeedPage,
} from '../../src/finder/client.js';

// fixture 结构对齐 wx_channels_download pkg/scraper/wxchannels/types.go 的 json tag
//（外层 {code,msg,data:{errCode,errMsg,data:proto}}，proto.BaseResponse.Ret=0 为地面真相）

const ok = (proto) => ({ code: 0, msg: '成功', data: { errCode: 0, errMsg: 'ok', data: { BaseResponse: { Ret: 0, ErrMsg: { String: '' } }, ...proto } } });

test('normalizeSearchBody：infoList 归一化 + 非 @finder 过滤', () => {
  const body = ok({
    infoList: [
      {
        contact: { username: 'v2_abc@finder', nickname: '人民日报', headUrl: 'https://wx.qlogo.cn/x', signature: '参与、沟通、记录时代。', coverImgUrl: '' },
        highlightNickname: '<em>人民日报</em>', reqIndex: 0,
      },
      { contact: { username: 'weixin_id_not_finder', nickname: '假达人', headUrl: '', signature: '' } },
    ],
    continueFlag: 0, lastBuff: '',
  });
  const r = normalizeSearchBody(body);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0], {
    username: 'v2_abc@finder', nickname: '人民日报', avatar: 'https://wx.qlogo.cn/x', signature: '参与、沟通、记录时代。',
  });
});

test('normalizeSearchBody：空结果 = 空列表（不是错误）', () => {
  assert.deepEqual(normalizeSearchBody(ok({ infoList: null })).items, []);
});

const feedPage = (n, { continueFlag = 0, lastBuffer = '', feedsCount = null, numericId = false } = {}) => ok({
  object: Array.from({ length: n }, (_, i) => ({
    id: numericId ? 15014522211187689980 + i : `1501452221118768${String(i).padStart(4, '0')}`,
    createtime: 1789900000 + i,
    contact: { username: 'v2_abc@finder', nickname: '人民日报' },
    objectDesc: {
      description: `第${i}条视频\n第二行文案`,
      media: [{
        url: 'https://finder.video.qq.com/251/x', mediaType: 4, videoPlayLen: 284,
        width: 1920, height: 1080, fileSize: 291071482, decodeKey: 'key',
      }],
    },
  })),
  feedsCount: feedsCount ?? n,
  continueFlag, lastBuffer,
});

test('normalizeFeedPageBody：条目归一化（首行标题/时长/尺寸/大小）', () => {
  const r = normalizeFeedPageBody(feedPage(2, { feedsCount: 12046 }));
  assert.equal(r.total, 12046);
  assert.equal(r.items.length, 2);
  const v = r.items[0];
  assert.equal(v.object_id, '1501452221118768' + '0000');
  assert.equal(v.title, '第0条视频'); // 首行即标题
  assert.equal(v.created_at, 1789900000);
  assert.equal(v.duration, 284);
  assert.equal(v.width, 1920);
  assert.equal(v.height, 1080);
  assert.equal(v.size, 291071482);
  assert.equal(v.share_url, null);
});

test('大数 id 无损解析：20 位数字 id 不丢精度（json-bigint 层）', async () => {
  // 原始文本直接内嵌未加引号的 20 位 id（上游常态，Go 端 flexibleString 的成因）
  const raw = `{"code":0,"msg":"成功","data":{"errCode":0,"errMsg":"ok","data":{"BaseResponse":{"Ret":0,"ErrMsg":{"String":""}},"object":[{"id":15014522211187689980,"createtime":1789900000,"contact":{"username":"v2_abc@finder"},"objectDesc":{"description":"x","media":[]}}],"feedsCount":1,"continueFlag":0,"lastBuffer":""}}}`;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(raw);
  try {
    const r = await fetchFeedPage('v2_abc@finder');
    assert.equal(typeof r.items[0].object_id, 'string');
    assert.equal(r.items[0].object_id, '15014522211187689980'); // 不是 ...000
  } finally {
    globalThis.fetch = orig;
  }
});

test('normalizeFeedPageBody：翻页信封 continueFlag/lastBuffer', () => {
  const r = normalizeFeedPageBody(feedPage(15, { continueFlag: 1, lastBuffer: 'buf-x', feedsCount: 12046 }));
  assert.equal(r.continueFlag, 1);
  assert.equal(r.lastBuffer, 'buf-x');
});

test('normalizeShareUrlBody：取 feedH5Url', () => {
  const r = normalizeShareUrlBody(ok({ feedH5Url: 'https://weixin.qq.com/sph/AReu8Jr1L2', urlList: [] }));
  assert.equal(r, 'https://weixin.qq.com/sph/AReu8Jr1L2');
  // 非 sph 短链 → null
  assert.equal(normalizeShareUrlBody(ok({ feedH5Url: 'https://example.com/x' })), null);
});

test('错误分类：注入断（code=400 socket 未初始化）→ FinderError', () => {
  assert.throws(() => normalizeSearchBody({ code: 400, msg: '请先初始化客户端 socket 连接' }), FinderError);
});

test('错误分类：errCode!=0 / Ret!=0 / 结构缺失 → FinderError', () => {
  assert.throws(() => normalizeSearchBody({ code: 0, msg: '成功', data: { errCode: 500, errMsg: '内部错误' } }), FinderError);
  const bad = { code: 0, msg: '成功', data: { errCode: 0, errMsg: 'ok', data: { BaseResponse: { Ret: -1 } } } };
  assert.throws(() => normalizeSearchBody(bad), FinderError);
  assert.throws(() => normalizeSearchBody(null), FinderError);
});
