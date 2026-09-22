import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xorDecryptStream } from '../../src/sph/decryptStream.js';
import { Readable } from 'node:stream';

async function run(buf, key, encLen, startOffset = 0) {
  const out = await Readable.from([buf]).pipe(xorDecryptStream(key, encLen, startOffset)).toArray();
  return Buffer.concat(out);
}

test('xorDecryptStream: 前 encLen 字节逐一异或（密钥等长 pad 语义，同旧 decrypt.py）', async () => {
  const plain = Buffer.alloc(300);
  for (let i = 0; i < plain.length; i++) plain[i] = i & 0xff;
  const key = Buffer.from(plain.subarray(0, 128)); // enc 前 128 字节的密钥
  const enc = Buffer.from(plain);
  for (let i = 0; i < 128; i++) enc[i] ^= key[i];

  // 解密前 200 字节窗口（startOffset=0）应还原前 128 字节、128 之后原样
  const dec = await run(enc, key, 128);
  assert.deepEqual(dec, plain);
});

test('xorDecryptStream: Range 起点偏移（bytes=64- 起）只解密落在窗口内的加密段', async () => {
  const plain = Buffer.alloc(200, 0);
  for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) & 0xff;
  const key = Buffer.alloc(128);
  for (let i = 0; i < key.length; i++) key[i] = (i * 3) & 0xff;
  const enc = Buffer.from(plain);
  for (let i = 0; i < 128; i++) enc[i] ^= key[i];

  // 上游返回 bytes=64- 的密文切片，代理应从 key[64] 起对齐解密
  const slice = enc.subarray(64);
  const dec = await run(slice, key, 128, 64);
  assert.deepEqual(dec, plain.subarray(64));
});

test('xorDecryptStream: 起点在加密段之后 → 完全透传', async () => {
  const tail = Buffer.from('plain tail data');
  const dec = await run(tail, Buffer.alloc(128), 128, 200);
  assert.deepEqual(dec, tail);
});
