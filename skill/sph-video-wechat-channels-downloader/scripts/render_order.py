#!/usr/bin/env python3
"""render_order.py — 把下单响应渲染为「单文件自包含 HTML」。

设计要点（对应 references/rendering.md）：
1. 单文件自包含：封面 / 头像 / 支付二维码 / 小程序码全部 base64 内嵌，
   页面可随意移动、离线打开，不依赖任何外部资源（也绕开防盗链与 CSP）。
2. 二维码极性铁律：屏幕扫码必须「白底黑码」。页面外壳跟随深浅主题，
   但二维码一律画在固定的白色卡片上 —— 绝不跟随深色主题反色。
3. 两阶段渲染：
   --stage pay        下单后（封面凭证 + 免费小程序码 + 支付二维码 + 倒计时）
   --stage delivered  解析完成后（**本地文件路径**为主交付物 + 媒体信息）
   交付态默认**不显示 CDN 直链**：服务端不留存文件，直链会过期、对用户无沉淀价值，
   用户真正要的是「本地那个文件在哪」。需要时才加 --show-cdn-link。

用法：
  render_order.py --in order.json --out page.html [选项]

  --in        POST /api/order 的原始响应 JSON（或 --order-file .orders/<id>.json 的落盘件）
  --url       原始分享短链（渲染到免费引导里，方便用户复制去小程序粘贴）
  --out       输出 HTML 路径
  --stage     pay | delivered（默认 pay）
  --local-path  已下载的本地 mp4 绝对路径（delivered 态主交付物）
  --deliver   GET /api/order/:id/deliver 的原始响应 JSON（可选，仅 --show-cdn-link 或取体积时需要）
  --probe     本机 ffprobe 输出的 JSON 文件（时长/体积/分辨率，可选）
  --miniprogram-qr  小程序码图片路径（默认取 <skill>/assets/miniprogram-qr.png）
  --no-remote 不联网拉取封面/头像，只用占位（离线/沙箱环境用）
  --quiet     只打印输出路径
"""
from __future__ import annotations

import argparse
import base64
import html
import io
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_MP_QR = SKILL_DIR / "assets" / "miniprogram-qr.png"

try:
    import qrcode
except ImportError:
    print(
        "缺少 qrcode 库。请先运行同目录的 ensure_deps.py --install（自动装入隔离 venv），\n"
        "再用 ensure_deps.py --python 输出的解释器运行本脚本。",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    print("缺少 pillow 库（用于封面压缩与二维码渲染）。", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------- 基础工具
def qr_data_uri(data: str, box: int = 8, border: int = 4) -> str:
    """生成白底黑码 PNG 的 data URI。纠错级别 M（屏幕扫码的稳妥值）。"""
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                       box_size=box, border=border)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _shrink(raw: bytes, max_w: int, quality: int) -> bytes:
    """等比压到 max_w 宽以内并转 JPEG；失败则原样返回。"""
    try:
        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGB")
        if im.width > max_w:
            h = round(im.height * max_w / im.width)
            im = im.resize((max_w, h), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=quality, optimize=True)
        return buf.getvalue()
    except Exception:
        return raw


def remote_data_uri(url: str | None, max_w: int = 900, quality: int = 82) -> str:
    """拉取远程图片并内嵌为 data URI；任何失败都返回空串（调用方降级）。"""
    if not url:
        return ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
        return "data:image/jpeg;base64," + base64.b64encode(
            _shrink(raw, max_w, quality)).decode()
    except Exception as e:
        print(f"[warn] 图片内嵌失败（降级为占位）: {e}", file=sys.stderr)
        return ""


def local_data_uri(path: Path, max_w: int = 900) -> str:
    try:
        raw = path.read_bytes()
        return "data:image/jpeg;base64," + base64.b64encode(
            _shrink(raw, max_w, 88)).decode()
    except Exception:
        return ""


def png_data_uri(path: Path) -> str:
    """原样内嵌 PNG（二维码不能用有损压缩）。"""
    try:
        return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()
    except Exception:
        return ""


def esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


def fmt_size(n) -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "—"
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.2f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.1f} MB"
    return f"{n / 1024:.0f} KB"


