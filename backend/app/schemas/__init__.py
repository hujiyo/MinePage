"""DTO 层：出入参的形状。

原版把这些 JSON 在 handler 里手拼（`sendJson(res, 200, { ok: true, liked: true, likes: ... })`），
字段名靠人记。这里用 Pydantic 模型：

* **字段名写错在启动时就报错**（Pydantic 会在类定义时校验）
* 出参自动序列化，不用手写 `res.json()`
* 入参自动做类型与长度校验 —— 等价于 Java 的 `@Valid`，但一个注解都不用写

**字段名必须与 `docs/rewrite/rewrite-contract.md` 里记录的一致** —— 前端直接读这些键，
少一个就白屏。
"""

from app.schemas.common import ApiOk, ErrorOut
from app.schemas.social import LikeOut, SiteStatsOut
from app.schemas.user import CurrentUser

__all__ = ["ApiOk", "CurrentUser", "ErrorOut", "LikeOut", "SiteStatsOut"]
