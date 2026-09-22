/**
 * 历史加密订单的流式 XOR 解密（替代客户端 decrypt.py）。
 * 语义与旧 decrypt.py 逐字节一致：前 n = min(key.length, encLen) 字节与密钥
 * 一一对应异或（密钥长度本就等于 enc_len，非循环）；n 之后原样透传。
 * XOR 等长保序 → 明文/密文偏移一致，Range 请求可直接映射到上游同偏移。
 */
import { Transform } from 'node:stream';

/** 生成从 startOffset 开始的解密 Transform（只动 [0, encLen) 区间内的字节） */
export function xorDecryptStream(key, encLen, startOffset = 0) {
  const n = Math.min(key.length, encLen);
  let pos = startOffset;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (pos < n) {
        const take = Math.min(n - pos, chunk.length);
        for (let i = 0; i < take; i++) {
          // 密钥与密文等长（pad 语义）；短密钥兜底取模（旧实现取 min，不会走到）
          chunk[i] ^= key[pos + i < key.length ? pos + i : (pos + i) % key.length];
        }
        pos += take;
      }
      cb(null, chunk);
    },
  });
}