def fmt_dur(sec) -> str:
    try:
        sec = float(sec)
    except (TypeError, ValueError):
        return "—"
    m, s = divmod(round(sec), 60)
    h, m = divmod(m, 60)
    return f"{h} 时 {m} 分 {s} 秒" if h else f"{m} 分 {s} 秒"


def fmt_ts(ts) -> str:
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError):
        return "—"


def fmt_ymd(ts) -> str:
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return "—"


# 后端 preview.title 与 preview.description 实测逐字符相同，都是「标题 + 尾部话题标签串」。
# 标签串不该出现在 H1 和 <title> 里 —— 它既不是标题也不是文案，是检索用的元数据。
_TRAILING_TAGS = re.compile(r"(?:\s*#[^\s#]+)+\s*$")


def clean_title(s: str | None) -> str:
    """剥掉标题尾部的话题标签串。整串都是标签时原样保留，不做空。"""
    raw = (s or "").strip()
    if not raw:
        return ""
    stripped = _TRAILING_TAGS.sub("", raw).strip()
    return stripped or raw


def extract_tags(s: str | None) -> list[str]:
    """从标题/描述里提话题标签，供对话侧按需展示（页面不用）。"""
    return [t for t in re.findall(r"#[^\s#]+", s or "")] or []


# ---------------------------------------------------------------- 版式
TPL = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__PAGE_TITLE__</title>
<style>
:root{
  --bg:#f6f6f4; --card:#ffffff; --line:rgba(0,0,0,.10); --line2:rgba(0,0,0,.16);
  --tx:#1c1c1e; --tx2:#5c5c60; --tx3:#8e8e93;
  --accent:#0f6e56; --accent-bg:#e8f5f0; --warn:#8a5a00; --warn-bg:#fdf4e3;
  --kw:#8a6100; --kw-bg:#fdf3d7;
  --radius:14px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#141416; --card:#1e1e21; --line:rgba(255,255,255,.12); --line2:rgba(255,255,255,.2);
    --tx:#f2f2f4; --tx2:#a8a8ae; --tx3:#7c7c83;
    --accent:#5dcaa5; --accent-bg:#12312a; --warn:#f0c274; --warn-bg:#2e2417;
    --kw:#ffd34a; --kw-bg:rgba(255,211,74,.14);
  }
}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--tx);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",
  "Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto}
.grid{display:grid;gap:16px;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);align-items:start}
@media (max-width:820px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.pad{padding:18px}
.topbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.brand{font-size:15px;font-weight:500;letter-spacing:.2px}
.pill{font-size:12px;color:var(--tx2);border:1px solid var(--line2);border-radius:999px;
  padding:3px 10px;font-variant-numeric:tabular-nums}
.pill.ok{color:var(--accent);background:var(--accent-bg);border-color:transparent}
.evid{display:flex;gap:16px;align-items:flex-start}
.thumb{flex:0 0 auto;width:112px;height:200px;border-radius:8px;overflow:hidden;background:#000;
  display:flex;align-items:center;justify-content:center}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .ph{color:#8a8a90;font-size:11px;text-align:center;padding:8px;line-height:1.5}
.evidmeta{flex:1;min-width:0}
.evidnote{margin-top:12px;font-size:12.5px;color:var(--tx3);line-height:1.7;
  border-left:2px solid var(--line2);padding-left:11px}
.slot{margin-top:16px}
.pathlabel{font-size:12.5px;color:var(--tx3);margin-bottom:7px}
h1{font-size:16px;font-weight:500;line-height:1.5;margin:0 0 10px}
.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--tx2)}
.av{width:26px;height:26px;border-radius:50%;object-fit:cover;background:var(--accent-bg);
  display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--accent);
  overflow:hidden;flex:0 0 auto}
