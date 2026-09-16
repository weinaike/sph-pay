#!/usr/bin/env python3
"""渲染微信支付 code_url 为终端二维码（半块字符）或 PNG。

终端扫码失败的三大根因与对策：
1. 静区不足 → border=4（QR 规范值；旧版 2 偏小，边缘模块容易和终端边框粘连）
2. 深色主题反色 → 字符是浅色、背景是深色，打印"暗模块"实际显示为浅 → 黑白极性反了，
   微信扫码对反色码容差很低 → --invert 交换打印逻辑，让暗模块由深色背景呈现
3. 矩阵过密/超宽折行 → 纠错降为 L（矩阵更小，模块更大更好扫）；终端宽度放不下时
   直接自动降级 PNG 并打开（折行的二维码必死，不如不打印）

用法:
  qr.py "<code_url>"              终端渲染（浅色背景终端）
  qr.py "<code_url>" --invert     深色背景终端用（Claude Code/IDE 深色主题首选）
  qr.py "<code_url>" --png out.png
"""
import os
import shutil
import subprocess
import sys

try:
    import qrcode
except ImportError:
    print("缺少 qrcode 库，请安装: pip install --user -i https://mirrors.aliyun.com/pypi/simple/ qrcode pillow", file=sys.stderr)
    sys.exit(1)

BORDER = 4  # QR 规范静区宽度（模块数）


def render_png(data, path):
    img = qrcode.make(data, border=BORDER)
    img.save(path)
    print(path)
    if sys.platform == "darwin":
        subprocess.run(["open", path], check=False)


def render_terminal(data, invert):
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, border=BORDER)
    qr.add_data(data)
    qr.make(fit=True)
    m = qr.get_matrix()
    h, w = len(m), len(m[0])

    # 超宽折行 = 必死，直接降级 PNG
    cols = shutil.get_terminal_size(fallback=(120, 40)).columns
    if w > cols:
        print(f"矩阵宽 {w} 列超出终端 {cols} 列，折行后无法扫码，已降级 PNG：", file=sys.stderr)
        render_png(data, "/tmp/sph-qr.png")
        return

    # 两行模块并一行（▀▄），1 字符宽 × 半字符高 ≈ 正方形模块
    # invert: 深色背景终端用 —— 暗模块不打印（露深底），亮模块打印为浅色块
    for y in range(0, h, 2):
        row = []
        for x in range(w):
            top = m[y][x] != invert  # invert 时交换亮暗
            bot = (m[y + 1][x] != invert) if y + 1 < h else False
            row.append("█" if top and bot else "▀" if top else "▄" if bot else " ")
        print("".join(row))


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    data = sys.argv[1]
    args = sys.argv[2:]
    if "--png" in args:
        i = args.index("--png")
        path = args[i + 1] if i + 1 < len(args) else "/tmp/sph-qr.png"
        render_png(data, path)
        return
    render_terminal(data, "--invert" in args)
    print("（扫不出且终端为深色主题 → 加 --invert；仍不行 → --png /tmp/sph-qr.png）")


if __name__ == "__main__":
    main()
