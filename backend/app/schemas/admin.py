"""管理后台的 DTO。

## ⚠️ 两个列表的命名风格**不同**，这是故意的

| 列表 | 风格 | `admin.html` 怎么读 |
|---|---|---|
| `GET /api/admin/users` | **驼峰**（`isAdmin` `createdAt`） | `user.isAdmin`、`user.createdAt` |
| `GET /api/admin/sites` | **蛇形**（`created_at` `owner_email`） | `site.owner_username`、`site.size` |

用户列表走的是 `publicUser()` 那份驼峰形状（同一个 `UserOut`），
页面列表走的是 `listAllSites()` 那份蛇形形状。**原版就是这样**，
前端各按各的风格读 —— **统一任何一边都会让另一边静默显示空白**。

（这和 `schemas/site.py` 里 `updated_at` 的情况是同一类陷阱，见那个文件开头的说明。）
"""

from __future__ import annotations

from pydantic import BaseModel

from app.schemas.common import ApiOk
from app.schemas.user import UserOut


class AdminUsersOut(ApiOk):
    """`GET /api/admin/users`。

    `total` 是**全库用户数**，不是 `users` 的长度 —— `users` 最多 200 条。
    """

    total: int = 0
    users: list[UserOut] = []


class SetUserStatusIn(BaseModel):
    """`POST /api/admin/users/:id/status` 的入参。

    字段可选、校验在 Service 里做，理由同其它入参模型（要保住 `{ok, message}` 形状）。
    """

    status: str | None = None


class SetSiteStatusIn(BaseModel):
    """`POST /api/admin/sites/:id/status` 的入参。"""

    status: str | None = None


class AdminUserStatusOut(ApiOk):
    """封禁 / 解封的结果。`status` 是**归一化之后**的值（`banned` 或 `active`）。"""

    id: int
    status: str


class AdminSiteItem(BaseModel):
    """页面列表里的一项。**键名是蛇形，故意的** —— 见模块开头的说明。

    `owner_*` 三列在**无主站点**（作者被删）时都是 `None`，
    `admin.html` 会显示「（无归属）」。
    """

    id: int
    name: str
    size: int
    status: str
    created_at: str
    updated_at: str
    owner_id: int | None = None
    owner_email: str | None = None
    owner_username: str | None = None


class AdminSitesOut(ApiOk):
    """`GET /api/admin/sites` —— **含已下线的站点**（和发现流不同）。

    `total` 是**全库站点数**，不是 `sites` 的长度。
    """

    total: int = 0
    sites: list[AdminSiteItem] = []


class AdminSiteStatusOut(ApiOk):
    """上线 / 下线的结果。`status` 是归一化之后的值（`offline` 或 `active`）。"""

    id: int
    status: str


class AdminDeleteOut(ApiOk):
    """删除站点 / 用户的结果，只回被删的主键。"""

    id: int
