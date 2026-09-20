#!/usr/bin/env python3
"""ensure_deps.py — 本技能**全部**本地依赖的一处式预检（开工第一步就跑，不要等报错）。

为什么要提前跑：本技能有两类硬依赖，缺任何一类都会在中途炸掉，而报错位置离病根很远 ——
  ① Python 包 `qrcode` + `pillow`：`render_order.py` 画支付二维码 / 小程序码要用。
     缺了它第 3 步直接拒绝渲染，前面建订单、取预览的活儿全白做。
  ② `ffmpeg`：读时长/分辨率（第 5/6 步）、提取音频要用。ffmpeg 的探测/安装统一交给
     `ensure_ffmpeg.py`，本脚本只做汇总与转达，不重复实现。

比"缺了再装"更要紧的是**解释器选错**：包可能已经装在隔离 venv 里，
但你若用系统 python 去跑 `render_order.py`，照样 ModuleNotFoundError。
所以本脚本同时给出「应该用哪个解释器」，用 `--python` 取出来喂给后续脚本。

用法：
  ensure_deps.py                      # 人话摘要：什么已就绪、缺什么、下一步敲什么
  ensure_deps.py --check              # 只探测不安装。退出码 0=就绪 2=缺失
  ensure_deps.py --install            # 缺失时装进隔离 venv（幂等，已就绪则跳过）
  ensure_deps.py --python             # 只打印应用来跑脚本的解释器绝对路径（供 $(...) 捕获）
  ensure_deps.py --json               # 机器可读

退出码：0 就绪 / 2 缺失 / 3 安装过程出错
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from ensure_ffmpeg import CACHE_DIR, VENV_DIR, find_ffmpeg, find_ffprobe
except Exception as e:  # ensure_ffmpeg.py 缺失/损坏：不致命，但要**大声说**，否则会给出误导性的 ffmpeg 结论
    print(f"[warn] 无法加载 ensure_ffmpeg.py（{e}）——ffmpeg 部分退化为仅查 PATH，可能误报缺失；"
          f"请检查 {Path(__file__).resolve().parent / 'ensure_ffmpeg.py'}", file=sys.stderr)
    CACHE_DIR = Path.home() / ".workbuddy" / ".cache" / "sph"
    VENV_DIR = CACHE_DIR / "venv"
    FFMPEG_PROBE_DEGRADED = True

    def find_ffmpeg(explicit=""):
        return shutil.which("ffmpeg"), "PATH" if shutil.which("ffmpeg") else ""

    def find_ffprobe(explicit=""):
        return shutil.which("ffprobe"), "PATH" if shutil.which("ffprobe") else ""

else:
    FFMPEG_PROBE_DEGRADED = False

MIRROR = "https://mirrors.aliyun.com/pypi/simple/"
PY_PKGS = ("qrcode", "pillow")

MANUAL_HINT = f"""让本脚本自己装（用户级、隔离 venv、无需管理员、不动系统 PATH）：
  python "{Path(__file__).name}" --install
