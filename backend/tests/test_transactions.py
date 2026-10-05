"""守门测试：**提交必须发生在响应发出之前**。

## ⚠️ 这个 bug 用 `TestClient` 测不出来（重要）

`TestClient` 是**完全同步顺序**的：一个请求（含依赖 teardown）跑完才返回，
下一个请求才开始。而竞态恰恰是"响应发出"与"提交落库"之间的窗口 ——
在 `TestClient` 里这个窗口被压成了零，所以**无论有没有这个 bug，单元测试都会通过**。

这不是推测，是实测：

* 带 bug 的版本：`TestClient` 里同样的用例**全过**（`test_admin.py` 39 项）
* 同一个版本，真实浏览器背靠背发两个 `fetch`：**稳定复现读到旧值**

所以这里的守门方式只有两条，都很务实：

1. **静态检查**：每个 `APIRouter` 都带了 `CommitBeforeResponseRoute` ——
   漏掉的表现是"那个模块的写接口又变回竞态"，而且不会有任何报错
2. **真实服务检查**：`tools/verify_upload_chain.py` 里的"写后立刻读"那条 ——
   它打真实 uvicorn，能稳定复现

## 事故记录（供以后翻）

```
探针：yield 依赖的 teardown 里 sleep(0.5)，客户端收到响应用了 0.039 秒
      -> teardown 跑在响应之后，commit 也就落在响应之后

真实浏览器现象：
  点「封禁」-> 提示成功 -> 该用户立刻还能登录
  点「下线」-> 提示成功 -> 该站点立刻还能访问
  点「封禁」-> 管理页看不到「已封禁」徽章（因为紧接着的登录成功了并覆盖了管理员 Cookie）
```
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.routing import CommitBeforeResponseRoute, commit_session

API_DIR = Path(__file__).resolve().parent.parent / "app" / "api"


def router_files() -> list[Path]:
    """所有建了 `APIRouter` 的路由文件。"""
    out = []
    for f in sorted(API_DIR.glob("*.py")):
        if "APIRouter(" in f.read_text(encoding="utf-8"):
            out.append(f)
    return out


class TestEveryRouterCommits:
    """**这条是防回退的主力。**"""

    def test_all_router_files_use_commit_route(self) -> None:
        """每个 `APIRouter(...)` 都要带 `route_class=CommitBeforeResponseRoute`。

        漏掉一个的后果是"那个模块的写操作又变成先响应后提交" ——
        接口照常回 200，没有任何报错，只有背靠背请求才会露馅。
        """
        missing = []
        for f in router_files():
            src = f.read_text(encoding="utf-8")
            for line in src.splitlines():
                if "APIRouter(" in line and "route_class=CommitBeforeResponseRoute" not in line:
                    missing.append(f"{f.name}: {line.strip()}")

        assert not missing, "这些 APIRouter 没带 route_class=CommitBeforeResponseRoute：\n  " + "\n  ".join(
            missing
        )

    def test_the_import_is_present(self) -> None:
        """带了 `route_class` 就必然要 import 它 —— 顺手确认没有靠通配符导入。"""
        for f in router_files():
            src = f.read_text(encoding="utf-8")
            if "CommitBeforeResponseRoute" not in src:
                continue
            assert re.search(
                r"^from app\.core\.routing import CommitBeforeResponseRoute$", src, re.MULTILINE
            ), f"{f.name} 用了 CommitBeforeResponseRoute 但没有显式导入它"

    @pytest.mark.parametrize("name", ["admin.py", "auth.py", "sites.py", "social.py", "me.py"])
    def test_writing_modules_are_covered(self, name: str) -> None:
        """点名几个**有写操作**的模块 —— 这些是真会出问题的。"""
        src = (API_DIR / name).read_text(encoding="utf-8")
        assert "route_class=CommitBeforeResponseRoute" in src, f"{name} 有写操作，必须带 route_class"


class TestCommitSessionHelper:
    """`commit_session` 自身的边界。"""

    def test_no_session_is_a_noop(self) -> None:
        """没有会话（比如静态资源、健康检查）时什么都不做，不报错。"""

        class FakeState:
            pass

        class FakeRequest:
            state = FakeState()

        commit_session(FakeRequest())  # type: ignore[arg-type]  # 不该抛异常

    def test_closed_session_is_skipped(self) -> None:
        """已经关掉的会话不能再提交（会抛 `ResourceClosedError`）。"""

        class FakeSession:
            is_active = False
            in_transaction_called = False

            def in_transaction(self) -> bool:
                self.in_transaction_called = True
                return True

            def commit(self) -> None:
                raise AssertionError("不该提交已关闭的会话")

        class FakeState:
            db_session = FakeSession()

        class FakeRequest:
            state = FakeState()

        commit_session(FakeRequest())  # type: ignore[arg-type]

    def test_readonly_session_is_skipped(self) -> None:
        """没有未提交改动的会话不用提交 —— 免得每个 GET 都白开一次事务。"""

        class FakeSession:
            is_active = True

            def in_transaction(self) -> bool:
                return False

            def commit(self) -> None:
                raise AssertionError("只读会话不该提交")

        class FakeState:
            db_session = FakeSession()

        class FakeRequest:
            state = FakeState()

        commit_session(FakeRequest())  # type: ignore[arg-type]


class TestRouteClassIsWired:
    """路由类真的生效了吗 —— 直接看 app 里每个路由的类型。"""

    def test_routes_are_our_class(self) -> None:
        from app.core.config import Settings
        from app.main import create_app

        app = create_app(Settings(public_dir=str(Path(__file__).parent)))
        # 只看**我们自己写的**端点。
        #
        # 不能只按 `/api` 前缀过滤 —— FastAPI 自带的文档路由也挂在 `/api` 下
        # （`/api/openapi.json`、`/api/docs`），它们是普通的 `Route`，
        # 本来就不该、也不可能带我们的 route_class。
        # 按端点的模块名判断最准确：我们的一律在 `app.*` 里。
        routes = [
            r
            for r in _walk_routes(app)
            if getattr(r, "path", "").startswith("/api")
            and getattr(getattr(r, "endpoint", None), "__module__", "").startswith("app.")
        ]
        assert routes, "一个自己的 /api 路由都没找到，说明遍历方式过时了"

        wrong = [r for r in routes if not isinstance(r, CommitBeforeResponseRoute)]
        assert not wrong, "这些路由不是 CommitBeforeResponseRoute（提交会落在响应之后）：\n  " + "\n  ".join(
            f"{sorted(getattr(r, 'methods', []) or [])} {r.path}" for r in wrong
        )


def _walk_routes(app: object) -> list[object]:
    """把 app 里的路由摊平。

    FastAPI 会藏路由 —— 两个坑：

    1. **0.142 起**，`include_router` 的结果是一个 `_IncludedRouter` 包装对象
       （`app.routes` 里只有它一个，没有 `.path`），真正的路由在 `.original_router` 里。
       不认这一层的话会得出"一个路由都没有"的错误结论。
    2. `app.routes` 和 `app.router.routes` 可能是同一批对象的两个引用，
       所以要按 `id()` 去重，否则重复检查、报错信息也会翻倍。
    """
    found: list[object] = []
    seen: set[int] = set()

    def walk(node: object) -> None:
        if node is None or id(node) in seen:
            return
        seen.add(id(node))

        inner = getattr(node, "original_router", None)
        if inner is not None:
            walk(inner)

        routes = getattr(node, "routes", None)
        if routes is None:
            return
        for r in routes:
            if hasattr(r, "path") and hasattr(r, "methods"):
                found.append(r)
            else:
                walk(r)

    walk(app)
    walk(getattr(app, "router", None))
    return found
