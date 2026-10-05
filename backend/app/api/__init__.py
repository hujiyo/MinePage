"""接口层（表现层 / Controller）。

**这一层只做四件事**：解析 HTTP 入参、调 Service、把结果转成 DTO、交给框架序列化。
业务规则、数据库、异常状态码都不在这里。

由 import-linter 强制：**`app/api` 不许 import `app.repositories` 或 `app.models`**。
也就是说，Controller 里出现 `.query(` 或 `select(` 就已经错了。
"""

from app.api.router import api_router

__all__ = ["api_router"]
