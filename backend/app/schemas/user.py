"""用户的 DTO。

## `CurrentUser` —— Controller 眼里的"当前登录者"

Controller 拿当前用户时，如果直接用 ORM 实体 `User`，会有两个问题：

1. **越层** —— `app/api` 就不该 import `app/models`（分层约束会拦，而且这是对的：
   实体会话绑定在 Repository 的 Session 上，Controller 拿着它容易不小心触发懒加载查询）
2. **实体上带着 `password_hash`** —— 一个"只是想知道当前用户是谁"的路由，
   手里握着一个含密码哈希的对象，早晚有人手滑把它序列化出去

## `UserOut` —— 对外的用户对象

**字段与顺序必须和原版 `lib/users.js` 的 `publicUser()` 一致**：

```js
{ id, email, username, isAdmin, status, bio, createdAt }
```

注意是 **`isAdmin` 驼峰**、`createdAt` 不是 `created_at` —— 前端直接读这些键。
这是"契约"里最容易写错的地方（数据库列名是蛇形，对外是驼峰，中间必须有这层转换）。
"""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel


class UserLike(Protocol):
    """`UserOut.of()` 需要的**结构**描述。

    为什么用 `Protocol` 而不是 import `app.models.User`：

    1. **分层** —— `app/schemas` 不该依赖 ORM 实体
    2. **mypy 仍然能查** —— 它是结构类型，`User` 只要字段对得上就自动满足，
       而字段名写错（比如 `is_admin` 写成 `isAdmin`）会在**调用处**报错
    3. 不用 `getattr(user, "id")` 这种绕弯写法 —— 那样 ruff 的 `B009` 会（正确地）抱怨

    这比"传 `object` 再 getattr"强：那种写法丢掉了全部类型检查。
    """

    id: int
    email: str
    username: str | None
    is_admin: bool
    status: str
    bio: str
    created_at: str


class CurrentUser(BaseModel):
    """当前登录用户。Controller 里**只该看到这个**。

    需要更多字段时，说明那段逻辑该放进 Service 层，由 Service 自己拿实体去查。
    """

    id: int
    username: str | None = None
    email: str
    is_admin: bool = False
    status: str = "active"

    @property
    def display_name(self) -> str:
        """展示名：用户名 → 邮箱前缀。"""
        return self.username or self.email.split("@", 1)[0]


class UserOut(BaseModel):
    """对外的用户对象（对应原版 `publicUser()`）。

    **永远不含 `password_hash`** —— 这是这个类存在的首要理由。
    """

    id: int
    email: str
    username: str | None = None
    isAdmin: bool  # noqa: N815 - 契约要求驼峰，前端读的就是这个键
    status: str
    bio: str = ""
    createdAt: str

    @classmethod
    def of(cls, user: UserLike) -> UserOut:
        """从 ORM 实体构造。**唯一允许把实体转成对外形状的地方之一。**

        参数类型是 `UserLike`（结构协议）而不是 `object` ——
        所以字段名写错会在**这里**被 mypy 抓到，而不是运行时 AttributeError。
        """
        return cls(
            id=user.id,
            email=user.email,
            username=user.username,
            isAdmin=bool(user.is_admin),
            status=user.status,
            bio=user.bio or "",
            createdAt=user.created_at,
        )
