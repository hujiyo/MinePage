"""注释规范的可执行检查。

规范写在 `backend/README.md` 的「注释规范」一节。**这里把其中能自动查的部分变成测试** ——
文档靠人记，测试靠机器跑。

只查能**客观判定**的两条，不做主观判断（比如"注释写得好不好"机器判不了）：

1. **会抛业务异常的函数，docstring 必须有 `Raises:` 段。**
   理由：调用方要知道自己会接到什么。原 Node 版这些信息散在每个 handler 的
   错误分支里，读代码的人得自己推。现在是硬要求。

2. **`Args:` 段里写的参数名，必须和函数签名对得上。**
   理由：这是最容易悄悄错的地方 —— 参数改名了、注释没改，注释就开始骗人，
   而且不会有任何报错。文档骗人比没有文档更糟。

**不查**"哪些函数该写 `Args:`" —— 那是判断题（参数名一看就懂、类型注解已写明的不该硬凑），
交给评审，不交给脚本。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "app"

#: 业务异常的类名（`app/core/exceptions.py` 里 AppError 的那一族）。
#: 用名字而不是 `issubclass` 判断，是为了不把整个 app 包 import 进来 ——
#: 这个测试只做静态分析，不启动任何东西。
APP_ERROR_NAMES = frozenset(
    {
        "AppError",
        "ValidationError",
        "Unauthorized",
        "Forbidden",
        "NotFound",
        "Conflict",
        "PayloadTooLarge",
        "SiteOffline",
        "TooManyRequests",
    },
)

#: Google 风格段标题。出现在 docstring 里就算"写了这一段"。
_SECTION_RE = re.compile(r"^\s*(Args|Arguments|Returns|Raises|Yields|Examples?):\s*$", re.MULTILINE)

#: `Args:` 段里一行参数的形态：`    name: 说明` 或 `    *args: 说明`
_ARG_LINE_RE = re.compile(r"^(?P<indent>\s+)(?P<name>\*{0,2}[A-Za-z_][\w]*)\s*(?:\([^)]*\))?\s*:")


def _python_files() -> list[Path]:
    return sorted(APP_DIR.rglob("*.py"))


def _all_functions() -> list[tuple[Path, ast.FunctionDef | ast.AsyncFunctionDef]]:
    out: list[tuple[Path, ast.FunctionDef | ast.AsyncFunctionDef]] = []
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append((path, node))
    return out


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def _body_source(path: Path, node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """函数体的源码文本（用来找 `raise XxxError`）。"""
    src = _lines(path)
    return "\n".join(src[node.lineno - 1 : (node.end_lineno or node.lineno)])


def _section_body(docstring: str, section: str) -> str:
    """取 docstring 里某个段的内容（到下一个段标题或结尾为止）。"""
    lines = docstring.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip().rstrip(":").lower().startswith(section.lower()):
            start = i + 1
            break
    if start is None:
        return ""
    collected: list[str] = []
    for line in lines[start:]:
        if _SECTION_RE.match(line):
            break
        collected.append(line)
    return "\n".join(collected)


def _param_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """函数签名里的参数名（不含 self / cls）。"""
    names = {a.arg for a in node.args.posonlyargs + node.args.args if a.arg not in ("self", "cls")}
    names |= {a.arg for a in node.args.kwonlyargs}
    if node.args.vararg:
        names.add("*" + node.args.vararg.arg)
    if node.args.kwarg:
        names.add("**" + node.args.kwarg.arg)
    return names


# ---------------------------------------------------------------- 检查 1：Raises


@pytest.mark.parametrize(("path", "node"), _all_functions(), ids=lambda x: getattr(x, "name", ""))
def test_抛业务异常的函数必须写Raises(path: Path, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
    """函数体里 `raise` 了 AppError 的子类 → docstring 必须有 `Raises:` 段。"""
    body = _body_source(path, node)
    raised = {
        m.group(1) for m in re.finditer(r"raise\s+([A-Za-z_]\w*)", body) if m.group(1) in APP_ERROR_NAMES
    }
    if not raised:
        pytest.skip("不抛业务异常")

    doc = ast.get_docstring(node) or ""
    assert "Raises:" in doc, (
        f"{path.relative_to(APP_DIR.parent)}:{node.lineno} `{node.name}` 会抛 "
        f"{sorted(raised)}，但 docstring 没有 `Raises:` 段。\n"
        f"调用方需要知道会接到什么异常 —— 见 README「注释规范」第 3 条。"
    )
    # 段里要真的提到抛出的异常名，不能只写个空的 `Raises:`
    section = _section_body(doc, "Raises")
    for exc in raised:
        assert exc in section, (
            f"{path.relative_to(APP_DIR.parent)}:{node.lineno} `{node.name}` 的 "
            f"`Raises:` 段里没有提到 `{exc}`。"
        )


# ---------------------------------------------------------------- 检查 2：Args 参数名


@pytest.mark.parametrize(("path", "node"), _all_functions(), ids=lambda x: getattr(x, "name", ""))
def test_Args段里的参数名必须与签名一致(path: Path, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
    """`Args:` 段写了参数名，就得写得和签名一样 —— 参数改名后注释不改，注释就开始骗人。"""
    doc = ast.get_docstring(node) or ""
    if "Args:" not in doc:
        pytest.skip("没有 Args 段")

    documented = {
        m.group("name") for line in _section_body(doc, "Args").splitlines() if (m := _ARG_LINE_RE.match(line))
    }
    actual = _param_names(node)

    unknown = documented - actual
    assert not unknown, (
        f"{path.relative_to(APP_DIR.parent)}:{node.lineno} `{node.name}` 的 `Args:` 里写了"
        f"签名里不存在的参数 {sorted(unknown)}。\n  签名里的参数是 {sorted(actual)}"
    )
