#!/usr/bin/env python
r"""从代码里真实解析 import，生成 `backend/docs/03-dependencies.md`（含 mermaid 图）。

## 为什么用生成而不是手画

手画的依赖图**一定会过期** —— 这个项目已经吃过两次"文档和代码脱节"的亏：

* `MP.TAGS`（前端）和服务端 `SITE_TAGS` 各存一份，漂移出 `oss` / `opensource`
* `README` 里写着的接口数、文件数，改完代码没人回头改

所以这里从 `ast` 解析真实 import 生成图。**图不会撒谎。**
`tests/test_dep_graph.py` 会重跑一遍生成、和已提交的文件逐字节比对 ——
**改了代码不同步更新图，测试直接红。**

## 输出

* 层依赖图（7 个包之间，聚合）
* 文件依赖图（每个 `.py`，按层分 subgraph）
* 第三方依赖图（每层用了哪些外部库）
* 反向依赖表（**改某个文件会影响谁** —— 这才是"依赖链"真正要回答的问题）

## 用法

```powershell
cd backend
.\.venv\Scripts\python.exe tools/gen_dep_graph.py              # 写入 docs/03-dependencies.md
.\.venv\Scripts\python.exe tools/gen_dep_graph.py --check      # 只检查是否同步（CI/测试用）
```
"""

from __future__ import annotations

import argparse
import ast
import sys
from collections import defaultdict
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
APP = BACKEND / "app"
OUTPUT = BACKEND / "docs" / "03-dependencies.md"

#: 层的显示顺序与中文名。顺序即"依赖从高到低"，图里也按这个顺序排 subgraph。
#: `app` 指 `app/` 根下的文件（`main.py` / `__init__.py`）—— 它是**装配入口**，
#: 在所有层之上，天生可以碰任何一层。
LAYERS: tuple[tuple[str, str], ...] = (
    ("app", "装配入口 · main"),
    ("api", "接口层 · Controller"),
    ("services", "业务层 · Service"),
    ("repositories", "持久层 · Repository"),
    ("models", "实体层 · Entity"),
    ("schemas", "DTO 层 · Schema"),
    ("interfaces", "抽象契约 · ABC"),
    ("core", "基础设施 · Core"),
)

#: 依赖**只允许**这个方向。用来在文档里标出"实际没用到、但一旦出现就是违规"的边。
ALLOWED: dict[str, frozenset[str]] = {
    "app": frozenset({"api", "services", "repositories", "models", "schemas", "interfaces", "core"}),
    "api": frozenset({"services", "schemas", "core", "interfaces"}),
    "services": frozenset({"repositories", "schemas", "core", "interfaces", "models"}),
    "repositories": frozenset({"models", "core", "schemas"}),
    "models": frozenset({"core"}),
    "schemas": frozenset({"models", "core"}),
    "interfaces": frozenset({"core"}),
    "core": frozenset({"models"}),
}

#: **已知例外**：某些文件天生要跨层，逐个登记并写明理由。
#:
#: 为什么不直接把这些边加进 `ALLOWED`：那样会把整层的规则放宽，
#: 以后 `core/` 下任何一个新文件都能偷偷 import `services`。
#: 按文件例外 + 在文档里单独列出，**改的人必须知道自己在破例**。
EXEMPT: dict[str, str] = {
    "app/core/deps.py": "依赖注入装配点 —— 它的职责就是「把各层接起来」",
    "app/main.py": "应用装配入口 —— 建表、播种管理员、挂路由",
}

#: 判定"是不是第三方/标准库"用的前缀白名单（本项目自己的包只有 app）。
FIRST_PARTY = "app"


