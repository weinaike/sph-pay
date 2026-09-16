import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, NormalizeError } from '../../src/sph/normalize.js';

test('weixin.qq.com 短链', () => {
  const r = normalize('https://weixin.qq.com/sph/AzGEWrdqgP');
  assert.equal(r.contentId, 'AzGEWrdqgP##1');
  assert.equal(r.shortUri, 'AzGEWrdqgP');
});

test('finder-preview 分享链接', () => {
  const r = normalize('https://channels.weixin.qq.com/finder-preview/pages/sph?id=AzGEWrdqgP&other=1');
  assert.equal(r.contentId, 'AzGEWrdqgP##1');
});

test('export id', () => {
  const r = normalize('export/UzFfBgAAxIauNFAfcTrNk8zT4DCsIvWoMAUso-UldgDy0RJQLw3eeenBBQ');
  assert.equal(r.contentId, 'export/UzFfBgAAxIauNFAfcTrNk8zT4DCsIvWoMAUso-UldgDy0RJQLw3eeenBBQ##2');
  assert.equal(r.shortUri, null);
});

test('消息文本里嵌 export id', () => {
  const r = normalize('看看这个 export/UzFfBgAAxIauNFAfcTrNk8zT4DCsIvWoMAUso 超好看');
  assert.equal(r.contentId, 'export/UzFfBgAAxIauNFAfcTrNk8zT4DCsIvWoMAUso##2');
});

test('objectId 文本', () => {
  const r = normalize('{"objectId":"1459397097586354","objectId2":"x"}');
  assert.equal(r.contentId, '1459397097586354');
});

test('裸短码', () => {
  const r = normalize('AzGEWrdqgP');
  assert.equal(r.contentId, 'AzGEWrdqgP##1');
});

test('无法识别抛错', () => {
  assert.throws(() => normalize('随便一句话'), NormalizeError);
  assert.throws(() => normalize(''), NormalizeError);
});
