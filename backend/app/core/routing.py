"""让写操作在**响应发出之前**提交。

## 为什么需要这个文件（一个真实事故）

原来会话的提交挂在 FastAPI 的 `yield` 依赖 teardown 上：

```python
def get_session() -> Iterator[Session]:
    with database.session() as session:   # ← commit() 在 yield 之后
        yield session
```

而 **FastAPI 对 `yield` 依赖的 teardown 是在响应发出之后才跑的**。
这不是猜的，是量出来的：

    探针：teardown 里 sleep(0.5)，客户端收到响应用了 **0.039 秒**
    → teardown（提交）跑在响应之后

### 后果

**响应已经告诉客户端"成功"，但数据还没落库。** 于是背靠背发的下一个请求会读到旧值：

| 真实浏览器里的现象 | 实际发生的事 |
|---|---|
| 点「封禁」→ 提示成功 → 该用户**立刻还能登录** | 登录请求读到还没提交的 `active` |
| 点「下线」→ 提示成功 → 该站点**立刻还能访问** | 访问请求读到还没提交的 `active` |
| 点「封禁」→ 管理页**看不到已封禁徽章** | 同上 |

而 `pytest` 用 `TestClient`，请求是**顺序且完全同步**的 ——
teardown 在下一个请求开始前就跑完了，所以**这个 bug 在单元测试里永远测不出来**。
它只在真实浏览器（`fetch` 背靠背发送）或并发下暴露。

### 更糟的一面

如果提交**失败**（磁盘满、唯一约束冲突……），响应 200 早就发出去了，
客户端以为成功 —— 而且**没有任何重试机会**。

## 修法

把提交提前到「**端点返回之后、响应组装之前**」—— 这个位置既有完整的写入结果，
又还在路由处理器内部，所以：

* 提交**先于**响应 ✓
* 提交失败会变成 500，客户端能知道 ✓
* 事务边界仍在 Service 层（业务逻辑没动）✓

## 怎么用

所有 `APIRouter` 都要带上 `route_class`：

```python
router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["sites"])
```

`tests/test_transactions.py` 会检查**每个路由文件都带了它** ——
漏掉的表现是"那个模块的写接口又变回竞态"，而且不会有任何报错。
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.routing import APIRoute


class CommitBeforeResponseRoute(APIRoute):
    """在端点返回之后、响应发出之前提交数据库会话。"""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        """包一层原始处理器，在它返回后提交。

        `super().get_route_handler()` 返回的函数会：解析依赖 → 跑端点 → 组装响应，
        然后**返回 Response 对象**（此时响应体还没发出去）。
        所以在这里提交，就落在"端点跑完"和"响应发出"之间。

        依赖 teardown 仍然会在响应之后跑，那里还有一次提交 ——
        第二次提交是空操作，留着当兜底（比如某个路径绕过了本类）。
        """
        original = super().get_route_handler()

        async def commit_then_respond(request: Request) -> Response:
            response = await original(request)
            commit_session(request)
            return response

        return commit_then_respond


def commit_session(request: Request) -> None:
    """提交挂在这次请求上的会话（没有就什么都不做）。

    抽成独立函数有两个好处：`get_route_handler` 里只有一行，读起来是"提交、返回"；
    而且能单独测（`tests/test_transactions.py` 直接造一个 request 调它，验证幂等）。

    会话由 `app/core/database.py` 的 `get_session` 挂到 `request.state.db_session`。
    """
    session: Any = getattr(request.state, "db_session", None)
    # `is_active` 挡掉已经关闭的会话；`in_transaction` 挡掉"没写过任何东西"的只读请求，
    # 免得每个 GET 都白开一次事务。
    if session is not None and session.is_active and session.in_transaction():
        session.commit()