class Dep:
    """一个文件解析出来的依赖。"""

    def __init__(self, path: Path) -> None:
        """解析一个文件：算出它的层、它 import 的仓库内模块、以及用到的外部库。"""
        self.path = path
        self.rel = path.relative_to(BACKEND).as_posix()  # app/api/social.py
        parts = self.rel.split("/")
        if not self.rel.startswith("app/"):
            self.layer = "(非 app)"
        elif len(parts) == 2:
            # app/main.py、app/__init__.py —— 直接躺在 app/ 根下，属于「装配入口」层
            self.layer = "app"
        else:
            self.layer = parts[1]
        self.stem = path.stem
        self.internal: set[str] = set()  # app.xxx.yyy（仓库内部）
        self.external: set[str] = set()  # fastapi / sqlalchemy / pathlib …

    @property
    def node(self) -> str:
        """Mermaid 节点 id（只能含字母数字下划线）。"""
        return "f_" + self.rel.replace("/", "_").replace(".py", "").replace("-", "_")

    @property
    def label(self) -> str:
        """节点上显示的文字（层内的相对路径，省地方）。"""
        return self.rel.split("/", 2)[-1] if self.rel.startswith("app/") else self.rel


def _module_of(node: ast.ImportFrom, path: Path) -> str | None:
    """把 `from .x import y` 补全成绝对模块名。"""
    if node.level == 0:
        return node.module
    # 相对导入：按当前文件所在包往上退 level-1 层
    parts = list(path.relative_to(BACKEND).with_suffix("").parts)
    parts = parts[: len(parts) - node.level]
    if node.module:
        parts += node.module.split(".")
    return ".".join(parts)


