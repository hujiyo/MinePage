"""用户的数据访问。

**大小写不敏感的唯一性**是这一层最容易踩的坑：原版用 SQLite 的 `COLLATE NOCASE`，
而 **PostgreSQL 没有这个东西**。这里的做法是 **写入与查询前统一转小写**，
配合普通 `UNIQUE` —— 两个数据库行为一致，也不依赖 `citext` 扩展。

**所有对外的方法都要走 `to_public()` 过滤 `password_hash`** —— 原版把这条写成了
注释里的约定（"所有出参都要过 publicUser"），这里把它变成仓库层的一个显式方法。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select

from app.core.security import password_hasher
from app.models.base import utcnow_iso
from app.models.user import User
from app.repositories.base import BaseRepository


class UserRepository(BaseRepository[User]):
    """`users` 表。"""

    model = User

    # ---------------------------------------------------------------- 查询

    def find_by_id(self, user_id: int) -> User | None:
        """按主键查。"""
        return self._session.get(User, user_id)

    def find_by_email(self, email: str) -> User | None:
        """按邮箱查。**邮箱统一按小写比对**（原版 `COLLATE NOCASE` 的等价物）。"""
        stmt = select(User).where(User.email == email.strip().lower())
        return self._session.scalars(stmt).first()

    def find_by_username(self, username: str) -> User | None:
        """按用户名查，同样**统一按小写比对**。"""
        stmt = select(User).where(User.username == username.strip().lower())
        return self._session.scalars(stmt).first()

    def find_by_login(self, login: str) -> User | None:
        """登录标识可以是邮箱，也可以是用户名。先按邮箱找，找不到再按用户名找。"""
        value = login.strip()
        return self.find_by_email(value) or self.find_by_username(value)

    def list_all(self) -> list[User]:
        """全部用户，按注册顺序（旧的在前）。"""
        return list(self._session.scalars(select(User).order_by(User.id)))

    def list_desc(self, limit: int = 200) -> list[User]:
        """管理后台的用户列表：**新的在前**，最多 `limit` 条。

        与原版 `listUsers()`（`ORDER BY id DESC LIMIT 200`）一致 ——
        注意方向和 `list_all()` 相反（那个是升序）。
        """
        stmt = select(User).order_by(User.id.desc()).limit(limit)
        return list(self._session.scalars(stmt))

    def count_all(self) -> int:
        """用户总数（管理后台的 `total` —— 是**全库总数**，不是本页条数）。"""
        return int(self._session.scalar(select(func.count()).select_from(User)) or 0)

    def find_admin(self) -> User | None:
        """取一个管理员，用于判断要不要播种管理员账号。"""
        stmt = select(User).where(User.is_admin.is_(True)).limit(1)
        return self._session.scalars(stmt).first()

    # ---------------------------------------------------------------- 写入

    def create(
        self,
        *,
        email: str,
        password: str,
        is_admin: bool = False,
        username: str | None = None,
    ) -> User:
        """建用户。**邮箱与用户名都转小写存**，这是大小写不敏感唯一性的实现方式。

        Args:
            email: 邮箱，注册与登录的主标识。这里统一转小写。
            password: 明文口令。**这里不校验长度** —— 与原版 `createUser` 一致；
                长度校验在业务层的注册 / 改密流程（`Limits.PASSWORD_MIN`）。
                管理员种子账号的默认口令 `123` 就靠这条"不校验"才建得出来。
            is_admin: 是否管理员。
            username: 用户名。**可以是 `None`** —— 允许"没设用户名"的用户存在
                （库里多个 NULL 不算唯一冲突）。
        """
        user = User(
            email=email.strip().lower(),
            username=username.strip().lower() if username else None,
            password_hash=password_hasher.hash(password),
            is_admin=is_admin,
            status="active",
            bio="",
            created_at=utcnow_iso(),
        )
        self.add(user)
        self._session.flush()  # 拿到自增 id
        return user

    def set_username(self, user: User, username: str | None) -> None:
        """设用户名。传 None 表示清除。"""
        user.username = username.strip().lower() if username else None

    def set_bio(self, user: User, bio: str) -> None:
        """改个人简介。长度上限（`Limits.BIO_MAX`）由业务层校验。"""
        user.bio = bio

    def set_password(self, user: User, password: str) -> None:
        """改密码。**这里不校验长度**，与原版一致（长度在业务层的改密流程里卡）。"""
        user.password_hash = password_hasher.hash(password)

    def set_status(self, user: User, status: str) -> None:
        """封禁 / 解封。

        注意**封禁不吊销会话** —— 登录态在每个请求里按 `status` 现查，
        所以封禁立即生效（这是原版的设计，`app/core/deps.py` 依赖它）。
        """
        user.status = status

    def touch_notifications_seen(self, user: User) -> None:
        """推进通知已读时间戳。进通知页时调用。"""
        user.notify_seen_at = utcnow_iso()

    # ---------------------------------------------------------------- 出参过滤

    @staticmethod
    def to_public(user: User) -> dict[str, Any]:
        """去掉 `password_hash` 之后的样子。

        **任何要发给客户端或渲染到页面的用户对象都必须先过这里。**
        这是原版注释里的约定，这里变成一个显式方法 —— 约定靠人记，方法靠调用。
        """
        return {
            "id": user.id,
            "email": user.email,
            "username": user.username,
            "isAdmin": bool(user.is_admin),
            "status": user.status,
            "bio": user.bio,
            "createdAt": user.created_at,
        }

    @staticmethod
    def display_name(user: User) -> str:
        """展示名：用户名 → 邮箱前缀（真实用户没有独立的 name 字段）。"""
        if user.username:
            return user.username
        return user.email.split("@", 1)[0]
