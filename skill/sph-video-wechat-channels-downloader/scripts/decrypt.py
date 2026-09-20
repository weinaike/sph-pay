#!/usr/bin/env python3
"""原地 XOR 解密前 enc_len 字节并校验 MP4 头。分块读写，不整文件进内存。
用法: decrypt.py <in.mp4.enc> <key_b64文件> <enc_len> [out.mp4]（缺省原地覆盖）
密钥文件为纯 base64 文本（131072 字节密钥的 base64 约 175KB，超出 ARG_MAX，必须走文件）"""
import base64, os, sys

CHUNK = 1 << 20

def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr); sys.exit(1)
    src, key_file, enc_len = sys.argv[1], sys.argv[2], int(sys.argv[3])
    dst = sys.argv[4] if len(sys.argv) > 4 else src
    key = base64.b64decode(open(key_file).read().strip())
    if len(key) != enc_len:
        print(f"警告: key 长度 {len(key)} != enc_len {enc_len}，取较小值", file=sys.stderr)
    n = min(len(key), enc_len)

    with open(src, "rb") as f:
        head = bytearray(f.read(n))
        if len(head) < 12:
            print(f"文件过小({len(head)}B)", file=sys.stderr); sys.exit(1)
        for i in range(len(head)):
            head[i] ^= key[i]
        if head[4:8] != b"ftyp":
            print("解密校验失败: offset 4 处不是 ftyp（密钥错误或站点规则变化）", file=sys.stderr)
            sys.exit(1)
        rest_pos = f.tell()

    with open(src, "rb") as fi, open(dst + ".tmp", "wb") as fo:
        fi.seek(0)
        fo.write(head)
        fi.seek(rest_pos)
        while True:
            b = fi.read(CHUNK)
            if not b: break
            fo.write(b)
    os.replace(dst + ".tmp", dst)
    print(f"OK: {dst} ({os.path.getsize(dst)}B)")

if __name__ == "__main__":
    main()