def collect() -> list[Dep]:
    """扫 `app/` 下全部 `.py`，逐个解析出依赖。"""
    out: list[Dep] = []
    for path in sorted(APP.rglob("*.py")):
        dep = Dep(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    _record(dep, alias.name)
            elif isinstance(node, ast.ImportFrom):
                mod = _module_of(node, path)
                if mod:
                    _record(dep, mod)
        out.append(dep)
    return out


def _record(dep: Dep, module: str) -> None:
    if module == FIRST_PARTY or module.startswith(FIRST_PARTY + "."):
        dep.internal.add(module)
    else:
        dep.external.add(module.split(".")[0])


def internal_targets(dep: Dep, by_module: dict[str, Dep]) -> set[str]:
    """这个文件 import 的那些模块，分别落在哪个**文件**上。

    一个 `from app.core.deps import ...` 精确指向 `app/core/deps.py`；
    但 `from app.models import Base` 指向的是包（`__init__.py`），
    这时按包处理 —— 所以既看完整模块名，也看它去掉最后一段后的包。
    """
    targets: set[str] = set()
    for mod in dep.internal:
        if mod in by_module:
            targets.add(by_module[mod].rel)
            continue
        # 指向包：app.models → app/models/__init__.py
        if mod + ".__init__" in by_module:
            targets.add(by_module[mod + ".__init__"].rel)
            continue
        # 指向包里的某个符号：app.models.user → 也接受 app/models/user
        if mod in by_module:
            targets.add(by_module[mod].rel)
    return targets


def module_index(deps: list[Dep]) -> dict[str, Dep]:
    """模块名 → 文件。`app/api/social.py` → 键 `app.api.social`。"""
    index: dict[str, Dep] = {}
    for d in deps:
        mod = d.rel.replace("/", ".").removesuffix(".py")
        index[mod] = d
    return index


# ---------------------------------------------------------------- 图的生成


def layer_graph(deps: list[Dep], edges: dict[str, set[str]]) -> str:
    """层与层之间的聚合依赖图。"""
    layer_edges: dict[tuple[str, str], int] = defaultdict(int)
    for src_rel, targets in edges.items():
        src_layer = next(d for d in deps if d.rel == src_rel).layer
        for tgt_rel in targets:
            tgt_layer = next(d for d in deps if d.rel == tgt_rel).layer
            if src_layer != tgt_layer:
                layer_edges[(src_layer, tgt_layer)] += 1

    lines = ["```mermaid", "flowchart TD"]
    for key, title in LAYERS:
        lines.append(f'    {key}["{key}/<br/>{title}"]')
    lines.append("")
    for (src, tgt), n in sorted(layer_edges.items()):
        lines.append(f"    {src} -->|{n}| {tgt}")
    lines.append("```")
    return "\n".join(lines)


def file_graph(deps: list[Dep], edges: dict[str, set[str]]) -> str:
    """文件级依赖图，按层分 subgraph。"""
    by_layer: dict[str, list[Dep]] = defaultdict(list)
    for d in deps:
        by_layer[d.layer].append(d)

    lines = ["```mermaid", "flowchart TD"]
    for key, title in LAYERS:
        members = sorted(by_layer.get(key, []), key=lambda d: d.rel)
        if not members:
            continue
        lines.append(f'    subgraph sg_{key}["{key}/ · {title}"]')
        lines.append("        direction TB")
        for d in members:
            lines.append(f'        {d.node}["{d.label}"]')
        lines.append("    end")
    lines.append("")
    for src_rel in sorted(edges):
        src = next(d for d in deps if d.rel == src_rel)
        for tgt_rel in sorted(edges[src_rel]):
            tgt = next(d for d in deps if d.rel == tgt_rel)
            if src.layer == tgt.layer:
                lines.append(f"    {src.node} --> {tgt.node}")
            else:
                lines.append(f"    {src.node} --> {tgt.node}")
    lines.append("```")
    return "\n".join(lines)


def external_graph(deps: list[Dep]) -> str:
    """每层用了哪些第三方/标准库。"""
    per_layer: dict[str, set[str]] = defaultdict(set)
    for d in deps:
        per_layer[d.layer] |= d.external

    all_libs = sorted({lib for libs in per_layer.values() for lib in libs})
    lines = ["```mermaid", "flowchart LR"]
    for key, _ in LAYERS:
        lines.append(f'    {key}["{key}/"]')
    lines.append("")
    for lib in all_libs:
        lib_node = "lib_" + lib.replace("-", "_")
        lines.append(f'    {lib_node}(["{lib}"])')
    lines.append("")
    for key, _ in LAYERS:
        for lib in sorted(per_layer.get(key, set())):
            lines.append(f"    {key} --> {'lib_' + lib.replace('-', '_')}")
    lines.append("```")
    return "\n".join(lines)


def reverse_table(deps: list[Dep], edges: dict[str, set[str]]) -> str:
    """反向依赖：**改这个文件会影响谁**。"""
    reverse: dict[str, set[str]] = defaultdict(set)
    for src, targets in edges.items():
        for tgt in targets:
            reverse[tgt].add(src)

    lines = ["| 文件 | 被这些文件依赖（改它要一起看） | 个数 |", "|---|---|---|"]
    for d in sorted(deps, key=lambda x: x.rel):
        users = sorted(reverse.get(d.rel, set()))
        cell = "、".join(f"`{u.split('/', 1)[-1]}`" for u in users) if users else "（没人依赖它）"
        lines.append(f"| `{d.rel}` | {cell} | {len(users)} |")
    return "\n".join(lines)


def module_table(deps: list[Dep], edges: dict[str, set[str]]) -> str:
    """正向：每个文件依赖了谁。"""
    lines = ["| 文件 | 依赖的仓库内文件 | 第三方/标准库 |", "|---|---|---|"]
    for d in sorted(deps, key=lambda x: x.rel):
        tgts = sorted(edges.get(d.rel, set()))
        tgt_cell = "、".join(f"`{t.split('/', 1)[-1]}`" for t in tgts) if tgts else "—"
        ext_cell = "、".join(sorted(d.external)) if d.external else "—"
        lines.append(f"| `{d.rel}` | {tgt_cell} | {ext_cell} |")
    return "\n".join(lines)


# ---------------------------------------------------------------- 主流程


def build() -> str:
    """生成 `docs/03-dependencies.md` 的完整内容。

    纯函数：不写文件。所以测试可以直接调它拿"应该是什么"，
    再和已提交的文件比对 —— 这就是"图会不会过期"的那条检查。
    """
    deps = collect()
    index = module_index(deps)
    edges = {d.rel: internal_targets(d, index) for d in deps}

    layer_pairs: dict[tuple[str, str], set[str]] = defaultdict(set)
    for src_rel, targets in edges.items():
        src_layer = next(x for x in deps if x.rel == src_rel).layer
        for tgt_rel in targets:
            tgt_layer = next(x for x in deps if x.rel == tgt_rel).layer
            if src_layer != tgt_layer:
                layer_pairs[(src_layer, tgt_layer)].add(src_rel)

    illegal: list[str] = []
    exempted: list[tuple[str, str, str]] = []
    for (src_layer, tgt_layer), sources in sorted(layer_pairs.items()):
        if tgt_layer in ALLOWED.get(src_layer, frozenset()):
            continue
        for src_rel in sorted(sources):
            why = EXEMPT.get(src_rel)
            if why:
                exempted.append((src_rel, f"{src_layer} → {tgt_layer}", why))
            else:
                illegal.append(f"`{src_layer}` → `{tgt_layer}`（来自 `{src_rel}`）")

    parts: list[str] = []
    parts.append("# 后端目录依赖链（**自动生成，不要手改**）")
    parts.append("")
    parts.append(
        "> 由 `tools/gen_dep_graph.py` 从代码里真实解析 import 生成。\n"
        "> 改了代码不同步更新这个文件，`tests/test_dep_graph.py` 会红。\n"
        "> 重新生成：`.venv/Scripts/python.exe tools/gen_dep_graph.py`"
    )
    parts.append("")
    total_edges = sum(len(v) for v in edges.values())
    parts.append(f"统计：**{len(deps)}** 个 Python 文件，**{total_edges}** 条文件间依赖。")
    parts.append("")

    parts.append("## 一、层依赖（7 个包之间）")
    parts.append("")
    parts.append("箭头上的数字是**跨层的文件级依赖条数**。")
    parts.append("")
    parts.append(layer_graph(deps, edges))
    parts.append("")
    if illegal:
        parts.append("### ⚠️ 违规的层依赖")
        parts.append("")
        for x in illegal:
            parts.append(f"- {x}")
    else:
        parts.append("### ✅ 层依赖方向检查")
        parts.append("")
        parts.append("所有跨层依赖都在允许范围内（见 `pyproject.toml` 的 import-linter 契约）。")
    parts.append("")

    parts.append("### 已知例外（跨层，但**逐个登记过理由**）")
    parts.append("")
    if exempted:
        parts.append("| 文件 | 跨的层 | 为什么允许 |")
        parts.append("|---|---|---|")
        for src_rel, pair, why in exempted:
            parts.append(f"| `{src_rel}` | {pair} | {why} |")
        parts.append("")
        parts.append(
            "> 为什么不把这几条直接加进 `ALLOWED`：那样会把**整层**的规则放宽，\n"
            "> 以后 `core/` 下任何一个新文件都能偷偷 import `services`。\n"
            "> 按文件登记，**破例的人必须知道自己在破例** —— 名单在 `tools/gen_dep_graph.py` 的 `EXEMPT`。"
        )
    else:
        parts.append("（无）")
    parts.append("")

    parts.append("## 二、文件依赖（按层分组）")
    parts.append("")
    parts.append(file_graph(deps, edges))
    parts.append("")

    parts.append("## 三、第三方与标准库依赖")
    parts.append("")
    parts.append("这一张回答「**这一层碰了哪些外部世界**」。层越靠下，越该只用标准库。")
    parts.append("")
    parts.append(external_graph(deps))
    parts.append("")

    parts.append("## 四、正向：每个文件依赖了谁")
    parts.append("")
    parts.append(module_table(deps, edges))
    parts.append("")

    parts.append("## 五、反向：**改这个文件会影响谁**")
    parts.append("")
    parts.append(
        "这才是「依赖链」真正要回答的问题 —— 动一个文件之前，先看这一列。\n"
        "比如 `core/security.py` 被谁用到，决定了改密码哈希要重跑哪些测试。"
    )
    parts.append("")
    parts.append(reverse_table(deps, edges))
    parts.append("")

    return "\n".join(parts)


def main() -> int:
    """命令行入口。

    `--check` 只比对不写入（给测试和 CI 用），默认写入 `docs/03-dependencies.md`。
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只检查是否与已提交的一致，不写入")
    args = parser.parse_args()

    content = build()
    if args.check:
        if not OUTPUT.exists():
            print(f"缺少 {OUTPUT.relative_to(BACKEND)} —— 请跑一次 tools/gen_dep_graph.py")
            return 1
        if OUTPUT.read_text(encoding="utf-8") != content:
            print("依赖图和代码不同步。请跑：.venv/Scripts/python.exe tools/gen_dep_graph.py")
            return 1
        print("依赖图与代码同步 ✓")
        return 0

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(content, encoding="utf-8")
    print(f"已写入 {OUTPUT.relative_to(BACKEND)}（{len(content.splitlines())} 行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
