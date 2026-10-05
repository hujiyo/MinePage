"""分层约束的自动检查。

**为什么用测试而不是只写文档**：原 Node 版的规范都写在注释里，结果该漂移的照样漂移
（前端 `oss` vs 服务端 `opensource`、`ORDER BY` 引用了不存在的列）。约定靠人记，
**检查靠机器** —— 这个文件就是"机器"。

和 `pyproject.toml` 里的 import-linter 配置是同一件事，但这里用 AST 静态扫，
**不依赖额外依赖**，`pytest` 一跑就检查。

覆盖三条规则：

1. `app/api` 不许 import `app.repositories` / `app.models`（Controller 不写 SQL）
2. `app.models` 不许 import 上层（实体不知道业务）
3. `app.repositories` 不许 import `app.services` / `app.api`（持久层不反向依赖）
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "app"

FORBIDDEN: dict[str, tuple[str, ...]] = {
    "api": ("app.repositories", "app.models"),
    "models": ("app.repositories", "app.services", "app.api"),
    "repositories": ("app.services", "app.api"),
}


def _python_files(layer: str) -> list[Path]:
    return sorted((APP_DIR / layer).rglob("*.py"))


def _imported_modules(path: Path) -> set[str]:
    """把一个文件里所有 import 的目标模块名收集起来（含 from ... import ...）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            # 相对导入（level > 0）不算跨层，只看绝对导入
            found.add(node.module)
    return found


@pytest.mark.parametrize(("layer", "forbidden"), list(FORBIDDEN.items()))
def test_分层依赖方向(layer: str, forbidden: tuple[str, ...]) -> None:
    """检查某一层有没有 import 它不该碰的层。"""
    violations: list[str] = []
    for file in _python_files(layer):
        for module in _imported_files_module(file, forbidden):
            violations.append(f"{file.relative_to(APP_DIR.parent)} 导入了 {module}")
    assert not violations, "违反分层约束：\n  " + "\n  ".join(violations)


def _imported_files_module(file: Path, forbidden: tuple[str, ...]) -> set[str]:
    bad: set[str] = set()
    for module in _imported_modules(file):
        for prefix in forbidden:
            if module == prefix or module.startswith(prefix + "."):
                bad.add(module)
    return bad


def test_每个层目录都存在() -> None:
    """分层目录本身也要有 —— 少一个说明有人把代码放错地方了。"""
    for layer in ("core", "models", "schemas", "repositories", "interfaces", "services", "api"):
        assert (APP_DIR / layer).is_dir(), f"缺少层目录 app/{layer}"


def test_模型都注册进了metadata() -> None:
    """`app/models/__init__.py` 必须 import 所有模型。

    漏一个的表现是：Alembic 自动生成迁移时**静默漏掉那张表** —— 不报错，
    只是线上少一张表。所以在这里断言表的数量。
    """
    from app.models import Base

    expected = {
        "comments",
        "email_codes",
        "favorites",
        "follows",
        "likes",
        "mcp_tokens",
        "messages",
        "sessions",
        "site_files",
        "sites",
        "users",
        "view_history",
    }
    actual = set(Base.metadata.tables.keys())
    assert actual == expected, f"缺表：{expected - actual}；多表：{actual - expected}"
