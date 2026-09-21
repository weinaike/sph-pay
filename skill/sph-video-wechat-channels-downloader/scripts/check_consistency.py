#!/usr/bin/env python3
"""check_consistency.py — 校验散落文本与 render_order.py 常量的一致性（改价 / 改名后必跑）。

单一事实源在 render_order.py：PACKAGES（套餐价目）与 MP_NAME（小程序名），
对外出口是 `render_order.py --dump-packages`。文档不抄写价目数字，只指向 dump。

本脚本用 ast 静态读取常量（不 import render_order，因此**不需要** qrcode/pillow），
扫描 skill 目录的 *.md / *.py（跳过 __pycache__ 与脚本自身）：

  1) 书名号名称         —— 必须全部等于 MP_NAME，任何文件都不许各说各话
  2) __MP_NAME__ 占位符 —— 只允许出现在 render_order.py（模板定义处）；别处出现 = 替换链漏了
  3) 套餐价目数字       —— PACKAGES 的价格 / 单条折算价出现在 render_order.py 之外 = 文档抄价漂移

用法：python check_consistency.py     （Python ≥3.8，无需第三方库）
退出码：0 一致 / 1 发现漂移（并列出全部位置）
"""
import ast
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
RO = SCRIPT_DIR / "render_order.py"


def read_const(name):
    """ast 直读 render_order.py 的顶层常量；找不到返回 None。"""
    tree = ast.parse(RO.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    return None


def norm_num(x: str) -> str:
    """"0.50" 与 "0.5" 视为同值；整数不动（"50" ≠ "5"）。"""
    if "." in x:
        x = x.rstrip("0").rstrip(".")
    return x or "0"


def main() -> int:
    mp_name = read_const("MP_NAME")
    packages = read_const("PACKAGES")
    if not mp_name or not packages:
        print(f"[error] 未能从 {RO.name} 读到 MP_NAME / PACKAGES 常量", file=sys.stderr)
        return 1

    pkg_nums = set()
    for p in packages:
        pkg_nums.add(norm_num(str(p["price"])))
        m = re.search(r"(\d+(?:\.\d+)?)", p.get("unit", ""))
        if m:
            pkg_nums.add(norm_num(m.group(1)))
    pkg_nums.discard("0")

    files = [p for p in sorted(SKILL_DIR.rglob("*"))
             if p.suffix in (".md", ".py")
             and "__pycache__" not in p.parts
             and p != Path(__file__).resolve()]

    problems, review = [], []
    for f in files:
        rel = f.relative_to(SKILL_DIR)
        is_src = f == RO
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for name in re.findall(r"《([^》]+)》", line):
                if name != mp_name:
                    problems.append(f"{rel}:{i}  名称《{name}》≠ MP_NAME《{mp_name}》")
            if "__MP_NAME__" in line and not is_src and f.suffix == ".py":
                # 只查脚本：文档以反引号提及占位符是说明，不算漂移
                problems.append(f"{rel}:{i}  模板占位符 __MP_NAME__ 出现在 render_order.py 之外")
            for m in re.finditer(r"¥\s*(\d+(?:\.\d+)?)", line):
                if is_src:
                    continue
                num = m.group(1)
                if norm_num(num) in pkg_nums:
                    problems.append(f"{rel}:{i}  套餐价目 ¥{num} 抄写在 render_order.py 之外"
                                    f"——应改为指向 --dump-packages")
                else:
                    review.append(f"{rel}:{i}  ¥{num}（非套餐价目；单条价应以 healthz 为源，人工确认）")

    for p in problems:
        print(f"✗ {p}")
    for r in review:
        print(f"… {r}")

    if problems:
        print(f"\n共 {len(problems)} 处不一致 —— 修复后重跑。")
        return 1
    prices = "/".join(str(p["price"]) for p in packages)
    tail = f"；{len(review)} 处 ¥ 金额需人工确认（见上）" if review else ""
    print(f"一致：MP_NAME《{mp_name}》· 套餐价目 ¥{prices} 无文档漂移{tail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
