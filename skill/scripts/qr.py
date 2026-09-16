#!/usr/bin/env python3
"""渲染微信支付 code_url 为终端二维码（半块字符 1:1 宽高比）或 PNG。
用法: qr.py "<code_url>" [--png out.png]"""
import sys

try:
    import qrcode
except ImportError:
    print("缺少 qrcode 库，请安装: pip install --user -i https://mirrors.aliyun.com/pypi/simple/ qrcode pillow", file=sys.stderr)
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr); sys.exit(1)
    data = sys.argv[1]
    png = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--png" else None
    qr = qrcode.QRCode(border=2)
    qr.add_data(data)
    qr.make(fit=True)
    if png:
        qr.make_image(fill_color="black", back_color="white").save(png)
        print(png)
        return
    # 终端渲染：两行模块并一行（▀▄ ），保证 1:1 宽高比否则微信扫不出
    m = qr.get_matrix()
    h, w = len(m), len(m[0])
    for y in range(0, h, 2):
        row = []
        for x in range(w):
            top = m[y][x]
            bot = m[y + 1][x] if y + 1 < h else False
            row.append("█" if top and bot else "▀" if top else "▄" if bot else " ")
        print("".join(row))

if __name__ == "__main__":
    main()
