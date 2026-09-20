#!/usr/bin/env python3
"""ensure_ffmpeg.py — ffmpeg 依赖的自检 / 自动补齐 / 路径解析。

为什么需要它：本技能有两处硬依赖 ffmpeg ——
  ① 提取音频（`ffmpeg -c:a copy`）
  ② 读时长/分辨率（`ffprobe`，第 5 / 6 步给交付页用）
旧习惯是把这两件事当成"机器上当然有"，缺了就抛 `command not found`，用户看到的是
一句无意义报错。这个脚本把依赖收成一处：先探测，缺了给一条可执行的补齐命令。

补齐策略（**默认不装，要装得显式**）：
  1. 复用已装好的：本脚本缓存 → `$SPH_FFMPEG` → PATH → 常见安装目录
  2. `--install` 时：在 `~/.workbuddy/.cache/sph/venv` 建**隔离 venv**，
     `pip install imageio-ffmpeg`（默认走阿里云镜像，失败自动回退官方 PyPI）。
     —— 无需管理员、不动系统 PATH、不污染用户 site-packages，纯用户级。
  3. imageio-ffmpeg 只带 ffmpeg、**不带 ffprobe**。所以 `--probe` 在缺 ffprobe 时
     自动降级为解析 `ffmpeg -i`，输出与 `ffprobe -of json` 同构 —— 第 5/6 步的
     probe.json 因此照样能产出。

用法：
  ensure_ffmpeg.py                     # 人话摘要：有什么、在哪、缺什么
  ensure_ffmpeg.py --check             # 只探测不安装。退出码 0=就绪 2=缺失
  ensure_ffmpeg.py --install           # 缺失时才装（已就绪则直接跳过，幂等）
  ensure_ffmpeg.py --path ffmpeg       # 只打印 ffmpeg 绝对路径（供 $(...) 捕获）
  ensure_ffmpeg.py --probe "<视频>"     # 输出 ffprobe -of json 同构的 JSON
  ensure_ffmpeg.py --json              # 机器可读的探测结果

退出码：0 就绪 / 2 缺失（未安装或安装失败）/ 3 安装过程出错 / 5 文件不存在
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

MIRROR = "https://mirrors.aliyun.com/pypi/simple/"
PKG = "imageio-ffmpeg"
CACHE_DIR = Path(os.environ.get("SPH_FFMPEG_HOME")
                 or (Path.home() / ".workbuddy" / ".cache" / "sph")).expanduser()
CACHE_FILE = CACHE_DIR / "ffmpeg.json"
VENV_DIR = CACHE_DIR / "venv"
SKILL_BIN = Path(__file__).resolve().parent.parent / "bin"   # 可选：把二进制放技能自带目录

MANUAL_HINT = """三选一，装完重跑本命令即可：
  Windows   winget install --id Gyan.FFmpeg -e
  macOS     brew install ffmpeg
  Linux     sudo apt install ffmpeg        # 或 dnf / pacman 对应包
