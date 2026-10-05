"""`/api/me` 与账号自助设置的 DTO。"""

from __future__ import annotations

from pydantic import BaseModel

from app.schemas.common import ApiOk
from app.schemas.user import UserOut

# ---------------------------------------------------------------- 入参
#
# 与 `schemas/auth.py` 同一个理由：入参字段全可选，**校验在 Service 里做**。
# 用 Pydantic 的必填 + 校验器会回 FastAPI 自己的 422 形状，
# 而前端读的是 `{ok, message}` —— 形状不对就是静默白屏。


class UsernameIn(BaseModel):
    """`POST /api/account/username` 的入参。

    `username` 为 `None` 或空白串表示**清空用户名**。
    """

    username: str | None = None


class AccountPasswordIn(BaseModel):
    """`POST /api/account/password` 的入参（不校验邮箱验证码的那条路）。"""

    currentPassword: str | None = None  # noqa: N815 - 契约要求驼峰
    newPassword: str | None = None  # noqa: N815 - 契约要求驼峰


class BioIn(BaseModel):
    """`POST /api/account/bio` 的入参。"""

    bio: str | None = None


# ---------------------------------------------------------------- 出参


class MeOut(BaseModel):
    """`GET /api/me` —— 导航条一次请求拿全。

    未登录**不报 401**，而是 `user: null`、两个未读数都是 0，
    前端据此决定显示"登录"入口还是头像。所以字段一个都不能少。

    契约：`{ok, user, unread, unreadMessages}`。
    `unread` 是未读**通知**数、`unreadMessages` 是未读**私信**数 —— 别接反，
    原版前端就因为这两个语义反了，导致红点串位。
    """

    ok: bool = True
    user: UserOut | None = None
    unread: int = 0
    unreadMessages: int = 0


class UsernameOut(ApiOk):
    """`POST /api/account/username` —— 返回**真正写进库的规范值**。

    用户可能传了大写或带空格，服务端会 trim + 转小写。前端要用返回的这个值回填输入框，
    而不是用自己输入的原值。

    `username` 为 `None` 表示已清空（原版传空即清空）。
    """

    username: str | None = None


class BioOut(ApiOk):
    """`POST /api/account/bio` —— 返回 trim 后的最终值，前端拿它回填。"""

    bio: str = ""
