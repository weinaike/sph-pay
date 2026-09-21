# assets 目录

本目录**只放图片素材**，不放脚本。

## 小程序名（单一事实源与校验）

免费通道的小程序名 = **越思工具**，定义在 `scripts/render_order.py` 的 `MP_NAME` 常量（顶栏 `.brand`、`<title>` 后缀、小程序码 `alt`、引导 `<code>` 都经 `__MP_NAME__` 占位符自动跟随）。文档里仍会以文字提到它（用户要照着搜），出现位置：

| 文件 | 位置 |
|---|---|
| `scripts/render_order.py` | `MP_NAME` 常量（定义处，模板引用它） |
| `SKILL.md` | 免费层口径、A 轨对话模板、必传达内容、第 7 节免费方式 |
| `references/rendering.md` | 免费卡降级文字引导 |
| `references/rendering-dev.md` | 单一事实源说明（§三） |
| `references/faq.md` | 合规口径（运营主体） |
| `assets/README.md` | 本文件 |

改名：只改 `MP_NAME` 一处 → 跑 `python scripts/check_consistency.py` 校验全库一致（书名号名称、`__MP_NAME__` 占位符残留、套餐价目漂移三查）→ `rm -rf scripts/__pycache__`（旧字节码里也留着旧字符串）。

## company-logo.png

顶栏**公司品牌标识**：22px 圆角 logo + 「越思科技 Yes-Tek」文字，整体 `<a>` 链到官网（`render_order.py` 的 `COMPANY_URL`，新窗口打开）。三个阶段（支付 / 套餐支付 / 交付）的顶栏共用。

- **来源**：官网 apple-touch-icon `https://www.yes-tek.com/assets/ic_launcher.png`（512×512 透明底）。
- **规格**：等比压到 64×64、PNG 透明底、约 5KB。显示 22px × retina 3x = 66px，64px 基本无插值放大；换图时保持 ≤64px 边长即可，CSS 不用动。
- **内嵌方式**：`png_data_uri()` 原样读字节（二维码级同款处理，不做有损压缩）。
- **未放置时**：顶栏自动降级为纯文字品牌（名称与官网链接仍在），不报错。
- **名称/官网改动**：改 `render_order.py` 的 `COMPANY_NAME` / `COMPANY_URL` 常量（顶栏与免费卡搜索关键词同源），跑 `python scripts/check_consistency.py` 校验。

## miniprogram-qr.png

免费通道《越思工具》的**小程序码**，由渲染脚本自动内嵌进 HTML。

- **获取方式**：微信公众平台 → 小程序后台 → 推广 → 小程序码，自行生成并下载。
- **放置方式**：**不要直接把下载的图丢进来**，先用规范化脚本处理（下面解释为什么）：

```bash
"$PY" "$SKILL_DIR/scripts/prep_mp_qr.py" <你下载的码> --out "$SKILL_DIR/assets/miniprogram-qr.png"
```

> `$PY` = `ensure_deps.py --python` 的输出（prep_mp_qr.py 依赖 pillow，勿用裸 python）。

- **未放置时**：渲染脚本自动降级为文字引导卡（「微信 → 发现 → 小程序 → 搜索《越思工具》」+ 一键复制分享链接），不报错，也不画假码。

### 为什么必须过一遍 `prep_mp_qr.py`

从公众平台或截图二次处理得到的码，常见两个问题，直接丢进 assets/ 会埋雷：

| 问题 | 后果 | 脚本处理 |
|---|---|---|
| **静区被裁掉**（图案贴边） | 静区不足是扫码失败的首要原因，比模块密度更致命 | 按 4 模块标准补足白边（实测常见只有 0.6 模块） |
| **是 JPEG 而非 PNG** | `png_data_uri()` 原样读字节并声明 `data:image/png`，JPEG 字节配 PNG 声明不可靠；且 JPEG 振铃伪影干扰码点 | 真转码为 PNG，无损保存 |
| **文件名/扩展名不对**（如放成 `miniprogram-qr.jpg`） | 渲染器按 `assets/miniprogram-qr.png` **精确查找**：扩展名不符 → `mp.exists()` 为假 → **静默降级为文字引导卡**。不报错、不告警，小程序码一次都不会出现 —— 最难察觉的一种 | `prep_mp_qr.py` 的输出名固定为 `miniprogram-qr.png`，跑一遍即同时解决格式与命名 |

> **症状自查**：渲染出的页面里搜不到 `小程序码`、只有一段可复制的分享链接，就是 degrade 到文字卡了。别只看"页面没报错"。

脚本还会打印体检报告（图案尺寸、px/模块、现有静区、建议显示尺寸），并在源分辨率过低时告警。退出码 0 = 已写出可用素材。

### 显示尺寸必须与素材分辨率匹配

`render_order.py` 里 `.free .qr img` 的宽度**不是随便定的**，要与素材分辨率对得上，否则浏览器插值放大反而糊：

```
CSS 显示尺寸 × 2（retina）  ≤  素材边长   →  无插值放大，最清晰
```

当前素材 303×303 → 显示 **150px**（retina 300px ≤ 303px ✓）。

**换素材后必须同步改这个值**。例：

| 素材边长 | 建议显示宽度 |
|---|---|
| 303px | 150px |
| 430px | 210px |
| 645px | 320px（但右列只有 370px 内宽，需同时调版式） |

右边列（`1fr` ≈ 370px 内宽）能容纳的二维码块上限约 **180px**，超过会挤压右侧操作步骤列导致折行。

### 硬约束

> **必须用微信官方生成的小程序码。** 普通二维码无论长得像不像，都**无法唤起小程序**——用户扫了会得到错误结果，比不显示更糟。

### 素材审计（换码后建议跑一遍）

```bash
# 内嵌是否逐字节一致 / 静区是否达标 / 声明与实际字节是否匹配
python - <<'PY'
import re, base64, hashlib, io
from PIL import Image
h = open("<渲染出的 html>", encoding="utf-8").read()
uris = re.findall(r'src="data:image/([a-z]+);base64,([A-Za-z0-9+/=]+)"', h)
MAGIC = {"png": b"\x89PNG\r\n\x1a\n", "jpeg": b"\xff\xd8\xff"}
for d, b in uris:
    raw = base64.b64decode(b)
    real = next((k for k, m in MAGIC.items() if raw.startswith(m)), "?")
    print(d, real, "匹配" if d == real else "★不匹配★", Image.open(io.BytesIO(raw)).size)
PY
```

**判定要点**：`data:image/png` 的资源，实际字节必须以 PNG 魔数开头。若声明 png 而字节是 JPEG，说明素材没走 `prep_mp_qr.py` 处理。
