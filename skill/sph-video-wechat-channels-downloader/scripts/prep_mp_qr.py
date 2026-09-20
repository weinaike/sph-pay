#!/usr/bin/env python3
"""规范化小程序码素材 → assets/miniprogram-qr.png

用户从微信公众平台下载的小程序码常见两个问题，直接丢进 assets/ 会埋雷：

1. **是 JPEG 而非 PNG**。渲染器用 `png_data_uri()` 原样读字节并声明
   `data:image/png`，JPEG 字节配 PNG 声明不可靠；且 JPEG 的振铃伪影
   会干扰码点识别（见 references/rendering.md 第三节极性/压缩铁律）。
2. **静区被裁掉**。截图/二次编辑常把白边裁掉，图案贴边。
   QR 系规范要求 ≥4 模块静区，贴边是扫码失败的首要原因。

本脚本做三件事：解码 → 补足静区 → 转真 PNG 落盘，并打印体检报告。

用法：
  prep_mp_qr.py <输入图片> [--out <输出路径>] [--modules 37] [--quiet 4]

  --modules  小程序码直径包含的模块数（用于换算静区像素）。
             微信小程序码常见 37~41；默认 37，宁可静区略大不要不够。
  --quiet    需要保留的静区模块数，默认 4（QR 规范下限）。

退出码 0 = 已写出可用素材；1 = 输入不可用。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("[err] 需要 pillow：先运行同目录的 ensure_deps.py --install 装入隔离 venv，"
          "再用 ensure_deps.py --python 输出的解释器重跑本脚本", file=sys.stderr)
    sys.exit(1)

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUT = SKILL_DIR / "assets" / "miniprogram-qr.png"

# 判定「墨点」的灰度阈值：低于此值算图案，其余算静区
INK_THRESHOLD = 200
# 源图有效分辨率下限（低于此值屏幕扫码风险明显上升）
MIN_SOURCE_PX = 240


def ink_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    """返回非白像素的包围盒 (x0, y0, x1, y1)，闭区间。"""
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    xs: list[int] = []
    ys: list[int] = []
    for y in range(h):
        for x in range(w):
            if px[x, y] < INK_THRESHOLD:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise ValueError("整张图都是白底，找不到码图案")
    return min(xs), min(ys), max(xs), max(ys)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--modules", type=int, default=37)
    ap.add_argument("--quiet", type=int, default=4)
    args = ap.parse_args()

    src = Path(args.src)
    if not src.exists():
        print(f"[err] 输入文件不存在：{src}", file=sys.stderr)
        return 1

    im = Image.open(src)
    print(f"输入：{src.name}  {im.size[0]}×{im.size[1]}  {im.format}  {im.mode}")

    if im.width != im.height:
        print(f"[warn] 非正方形（{im.width}×{im.height}），已按短边居中裁剪")
        s = min(im.width, im.height)
        im = im.crop(((im.width - s) // 2, (im.height - s) // 2,
                      (im.width - s) // 2 + s, (im.height - s) // 2 + s))

    im = im.convert("RGB")

    x0, y0, x1, y1 = ink_bbox(im)
    pattern = max(x1 - x0 + 1, y1 - y0 + 1)
    mod_px = pattern / args.modules
    need = int(round(mod_px * args.quiet))

    have = {"左": x0, "上": y0, "右": im.width - 1 - x1, "下": im.height - 1 - y1}
    print(f"图案：{x1 - x0 + 1}×{y1 - y0 + 1}px  约 {mod_px:.2f}px/模块")
    print(f"现有静区：{have}  （最少 {min(have.values())}px ≈ {min(have.values()) / mod_px:.1f} 模块）")
    print(f"目标静区：{need}px = {args.quiet} 模块")

    if min(have.values()) >= need:
        print("[ok] 静区已达标，不改画布")

    # 无论是否补静区，都重建画布：以图案为中心、四周留足 need
    padded = Image.new("RGB", (pattern + need * 2, pattern + need * 2), (255, 255, 255))
    crop = im.crop((x0, y0, x0 + pattern, y0 + pattern))
    padded.paste(crop, (need, need))
    px = padded.size[0]
    print(f"输出画布：{px}×{px}px  （图案 {pattern}px + 静区 {need}px×2）")

    if px < MIN_SOURCE_PX:
        print(f"[warn] 输出仅 {px}px，低于建议下限 {MIN_SOURCE_PX}px，"
              f"屏幕扫码可能吃力；建议从公众平台重新下载更大尺寸")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # optimize=True 对黑白为主的图压缩收益明显，且是无损的
    padded.save(out, format="PNG", optimize=True)

    kb = out.stat().st_size / 1024
    print(f"已写出：{out}  {kb:.1f} KB  (PNG, 无损)")
    print(f"[提示] 页面显示尺寸建议 ≥{int(px / 2)}px（源图 2x 以内不放大，最清晰）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
