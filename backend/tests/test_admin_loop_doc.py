"""保证 `docs/04-admin-loop.md` 的闭环图**不跟代码漂移**。

## 为什么需要这个测试

那张图是**排查故障用的**。一张会过期的排查图比没有图更糟 ——
它会把人引到错误的地方，而且**不会报错**。

所以这里把图里的接口清单当成**契约**来校验：

* 图里写了、代码里没有 → 测试失败（图过期了）
* 代码里有、图里没写 → 测试失败（漏画了）

改管理接口而忘了改图，CI 会拦下来。

（同样的思路下，`tools/gen_dep_graph.py` 的依赖图是**自动生成**的，
不存在漂移问题；这张图是手写的，因为它画的是**行为**而不是 import 关系，
没法从代码直接生成 —— 所以用测试来兜。）
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.config import Settings
from app.main import create_app

DOC_PATH = Path(__file__).resolve().parent.parent / "docs" / "04-admin-loop.md"

#: 图里那段的标记。`docs/04-admin-loop.md` 用它圈出权威清单。
BEGIN = "<!-- ADMIN_ENDPOINTS:BEGIN"
END = "<!-- ADMIN_ENDPOINTS:END -->"


def doc_text() -> str:
    """读闭环图文档。文件不存在就直接失败，别静默跳过。"""
    assert DOC_PATH.exists(), f"闭环图不见了：{DOC_PATH}"
    return DOC_PATH.read_text(encoding="utf-8")


def parse_doc_endpoints(text: str) -> set[tuple[str, str]]:
    """从标记之间的表格里解析出 `(方法, 路径)`。

    表格长这样：`| GET | /api/admin/users | 管理员 |`
    """
    start = text.find(BEGIN)
    assert start >= 0, f"文档里找不到 {BEGIN} 标记"
    end = text.find(END, start)
    assert end >= 0, f"文档里找不到 {END} 标记"

    found: set[tuple[str, str]] = set()
    for line in text[start:end].splitlines():
        m = re.match(r"^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*(/\S+)\s*\|", line)
        if m:
            found.add((m.group(1), m.group(2)))
    return found


def live_admin_endpoints() -> set[tuple[str, str]]:
    """运行中的 app 实际注册了哪些 `/api/admin/*`。**以 OpenAPI 为准。**

    刻意不遍历 `app.routes` —— 新版 FastAPI 的 `include_router`
    在 `routes` 里放的是包装对象，`getattr(r, "path")` 取不到东西
    （我一开始就是这么查的，结果误判成"路由没挂上"）。
    """
    app = create_app(Settings(public_dir=str(Path(__file__).parent)))
    paths = app.openapi()["paths"]

    out: set[tuple[str, str]] = set()
    for path, ops in paths.items():
        if path.startswith("/api/admin"):
            for method in ops:
                out.add((method.upper(), path))
    return out


class TestAdminLoopDoc:
    """文档与代码的一致性。"""

    def test_doc_endpoints_match_code(self) -> None:
        """图里的接口清单 == 代码里实际注册的接口。**差一个就失败。**"""
        doc = parse_doc_endpoints(doc_text())
        live = live_admin_endpoints()

        missing_in_code = doc - live
        missing_in_doc = live - doc

        assert not missing_in_code, "图里画了但代码里没有（图过期了）：" + ", ".join(
            f"{m} {p}" for m, p in sorted(missing_in_code)
        )
        assert not missing_in_doc, "代码里有但图里没画（漏画了）：" + ", ".join(
            f"{m} {p}" for m, p in sorted(missing_in_doc)
        )

    def test_doc_lists_five_endpoints(self) -> None:
        """管理接口是 5 条。数量变了说明有人加了/删了接口，这时**必须**回头改图。"""
        assert len(parse_doc_endpoints(doc_text())) == 5
        assert len(live_admin_endpoints()) == 5

    def test_all_endpoints_require_admin(self) -> None:
        """5 条接口**每一条**都挂了 `require_admin`。

        靠 API 层源码检查 —— 这是"会不会漏挂鉴权"的唯一自动化保障，
        漏挂的表现是"接口能用但不该能用"，**不会有任何报错**。
        """
        from app.api import admin as admin_api

        src = Path(admin_api.__file__).read_text(encoding="utf-8")
        route_defs = re.findall(r"@router\.(get|post|put|delete|patch)\(", src)
        guard_uses = src.count("Depends(require_admin)")

        assert len(route_defs) == 5, f"路由数不对：{route_defs}"
        assert guard_uses == 5, (
            f"有 {len(route_defs)} 条路由，但只有 {guard_uses} 处 require_admin —— 有接口漏挂鉴权"
        )


class TestDocStructure:
    """图的形状本身 —— 少了 mermaid 块说明有人误删了。"""

    def test_has_mermaid_blocks(self) -> None:
        """至少两块：闭环全景 + 状态归一化。"""
        blocks = re.findall(r"```mermaid", doc_text())
        assert len(blocks) >= 2, f"只有 {len(blocks)} 块 mermaid 图"

    def test_mermaid_blocks_are_closed(self) -> None:
        """```mermaid 和 ``` 必须配对 —— 不配对的话图在整个文件里都渲染不出来。"""
        fences = re.findall(r"^```(\w*)", doc_text(), re.MULTILINE)
        assert fences.count("mermaid") >= 2
        assert len(fences) % 2 == 0, f"代码围栏数量是奇数，有没闭合的块：{fences}"

    @pytest.mark.parametrize(
        "keyword",
        [
            "require_admin",  # 鉴权闸门
            "banned",  # 用户状态
            "offline",  # 站点状态
            "451",  # 下线后的行为
            "403",  # 被封者登录
            "不能封禁自己",  # 业务规则
            "password_hash",  # 不能外发的列
            "CASCADE",  # 级联删除
        ],
    )
    def test_doc_mentions_key_rules(self, keyword: str) -> None:
        """关键规则必须在图里出现 —— 它是排查清单，不是示意图。"""
        assert keyword in doc_text(), f"闭环图里没提到 `{keyword}`"

    def test_every_claim_points_at_a_test(self) -> None:
        """图上每条边都要指明由哪个测试保证。

        做法：文档最后一节列了测试名，逐个确认它们**真的存在** ——
        在 `test_admin.py` 或本文件里（本文件自己也保证了一部分边：
        接口清单、鉴权是否漏挂）。
        """
        doc = doc_text()
        here = Path(__file__).resolve().parent
        sources = "\n".join(
            (here / name).read_text(encoding="utf-8") for name in ("test_admin.py", "test_admin_loop_doc.py")
        )

        # 文档里以 `Test...` / `::test_...` / `test_...` 形式提到的用例
        mentioned = set(re.findall(r"\b(Test[A-Z]\w+|test_[a-z_]+)\b", doc))
        assert mentioned, "文档里没有提到任何用例名 —— 那这张图就没有可核对的依据"

        missing = sorted(name for name in mentioned if name not in sources)
        assert not missing, f"文档提到的用例在测试里不存在：{missing}"
