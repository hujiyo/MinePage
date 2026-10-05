#!/usr/bin/env python
r"""提交前检查 —— **一条命令跑完全部门禁，包括重新生成依赖图**。

## 为什么要有这个脚本

`backend/README.md` 的「验收标准」列了五条命令，加上"改了代码要重新生成依赖图"，
一共六件事。**靠人记一定会漏** —— 这个项目已经吃过"约定没变成机制"的亏。

所以把它们收成一条：

```powershell
cd backend
.\.venv\Scripts\python.exe tools/preflight.py           # 只检查
.\.venv\Scripts\python.exe tools/preflight.py --fix      # 先自动修（重生依赖图 + 格式化），再检查
```

**接口或任何 import 有变化时，依赖图必须重新生成** —— 这是这个脚本
第一件事就干的事。忘了也不怕：`tests/test_dep_graph.py` 会红。

## 退出码

`0` 全过；`1` 有失败项。**任何一项失败就不该提交。**

## 不做什么

* 不 `git commit`、不 `git push` —— 提交时机由人决定
* 默认**不改任何文件**（除了 `--fix` 模式下的依赖图和格式）
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
VENV_BIN = Path(sys.executable).parent


class Step:
    """一个检查项。"""

    #: **哪些项值得失败后重试一次**。
    #:
    #: 只放"会加载编译好的扩展"的命令（mypy / lint-imports 都是）。原因：
    #: 本机 Windows 搜索索引器（`SearchIndexer`）会短暂锁住刚写入的 `.pyd`，
    #: 表现为 `DLL load failed while importing xxx: 另一个程序正在使用此文件` ——
    #: **等几秒重试就好**，不是真的类型错误。
    #:
    #: 不给测试/规范/格式加重试：它们不加载编译扩展，失败就是真失败，
    #: 重试只是浪费时间。
    RETRYABLE = frozenset({"类型检查", "分层依赖"})

    def __init__(self, name: str, cmd: list[str], note: str = "") -> None:
        """`name` 是汇总表里显示的名字；`note` 是失败时给的修复提示。"""
        self.name = name
        self.cmd = cmd
        self.note = note
        self.code = -1
        self.seconds = 0.0
        self.retried = False

    @property
    def ok(self) -> bool:
        """这一项过了没有（退出码为 0）。"""
        return self.code == 0

    def run(self, cwd: Path) -> None:
        """跑一次；如果是可重试项且失败了，等几秒再跑一次（瞬时文件锁用）。

        **不捕获输出** —— 每条命令的完整输出直接打到终端，出问题时不用再跑一遍。
        """
        started = time.perf_counter()
        self.code = subprocess.run(self.cmd, cwd=cwd, check=False).returncode

        if self.code != 0 and self.name in self.RETRYABLE:
            print(f"→ 失败（退出码 {self.code}）。{self.name} 属于可重试项 ——")
            print("  本机索引器会短暂锁住刚写的 .pyd（DLL load failed），等 5 秒重试一次。\n")
            time.sleep(5)
            self.code = subprocess.run(self.cmd, cwd=cwd, check=False).returncode
            self.retried = True
            if self.ok:
                print("→ 重试通过 ✓（确认是瞬时文件锁，不是代码问题）\n")

        self.seconds = time.perf_counter() - started


def lint_imports_exe() -> str:
    """找 `lint-imports` 可执行文件。

    它**不是 Python 模块**（`python -m lint_imports` 会报 `No module named`），
    是 pip 装的命令行脚本，必须按路径调。
    """
    name = "lint-imports.exe" if os.name == "nt" else "lint-imports"
    path = VENV_BIN / name
    return str(path) if path.exists() else "lint-imports"


def build_steps(py: str) -> list[Step]:
    """按"最快失败、最该关注"的顺序排：依赖图 → 测试 → 规范 → 类型 → 分层。"""
    return [
        Step(
            "依赖图同步",
            [py, "tools/gen_dep_graph.py", "--check"],
            note="改了 import 就要重生：tools/gen_dep_graph.py",
        ),
        Step("契约与单元测试", [py, "-m", "pytest"]),
        Step("代码规范", [py, "-m", "ruff", "check", "app", "tests", "alembic", "tools"]),
        Step(
            "代码格式",
            [py, "-m", "ruff", "format", "--check", "app", "tests", "alembic", "tools"],
            note="自动格式化：加 --fix",
        ),
        Step("类型检查", [py, "-m", "mypy", "app", "tools"]),
        Step("分层依赖", [lint_imports_exe()]),
    ]


def fix(py: str) -> None:
    """`--fix` 模式：先做两件**幂等且安全**的自动修复。

    只做这两件，因为它们的结果完全由代码决定、不会改语义：

    * 重新生成依赖图（产物是纯函数 `build()` 的输出）
    * `ruff format`（只动格式）

    **不做**任何"看起来像修复"的事（不自动删 import、不自动改类型）——
    那些要人判断。
    """
    print("── 自动修复（--fix） ──")
    for cmd in (
        [py, "tools/gen_dep_graph.py"],
        [py, "-m", "ruff", "format", "app", "tests", "alembic", "tools"],
    ):
        print(f"$ {' '.join(cmd)}")
        subprocess.run(cmd, cwd=BACKEND, check=False)
    print()


def main() -> int:
    """跑完全部门禁，返回进程退出码（0 全过 / 1 有失败）。"""
    parser = argparse.ArgumentParser(description="提交前检查")
    parser.add_argument("--fix", action="store_true", help="先自动重生依赖图并格式化，再检查")
    args = parser.parse_args()

    py = sys.executable
    if args.fix:
        fix(py)

    steps = build_steps(py)
    print("═══ 提交前检查 ═══\n")
    for step in steps:
        print(f"── {step.name} ──")
        print(f"$ {' '.join(step.cmd)}")
        step.run(BACKEND)
        verdict = "通过" if step.ok else f"**失败（退出码 {step.code}）**"
        if step.retried and step.ok:
            verdict += "（重试后）"
        print(f"→ {verdict}  {step.seconds:.1f}s\n")
        if not step.ok and step.note:
            print(f"   提示：{step.note}\n")

    print("═══ 汇总 ═══\n")
    print("| 检查项 | 结果 | 用时 |")
    print("|---|---|---|")
    for step in steps:
        mark = "✅ 通过" if step.ok else "❌ 失败"
        if step.retried and step.ok:
            mark += "（重试）"
        print(f"| {step.name} | {mark} | {step.seconds:.1f}s |")

    failed = [s for s in steps if not s.ok]
    print()
    if failed:
        print(f"❌ {len(failed)} 项失败：" + "、".join(s.name for s in failed))
        print("   修完再跑一次。**不要带着失败的检查提交。**")
        return 1

    print(f"✅ 全部通过（{len(steps)} 项）。可以提交了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
