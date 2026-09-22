import { test } from 'node:test';
import assert from 'node:assert/strict';

const { msToSrtTime, buildSrt } = await import('../../src/a2m/srt.js');

test('msToSrtTime：毫秒 → HH:MM:SS,mmm', () => {
  assert.equal(msToSrtTime(0), '00:00:00,000');
  assert.equal(msToSrtTime(1234), '00:00:01,234');
  assert.equal(msToSrtTime(61_234), '00:01:01,234');
  assert.equal(msToSrtTime(3_723_456), '01:02:03,456');
  assert.equal(msToSrtTime(-5), '00:00:00,000'); // 负值按 0
  assert.equal(msToSrtTime(undefined), '00:00:00,000');
});

test('buildSrt：分句 → 字幕块', () => {
  const srt = buildSrt([
    { text: '第一句', start_time: 280, end_time: 2000 },
    { text: '第二句', start_time: 2000, end_time: 4200 },
  ]);
  assert.equal(srt,
    '1\n00:00:00,280 --> 00:00:02,000\n第一句\n\n2\n00:00:02,000 --> 00:00:04,200\n第二句\n');

  // 缺时间戳/空文本的分句跳过
  assert.equal(buildSrt([{ text: '无时间' }, { text: '  ', start_time: 0, end_time: 100 }, null]), '');
  assert.equal(buildSrt(null), '');
  assert.equal(buildSrt('not-array'), '');
});
