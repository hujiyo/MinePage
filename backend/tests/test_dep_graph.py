"""依赖图必须与代码同步。

生成器在 `tools/gen_dep_graph.py`，产物是 `docs/dependencies.md`。
这里重跑一遍生成逻辑，和已提交的文件逐字节比对 ——
**改了代码不同步更新图，测试就红。**

为什么做成测试而不是"记得手动跑"：这个项目已经吃过两次文档脱节的亏
（前端 `MP.TAGS` 与服务端 `SITE_TAGS` 漂移出 `oss` / `opensource`；
README 里写着的接口数和文件数，改完代码没人回头改）。
**约定靠人记，检查靠机器。**

为什么用 `importlib` 按路径加载而不是直接 `import tools.gen_dep_graph`：
`tools/` 是开发工具、不是要发布的包（`pyproject.toml` 里 `packages = ["app"]`），
所以它不在 `sys.path` 上。按路径加载比为了测试而把它塞进安装包更干净。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

BACKEND = Path(__file__).resolve().parent.parent


def _load_generator() -> ModuleType:
    """按文件路径加载依赖图生成器。"""
    path = BACKEND / "tools" / "gen_dep_graph.py"
    assert path.exists(), f"生成器不见了：{path}"
    spec = importlib.util.spec_from_file_location("gen_dep_graph", path)
    assert spec is not None and spec.loader is not None, "无法加载生成器"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def generator() -> ModuleType:
    return _load_generator()


def test_依赖图与代码同步(generator: ModuleType) -> None:
    """`docs/dependencies.md` 必须是当前代码的真实反映。"""
    output: Path = generator.OUTPUT
    assert output.exists(), "缺少 docs/dependencies.md —— 请跑 tools/gen_dep_graph.py"

    expected = generator.build()
    actual = output.read_text(encoding="utf-8")
    assert actual == expected, (
        "docs/dependencies.md 与代码不同步（多半是刚加了 import 或新文件）。\n"
        "重新生成：.venv/Scripts/python.exe tools/gen_dep_graph.py"
    )


def test_没有未登记的跨层依赖(generator: ModuleType) -> None:
    """跨层依赖要么合规，要么在生成器的 `EXEMPT` 里**逐个登记过理由**。

    `import-linter` 管的是硬规则（api 不许直接 import repositories 之类）；
    这里管的是**例外名单有没有被偷偷扩大** ——
    比如以后有人在 `core/` 下新写个文件直接 import `services`，
    它不在 `EXEMPT` 里，这里就会红。
    """
    content = generator.build()
    assert "⚠️ 违规的层依赖" not in content, (
        "出现了未登记的跨层依赖。要么改代码，要么在 tools/gen_dep_graph.py 的 "
        "EXEMPT 里登记理由（详见 docs/dependencies.md）。"
    )


def test_生成器报出了装配点例外(generator: ModuleType) -> None:
    """反向验证：`core/deps.py` 这个已知例外**必须仍然被报出来**。

    如果哪天它不再被报出来，说明 `ALLOWED` 被放宽了 —— 那是把整层的规则
    悄悄松开，比加一个文件例外危险得多。这条测试就是钉住这件事。
    """
    content = generator.build()
    assert "app/core/deps.py" in content, "core/deps.py 的跨层例外没有被报出来"