装完用它的解释器跑渲染脚本：$(python "{Path(__file__).name}" --python)"""


# ------------------------------------------------------------------ 解释器
def venv_python() -> Path:
    return VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def candidates() -> list[tuple[Path, str]]:
    """按优先级返回 (解释器路径, 来源标签)。"""
    out: list[tuple[Path, str]] = []
    seen: set[str] = set()

    def add(p, label):
        try:
            p = Path(p).expanduser()
        except OSError:
            return
        key = str(p).lower()
        if key in seen or not p.is_file():
            return
        seen.add(key)
        out.append((p, label))

    if env := os.environ.get("SPH_PYTHON"):
        add(env.strip().strip('"'), "$SPH_PYTHON")
    add(venv_python(), "venv(sph)")
    add(sys.executable, "sys.executable")
    for name in ("python3", "python"):
        if w := shutil.which(name):
            add(w, "PATH")
    return out


def probe_python(py: Path) -> dict | None:
    """在**独立子进程**里 import，避免"装了但当前解释器看不到"的假阳性。"""
    code = ("import qrcode, PIL, sys, json\n"
            "from importlib.metadata import version, PackageNotFoundError\n"
            "def v(n):\n"
            "    try: return version(n)\n"
            "    except PackageNotFoundError: return '?'\n"
            "print(json.dumps({'qrcode':v('qrcode'),'pillow':v('pillow'),"
            "'exe':sys.executable}))")
    try:
        r = subprocess.run([str(py), "-c", code], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads((r.stdout or "").strip().splitlines()[-1])
    except Exception:
        return None


def resolve_python() -> tuple[Path, str, dict | None]:
    """返回第一个满足 qrcode+pillow 的解释器；都不行则回退到 venv/sys.executable 供安装。"""
    fallback: tuple[Path, str] | None = None
    for py, label in candidates():
        if fallback is None:
            fallback = (py, label)
        if got := probe_python(py):
            return py, label, got
    assert fallback is not None
    return fallback[0], fallback[1], None


# ------------------------------------------------------------------ 安装
def install_pkgs() -> tuple[bool, str]:
    py = venv_python()
    if not py.is_file():
        print(f"[..] 建立隔离环境 {VENV_DIR}", file=sys.stderr)
        r = subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0 or not py.is_file():
            return False, f"venv 创建失败：{(r.stderr or '').strip()[-300:]}"

    base = [str(py), "-m", "pip", "install", "--disable-pip-version-check", "-q", *PY_PKGS]
    for label, extra in (("阿里云镜像", ["-i", MIRROR]), ("官方 PyPI", [])):
        print(f"[..] pip install {' '.join(PY_PKGS)}（{label}）", file=sys.stderr)
        try:
            r = subprocess.run(base + extra, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=900)
        except Exception as e:
            print(f"[warn] {label} 安装异常：{e}", file=sys.stderr)
            continue
        if r.returncode == 0:
            break
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
        print(f"[warn] {label} 安装失败：{' | '.join(tail)}", file=sys.stderr)
    else:
        return False, "两次 pip 安装都失败（网络受限？）"

    if probe_python(py):
        return True, str(py)
    return False, "装完了但 venv 里仍 import 不到 qrcode/PIL"


# ------------------------------------------------------------------ 主流程
def main() -> int:
    ap = argparse.ArgumentParser(description="本地依赖预检 / 自动补齐 / 解释器解析")
    ap.add_argument("--check", action="store_true", help="只探测不安装；缺失则退出码 2")
    ap.add_argument("--install", action="store_true", help="缺失时装进隔离 venv（幂等）")
    ap.add_argument("--python", action="store_true", help="只打印应使用的解释器绝对路径")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    py, py_src, py_ver = resolve_python()
    ffmpeg, fsrc = find_ffmpeg()
    ffprobe, _ = find_ffprobe()

    if args.python:
        if py_ver:
            print(py)
            return 0
        # 还没就绪：--install 时先补齐再说，否则如实报错（不静默打印一个不能用的解释器）
        if args.install and not args.check:
            ok, msg = install_pkgs()
            if ok:
                py, py_src, py_ver = Path(msg), "venv(sph)", probe_python(Path(msg))
                print(py)
                return 0
            print(f"[error] {msg}", file=sys.stderr)
            return 3
        print(f"[error] 没有解释器能 import {PY_PKGS}。\n{MANUAL_HINT}", file=sys.stderr)
        return 2

    if not py_ver and args.install and not args.check:
        ok, msg = install_pkgs()
        if ok:
            py, py_src, py_ver = Path(msg), "venv(sph)", probe_python(Path(msg))
        else:
            print(f"[error] {msg}", file=sys.stderr)

    ready = bool(py_ver) and bool(ffmpeg)

    if args.json:
        print(json.dumps({
            "ready": ready,
            "python": {"path": str(py), "source": py_src,
                       "qrcode": (py_ver or {}).get("qrcode"),
                       "pillow": (py_ver or {}).get("pillow"),
                       "ok": bool(py_ver)},
            "ffmpeg": {"path": ffmpeg, "source": fsrc, "ok": bool(ffmpeg),
                       "probe_degraded": FFMPEG_PROBE_DEGRADED},
            "ffprobe": ffprobe,
            "venv": str(VENV_DIR),
        }, ensure_ascii=False, indent=2))
        return 0 if ready else 2

    lines = []
    if py_ver:
        lines.append(f"[ok]   python   {py}")
        lines.append(f"                qrcode {py_ver.get('qrcode')} · pillow {py_ver.get('pillow')}"
                     f"（来源：{py_src}）")
    else:
        lines.append("[MISS] python   qrcode / pillow 不可用")
        lines.append(f"        候选解释器 {py}（{py_src}）import 失败")
    if ffmpeg:
        lines.append(f"[ok]   ffmpeg   {ffmpeg}（来源：{fsrc}）")
        if not ffprobe:
            lines.append("                ffprobe 未安装 —— 读时长改用 ensure_ffmpeg.py --probe，功能不受影响")
    else:
        lines.append("[MISS] ffmpeg   未找到（读时长/提音频需要）")
    if FFMPEG_PROBE_DEGRADED:
        lines.append("[warn] ffmpeg 结论不可靠：ensure_ffmpeg.py 未加载，仅查了 PATH")
    print("\n".join(lines))

    if ready:
        print(f"\n全部就绪。后续脚本统一用这个解释器：\n  {py}")
        return 0

    todo = []
    if not py_ver:
        todo.append(f"补 Python 包：python \"{Path(__file__).name}\" --install")
    if not ffmpeg:
        todo.append("补 ffmpeg：python ensure_ffmpeg.py --install")
    print("\n缺依赖 —— " + "；".join(todo))
    print(f"\n说明：qrcode/pillow 缺失会让第 3 步渲染直接失败；装进隔离 venv（{VENV_DIR}）即可，无需管理员。")
    return 2


if __name__ == "__main__":
    sys.exit(main())