或者让本脚本自己装（用户级、无需管理员）：ensure_ffmpeg.py --install"""

WIN_DIRS = (
    r"C:\ffmpeg\bin",
    r"C:\Program Files\ffmpeg\bin",
    r"C:\ProgramData\chocolatey\bin",
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links"),
    os.path.expandvars(r"%USERPROFILE%\scoop\shims"),
)
NIX_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin")


# ------------------------------------------------------------------ 探测
def _ok(path) -> str | None:
    try:
        p = Path(str(path))
        return str(p) if p.is_file() else None
    except OSError:
        return None


def _venv_ffmpeg() -> str | None:
    """从隔离 venv 里找 imageio-ffmpeg 自带的二进制（不 import，避免依赖当前解释器）。"""
    exe = "ffmpeg*.exe" if os.name == "nt" else "ffmpeg-*"
    for base in (VENV_DIR / "Lib" / "site-packages",
                 VENV_DIR / "lib"):
        if not base.is_dir():
            continue
        for hit in sorted(base.glob(f"**/imageio_ffmpeg/binaries/{exe}")):
            if got := _ok(hit):
                return got
    return None


def find_ffmpeg(explicit: str = "") -> tuple[str | None, str]:
    """返回 (路径, 来源标签)。顺序：显式 → 环境变量 → 缓存 → 技能自带 → PATH → venv → 常见目录。"""
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    if explicit and (got := _ok(explicit)):
        return got, "explicit"

    for env in ("SPH_FFMPEG", "FFMPEG_BINARY"):
        if v := os.environ.get(env):
            p = Path(v.strip().strip('"'))
            for c in (p, p / exe):
                if got := _ok(c):
                    return got, f"${env}"

    if CACHE_FILE.is_file():
        try:
            c = json.loads(CACHE_FILE.read_text(encoding="utf-8")).get("ffmpeg")
            if got := _ok(c):
                return got, "cache"
        except Exception:
            pass

    if got := _ok(SKILL_BIN / exe):
        return got, "skill-bin"
    if w := shutil.which("ffmpeg"):
        return w, "PATH"
    if got := _venv_ffmpeg():
        return got, "venv(imageio-ffmpeg)"
    for d in (WIN_DIRS if os.name == "nt" else NIX_DIRS):
        if got := _ok(Path(d) / exe):
            return got, "common-dir"
    return None, ""


def find_ffprobe(explicit: str = "") -> tuple[str | None, str]:
    exe = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    if explicit and (got := _ok(explicit)):
        return got, "explicit"
    if CACHE_FILE.is_file():
        try:
            c = json.loads(CACHE_FILE.read_text(encoding="utf-8")).get("ffprobe")
            if got := _ok(c):
                return got, "cache"
        except Exception:
            pass
    if got := _ok(SKILL_BIN / exe):
        return got, "skill-bin"
    if w := shutil.which("ffprobe"):
        return w, "PATH"
    for d in (WIN_DIRS if os.name == "nt" else NIX_DIRS):
        if got := _ok(Path(d) / exe):
            return got, "common-dir"
    return None, ""


def save_cache(ffmpeg: str | None, ffprobe: str | None, source: str) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(
            {"ffmpeg": ffmpeg, "ffprobe": ffprobe, "source": source},
            ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[warn] 缓存写入失败（不影响使用）：{e}", file=sys.stderr)


# ------------------------------------------------------------------ 安装
def install() -> tuple[str | None, str]:
    """在隔离 venv 里装 imageio-ffmpeg。返回 (ffmpeg 路径, 说明)。"""
    py = sys.executable
    venv_py = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    if not venv_py.is_file():
        print(f"[..] 建立隔离环境 {VENV_DIR}", file=sys.stderr)
        r = subprocess.run([py, "-m", "venv", str(VENV_DIR)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0 or not venv_py.is_file():
            return None, f"venv 创建失败：{(r.stderr or '').strip()[-300:]}"

    base = [str(venv_py), "-m", "pip", "install", "--disable-pip-version-check", "-q", PKG]
    for label, extra in (("阿里云镜像", ["-i", MIRROR]), ("官方 PyPI", [])):
        print(f"[..] pip install {PKG}（{label}）", file=sys.stderr)
        r = subprocess.run(base + extra, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=900)
        if r.returncode == 0:
            break
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
        print(f"[warn] {label} 安装失败：{' | '.join(tail)}", file=sys.stderr)
    else:
        return None, "两次 pip 安装都失败（网络受限？）"

    got = _venv_ffmpeg()
    if not got:
        return None, "装完了但没找到 imageio-ffmpeg 附带的可执行文件"
    return got, "venv(imageio-ffmpeg)"


def verify(exe: str) -> str:
    try:
        r = subprocess.run([exe, "-version"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=30)
        return (r.stdout or "").splitlines()[0][:120] if r.returncode == 0 else ""
    except Exception:
        return ""


# ------------------------------------------------------------------ probe
def probe_json(ffmpeg: str, ffprobe: str | None, media: Path) -> str:
    """输出与 `ffprobe -of json` 同构的 JSON（render_order.py 只读 format.duration/size 与 streams[0].width/height）。"""
    if ffprobe:
        r = subprocess.run([ffprobe, "-v", "error", "-print_format", "json",
                            "-show_format", "-show_streams", str(media)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout

    # 降级：解析 `ffmpeg -i` 的 stderr（不带输出文件，退出码必然非 0，属正常）
    r = subprocess.run([ffmpeg, "-hide_banner", "-i", str(media)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    text = (r.stderr or "") + (r.stdout or "")
    fmt: dict = {}
    if m := re.search(r"Duration:\s*([\d:.]+)", text):
        h, mm, ss = m.group(1).split(":")
        fmt["duration"] = round(int(h) * 3600 + int(mm) * 60 + float(ss), 3)
    fmt["size"] = media.stat().st_size if media.is_file() else None
    video: list[dict] = []
    audio: list[dict] = []
    for line in text.splitlines():
        m = re.search(r"Stream #\d+:\d+.*?: Video:.*?, (\d+)x(\d+)", line)
        if m:
            video.append({"codec_type": "video", "width": int(m.group(1)),
                          "height": int(m.group(2))})
            continue
        if "Audio:" in line and (a := re.search(r"Audio:\s*([A-Za-z0-9_]+)", line)):
            audio.append({"codec_type": "audio", "codec_name": a.group(1)})
    # 视频流必须排在 streams[0]：render_order.py 取的是 streams[0] 的 width/height
    return json.dumps({"format": fmt, "streams": video + audio},
                      ensure_ascii=False, indent=2) + "\n"


# ------------------------------------------------------------------ 主流程
def main() -> int:
    ap = argparse.ArgumentParser(description="ffmpeg 依赖自检 / 自动补齐 / 路径解析")
    ap.add_argument("--check", action="store_true", help="只探测不安装；缺失则退出码 2")
    ap.add_argument("--install", action="store_true", help="缺失时安装到隔离 venv（幂等）")
    ap.add_argument("--path", choices=["ffmpeg", "ffprobe"], help="只打印一个路径")
    ap.add_argument("--probe", metavar="MEDIA", help="输出 ffprobe -of json 同构的 JSON")
    ap.add_argument("--ffmpeg", default="", help="指定 ffmpeg 路径")
    ap.add_argument("--ffprobe", default="", help="指定 ffprobe 路径")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    ffmpeg, fsrc = find_ffmpeg(args.ffmpeg)
    ffprobe, psrc = find_ffprobe(args.ffprobe)

    # --check 是「只探测」的显式表达：与 --install 同时出现时以 --check 为准
    if not ffmpeg and args.install and not args.check:
        ffmpeg, fsrc = install()
        if ffmpeg:
            save_cache(ffmpeg, ffprobe, fsrc)

    if args.path:
        if args.path == "ffprobe" and ffprobe:
            print(ffprobe)
            return 0
        if ffmpeg:
            print(ffmpeg)
            return 0 if args.path == "ffmpeg" else 2
        print(f"[error] 未找到 {args.path}。\n{MANUAL_HINT}", file=sys.stderr)
        return 2

    if args.probe:
        media = Path(args.probe).expanduser()
        if not media.is_file():
            print(f"[error] 文件不存在：{media}", file=sys.stderr)
            return 5
        if not ffmpeg:
            print(f"[error] 需要 ffmpeg。\n{MANUAL_HINT}", file=sys.stderr)
            return 2
        sys.stdout.write(probe_json(ffmpeg, ffprobe, media))
        return 0

    if args.json:
        print(json.dumps({"ffmpeg": ffmpeg, "ffmpeg_source": fsrc,
                          "ffprobe": ffprobe, "ffprobe_source": psrc,
                          "version": verify(ffmpeg) if ffmpeg else "",
                          "cache_dir": str(CACHE_DIR), "ready": bool(ffmpeg)},
                         ensure_ascii=False, indent=2))
        return 0 if ffmpeg else 2

    if ffmpeg:
        print(f"ffmpeg   {ffmpeg}")
        if v := verify(ffmpeg):
            print(f"         {v}（来源：{fsrc}）")
        if ffprobe:
            print(f"ffprobe  {ffprobe}（来源：{psrc}）")
        else:
            print("ffprobe  未安装 —— 时长/分辨率改用 `ensure_ffmpeg.py --probe` 解析，功能不受影响")
        return 0

    print("未找到 ffmpeg（提取音频、读时长都依赖它）。\n" + MANUAL_HINT)
    return 2


if __name__ == "__main__":
    sys.exit(main())