.av img{width:100%;height:100%;object-fit:cover}
.dot{width:3px;height:3px;border-radius:50%;background:var(--tx3)}
h2{font-size:13px;font-weight:500;color:var(--tx2);margin:0 0 10px;letter-spacing:.3px}
.desc{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;
  font-size:13.5px;color:var(--tx);white-space:pre-wrap;word-break:break-word;
  max-height:132px;overflow:auto}
.btnrow{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;font-size:13px;padding:7px 13px;border-radius:9px;cursor:pointer;
  border:1px solid var(--line2);background:transparent;color:var(--tx);transition:.15s}
button:hover{border-color:var(--tx3)}
button.primary{background:var(--accent);color:#fff;border-color:transparent;font-weight:500}
button.primary:hover{opacity:.9}
.qr{background:#fff;border-radius:10px;padding:12px;display:inline-block;line-height:0}
.qr img{width:200px;height:200px;display:block;image-rendering:pixelated}
.cardhead{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.cardhead h2{margin:0}
.mainwrap{margin-bottom:16px}
.paywrap{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}
.paymid{flex:1;min-width:230px}
.price{font-size:32px;font-weight:500;letter-spacing:-.5px;font-variant-numeric:tabular-nums;
  margin-bottom:14px}
.price small{font-size:14px;font-weight:400;color:var(--tx2);margin-left:6px;letter-spacing:0}
.kv{font-size:12.5px;color:var(--tx2);display:grid;grid-template-columns:auto 1fr;
  gap:5px 14px;align-content:start}
.kv b{font-weight:400;color:var(--tx3)}
.kv span{color:var(--tx);font-variant-numeric:tabular-nums;word-break:break-all}
.count{font-variant-numeric:tabular-nums;color:var(--warn);background:var(--warn-bg);
  border-radius:8px;padding:9px 12px;font-size:13px;margin-top:16px}
.count.hot{color:#a32d2d;background:#fcebeb}
@media (prefers-color-scheme:dark){.count.hot{color:#f09595;background:#3a1a1a}}
.free{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.free .qr img{width:150px;height:150px}
.steps{font-size:13px;color:var(--tx2);flex:1;min-width:150px}
.steps ol{margin:0;padding-left:18px}
.steps li{margin:0 0 5px}
.steps code{background:var(--bg);border:1px solid var(--line);border-radius:5px;
  padding:1px 6px;font-size:12px;word-break:break-all;font-family:ui-monospace,Consolas,monospace}
/* 免费卡的第二个通道（网页版）：与小程序是「二选一」关系，不是同一条流程的第 4 步，
   所以用虚线分隔独立成块，不塞进 <ol>。
   布局位置：右列 .steps 内 = 二维码图片的右边；窄屏折行时自然落到二维码下方。 */
.alt{margin-top:11px;padding-top:11px;border-top:1px dashed var(--line2);
  font-size:12.5px;color:var(--tx2);line-height:1.7}
/* 关键词（越思科技Yes-Tek）黄色强调。
   注意：浅色主题下纯黄字放白卡片上对比度只有 1.4:1，等于看不见，
   所以浅色用深金 #8a6100（白底 ≈5.4:1，达到 AA），深色主题才用亮黄 #ffd34a。 */
.alt code{color:var(--kw);background:var(--kw-bg);border:1px solid transparent;border-radius:5px;
  padding:1px 6px;font-size:12px;font-weight:600;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.trust{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--tx2);line-height:1.75}
.trust b{font-weight:500;color:var(--tx)}
.link{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;
  font-size:12px;font-family:ui-monospace,Consolas,monospace;color:var(--tx2);
  word-break:break-all;max-height:104px;overflow:auto;line-height:1.6}
.foot{margin-top:18px;font-size:12px;color:var(--tx3);line-height:1.75}
.note{font-size:12.5px;color:var(--tx2);margin-top:12px;padding:10px 12px;
  border-left:2px solid var(--warn);background:var(--warn-bg);border-radius:0 8px 8px 0}
.media{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--tx2);margin-top:4px}
.media b{font-weight:500;color:var(--tx)}
/* 交付态合并卡：封面凭证 + 交付信息同卡 */
.merged{display:flex;gap:20px;align-items:flex-start}
.merged .evidmeta{flex:1;min-width:0}
.sect{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
.sect .pathlabel{margin-top:16px}
</style>
</head>
<body>
<div class="wrap">

  <div class="topbar">
    <span class="brand">越思工具</span>
    <span class="pill">订单 __ORDER_SHORT__</span>
    __STAGE_PILL__
  </div>

  <div class="mainwrap">__MAIN_CARD__</div>

__GRID__

  <div class="foot">
    __FOOT__
  </div>
</div>

<script>
function copyEl(id){
  var t = document.getElementById(id).innerText;
  var done = function(ok){
    var b = event && event.target;
    if(!b) return;
    var old = b.textContent;
    b.textContent = ok ? '已复制' : '复制失败，请手动选中';
    setTimeout(function(){ b.textContent = old; }, 1600);
  };
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){done(true);},function(){done(false);});
      return;
    }
  }catch(e){}
  try{
    var ta=document.createElement('textarea');
    ta.value=t; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    done(document.execCommand('copy')); document.body.removeChild(ta);
  }catch(e){ done(false); }
}
__COUNTDOWN_JS__
</script>
</body>
</html>
"""

PAY_CARD = r"""  <div class="card">
    <div class="pad">
      <div class="cardhead">
        <h2>扫码支付 · 立即获取原画 MP4</h2>
      </div>
      <div class="paywrap">
        <div class="qr"><img alt="微信支付二维码" src="__PAY_QR__"></div>
        <div class="paymid">
          <div class="price">¥__PRICE__<small>一次性</small></div>
          <div class="kv">
            <b>订单号</b><span>__ORDER_ID__</span>
            <b>付款截止</b><span>__EXPIRE_LOCAL__</span>
            <b>收款方式</b><span>微信支付官方商户通道</span>
          </div>
          <div class="count" id="count">剩余支付时间计算中…</div>
        </div>
      </div>
    </div>
  </div>
"""

# 交付态主卡：封面凭证与交付信息**合并同一张卡**。
# 「解析完成」和「封面凭证」本来是同一件事的两半（都在说"后端确实处理了这条视频"），
# 拆两张卡会让用户在两块内容里找同一个文件路径。合并后封面在左、交付信息在右。
DONE_CARD = r"""  <div class="card">
    <div class="pad merged">
      <div class="thumb">__COVER__</div>
      <div class="evidmeta">
        <div class="cardhead">
          <h2>解析完成 · 原画 MP4 已保存到本地</h2>
          <span class="pill ok">已交付</span>
        </div>
        <h1>__TITLE__</h1>
        <div class="meta">
          <span class="av">__AVATAR__</span>
          <span>__AUTHOR__</span>
          __META_EXTRA__
        </div>
        <div class="sect">
          <div class="media">
            <span>时长 <b>__DUR__</b></span>
            <span>体积 <b>__SIZE__</b></span>
            __RES__
          </div>
          <div class="pathlabel">本地文件路径（直接打开这个文件即可，无需再下载）</div>
          <div class="link" id="localpath">__LOCAL__</div>
          <div class="btnrow">
            <button class="primary" onclick="copyEl('localpath')">复制路径</button>
          </div>
        </div>
        __CDN_BLOCK__
        <div class="note">
          视频不做云端保存，<b>本地文件是唯一副本</b>，请自行妥善保管。
        </div>
      </div>
    </div>
  </div>
"""

# 支付态下方的两列网格：左＝凭证卡，右＝免费通道卡。
# 交付态**不渲染本块**（用户已拿到文件，再推免费通道是噪音；顺带省掉小程序码的 31KB 内嵌）。
GRID = r"""  <div class="grid">

    <div>
      <div class="card">
        <div class="pad evid">
          <div class="thumb">__COVER__</div>
          <div class="evidmeta">
            <h1>__TITLE__</h1>
            <div class="meta">
              <span class="av">__AVATAR__</span>
              <span>__AUTHOR__</span>
              __META_EXTRA__
            </div>
            <div class="evidnote">
              封面仅作凭证：后端已解析该视频，可提供原画 MP4 下载服务。
            </div>
          </div>
        </div>
      </div>
    </div>

    <div>
__FREE_CARD__
    </div>

  </div>
"""

CDN_BLOCK = r"""      <div class="slot">
        <div class="pathlabel">临时直链（可选）—— 带签名、会过期，服务端不留存</div>
        <div class="link" id="cdn" style="max-height:74px">__URL__</div>
        <div class="btnrow">
          <button onclick="copyEl('cdn')">复制直链</button>
        </div>
      </div>
"""

FREE_CARD_QR = r"""  <div class="card">
    <div class="pad">
      <h2>不想付费 · 免费通道</h2>
      <div class="free">
        <div class="qr"><img alt="越思工具 小程序码" src="__MP_QR__"></div>
        <div class="steps">
          <ol>
            <li>用微信「扫一扫」扫描上方小程序码</li>
            <li>也可手动搜索小程序 <code>越思工具</code></li>
            <li>把这条链接粘进去即可下载</li>
          </ol>
          __FREE_ALT__
        </div>
      </div>
    </div>
  </div>
"""

# 免费卡右列（二维码右边）的第二个免费通道：网页版。
# 文案只此一处，两个卡片变体（有码 / 无码降级）共用，避免改一处漏一处。
FREE_ALT = r"""<div class="alt">
            手机不便？谷歌搜索 <code>越思科技Yes-Tek</code>，打开网页免费版，粘贴链接即可下载。
          </div>"""

FREE_CARD_TEXT = r"""  <div class="card">
    <div class="pad">
      <h2>不想付费 · 免费通道</h2>
      <div class="steps">
        <ol>
          <li>打开微信 → 发现 → 小程序</li>
          <li>搜索 <code>越思工具</code></li>
          <li>把这条链接粘进去即可下载</li>
        </ol>
        <div class="desc" id="shareurl" style="margin-top:12px">__URL__</div>
        <div class="btnrow"><button onclick="copyEl('shareurl')">复制链接</button></div>
        __FREE_ALT__
      </div>
    </div>
  </div>
"""

COUNTDOWN = r"""
(function(){
  var end = __EXPIRE_UNIX__ * 1000;
  var el = document.getElementById('count');
  if(!el || !end){ if(el){el.textContent='付款截止时间见上方';} return; }
  function tick(){
    var left = end - Date.now();
    // 到期后不再给任何提示（截止时间见上方「付款截止」行），整块倒计时直接收起，避免留下过期文案
    if(left <= 0){ el.style.display = 'none'; return; }
    var s = Math.floor(left/1000), m = Math.floor(s/60), h = Math.floor(m/60);
    var str = h ? (h+' 小时 '+(m%60)+' 分') : (m+' 分 '+(s%60)+' 秒');
    el.textContent = '剩余支付时间 ' + str + ' · 支付后对话侧自动继续解析';
    el.classList.toggle('hot', left < 180000);
    setTimeout(tick, 1000);
  }
  tick();
})();
"""


# ---------------------------------------------------------------- 主流程
def build(args) -> Path:
    raw = json.loads(Path(args.infile).read_text(encoding="utf-8"))
    preview = raw.get("preview") or {}
    order_id = raw.get("order_id", "")
    expire_at = raw.get("expire_at") or 0
    amount = raw.get("amount_cents")

    title = clean_title(preview.get("title") or raw.get("title")) or "未命名视频"
    # 注意：preview.description 是作者自带的视频描述（话题标签串），不是口播文案，
    # 不进页面、不标"文案"、不提供复制。真实逐字稿需本地 ASR 另行产出。
    # 标签串只在对话侧按需给出（extract_tags），页面里不留任何痕迹。

    # 封面 / 头像
    if args.no_remote:
        cover_html, avatar_html = '<span class="ph">封面未内嵌</span>', ""
    else:
        cu = remote_data_uri(preview.get("cover"))
        cover_html = f'<img alt="视频封面" src="{cu}">' if cu else '<span class="ph">封面加载失败</span>'
        au = remote_data_uri(preview.get("avatar"), max_w=120, quality=88)
        avatar_html = f'<img alt="" src="{au}">' if au else esc((preview.get("author") or "?")[:1])

    meta = []
    if preview.get("likes"):
        meta.append(f'<span>点赞 {esc(preview["likes"])}</span>')
    if preview.get("created_at"):
        meta.append('<span class="dot"></span>')
        meta.append(f'<span>{fmt_ymd(preview["created_at"])}</span>')
    meta_extra = "".join(meta)

    # 主卡：支付 or 已交付
    if args.stage == "delivered":
        if not args.local_path and not args.deliver:
            print("--stage delivered 至少需要 --local-path <本地 mp4 路径>", file=sys.stderr)
            sys.exit(2)
        d = {}
        if args.deliver:
            try:
                d = json.loads(Path(args.deliver).read_text(encoding="utf-8"))
            except Exception as e:
                print(f"[warn] deliver.json 解析失败（已忽略）: {e}", file=sys.stderr)
        dur = size = "—"
        res = ""
        if args.probe:
            try:
                p = json.loads(Path(args.probe).read_text(encoding="utf-8"))
                f = p.get("format") or {}
                dur = fmt_dur(f.get("duration"))
                size = fmt_size(f.get("size") or d.get("file_size"))
                st = (p.get("streams") or [{}])[0]
                if st.get("width") and st.get("height"):
                    res = f"<span>分辨率 <b>{esc(st['width'])}×{esc(st['height'])}</b></span>"
            except Exception as e:
                print(f"[warn] probe.json 解析失败（已忽略）: {e}", file=sys.stderr)
        if size == "—":
            size = fmt_size(d.get("file_size"))
        # 默认只给本地路径：服务端不留存文件，直链对用户无沉淀价值
        local = args.local_path or "（未提供本地路径）"
        cdn_block = ""
        if args.show_cdn_link and d.get("url"):
            cdn_block = CDN_BLOCK.replace("__URL__", esc(d["url"]))
        main_card = (DONE_CARD
                     .replace("__LOCAL__", esc(local))
                     .replace("__DUR__", dur)
                     .replace("__SIZE__", size)
                     .replace("__RES__", res)
                     .replace("__CDN_BLOCK__", cdn_block))
        stage_pill = '<span class="pill ok">解析完成</span>'
        cd_js = ""
        # 交付态：不渲染网格（无免费通道），也不内嵌小程序码
        grid_html = ""
        # 交付页没有任何二维码，页脚不能说"二维码已内嵌"（那是支付态的事实）
        foot = "视频仅供个人学习备份，请勿用于商业用途。本页为单文件离线页面，不含任何跟踪脚本。"
    else:
        main_card = (PAY_CARD.replace("__PRICE__", f"{amount / 100:.2f}" if isinstance(amount, int) else "—")
                     .replace("__PAY_QR__", qr_data_uri(raw.get("code_url", "")))
                     .replace("__ORDER_ID__", esc(order_id))
                     .replace("__EXPIRE_LOCAL__", fmt_ts(expire_at)))
        stage_pill = '<span class="pill ok">待支付</span>'
        cd_js = COUNTDOWN.replace("__EXPIRE_UNIX__", str(int(expire_at or 0)))
        foot = ("视频仅供个人学习备份，请勿用于商业用途。本页为单文件离线页面，不含任何跟踪脚本；"
                "二维码图片已内嵌，可直接保存本文件转发。")

        # 免费卡：优先内嵌小程序码，缺素材时降级文字引导
        mp = Path(args.miniprogram_qr) if args.miniprogram_qr else DEFAULT_MP_QR
        mp_uri = png_data_uri(mp) if mp.exists() else ""
        share_url = args.url or ""
        if mp_uri:
            free_card = FREE_CARD_QR.replace("__MP_QR__", mp_uri)
        else:
            free_card = FREE_CARD_TEXT.replace("__URL__", esc(share_url))
            if not share_url:
                # 没有原始短链时不显示空链接块
                free_card = free_card.replace(
                    '<div class="desc" id="shareurl" style="margin-top:12px"></div>', "")
                free_card = free_card.replace(
                    '<div class="btnrow"><button onclick="copyEl(\'shareurl\')">复制链接</button></div>', "")
        # 网页版提示：与二维码素材是否存在无关，两个变体都要有
        free_card = free_card.replace("__FREE_ALT__", FREE_ALT)
        grid_html = GRID.replace("__FREE_CARD__", free_card)

    # ---- 卡片内的公共占位符（封面/标题/作者…）在插入 TPL 之前就填掉 ----
    # 这样主替换链只负责 5 个顶层占位符，不依赖"先替换哪个"的顺序。
    def fill_common(s: str) -> str:
        return (s.replace("__COVER__", cover_html)
                 .replace("__TITLE__", esc(title))
                 .replace("__AVATAR__", avatar_html)
                 .replace("__AUTHOR__", esc(preview.get("author") or "—"))
                 .replace("__META_EXTRA__", meta_extra))

    main_card = fill_common(main_card)
    grid_html = fill_common(grid_html)

    out_html = (TPL
                .replace("__PAGE_TITLE__", esc(f"{title} · 越思工具"))
                .replace("__ORDER_SHORT__", esc(order_id.split("_")[-1][:8] if order_id else "—"))
                .replace("__STAGE_PILL__", stage_pill)
                .replace("__FOOT__", foot)
                .replace("__MAIN_CARD__", main_card)
                .replace("__GRID__", grid_html)
                .replace("__COUNTDOWN_JS__", cd_js))

    # 安全网：任何残留占位符都要报出来，而不是静默写进 HTML
    left = sorted(set(re.findall(r"__[A-Z_]+__", out_html)))
    if left:
        print(f"[warn] 仍有未替换占位符：{left}", file=sys.stderr)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(out_html, encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--url", default="")
    ap.add_argument("--stage", choices=["pay", "delivered"], default="pay")
    ap.add_argument("--local-path", default="",
                    help="已下载的本地 mp4 绝对路径（交付态的主交付物）")
    ap.add_argument("--show-cdn-link", action="store_true",
                    help="交付态额外展示临时 CDN 直链（默认不显示：服务端不留存文件）")
    ap.add_argument("--deliver", default="")
    ap.add_argument("--probe", default="")
    ap.add_argument("--miniprogram-qr", default="")
    ap.add_argument("--no-remote", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    try:
        out = build(args)
    except Exception as e:
        print(f"[error] 渲染失败：{type(e).__name__}: {e}", file=sys.stderr)
        return 1

    if args.quiet:
        print(out)
    else:
        kb = out.stat().st_size / 1024
        print(f"HTML: {out}")
        print(f"自包含单文件 · {kb:.0f} KB · 可直接打开或转发")
        if not args.quiet:
            print("提示：用 present_files 打开该文件，对话里只留价格 + 倒计时 + 一句扫码引导。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
