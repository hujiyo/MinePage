"""用户、会话、邮箱验证码。

对应原版的 `users` / `sessions` / `email_codes` 三张表。

关于大小写不敏感的唯一性（原版是 `COLLATE NOCASE`）：
**PostgreSQL 没有 `COLLATE NOCASE`**，所以这里改成「写入与查询前统一转小写」，
配合普通 `UNIQUE`。这样两个数据库行为一致，而且不依赖 `citext` 扩展。
—— 见 `UserRepository.find_by_email()` / `create()`。
"""

from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class User(Base):
    """账号。一行一个邮箱，`id` 是自增主键。

    * `email` 唯一，是注册与登录的主标识（存小写）
    * `username` 唯一但**可空** —— 多个 NULL 不算冲突，所以「没设用户名」的用户可以有很多
    * `password_hash` 存 `scrypt$<salt>$<hash>`，是**唯一不能外发的列**，
      所有出参都必须过 `UserService.to_public()`
    * `status`：`active` 可用 / `banned` 封禁。**封禁不吊销会话** ——
      登录态在每个请求里按 `status` 现查，所以封禁立即生效
    * `notify_seen_at`：通知已读时间戳，推进它等于「都把通知标为已读」
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    username: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    bio: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    # 原版这一列不在建表语句里，由 migrate() 补 —— 这里直接建进去
    notify_seen_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    def __repr__(self) -> str:
        """调试用表示。**刻意不含 `password_hash`** —— 别让哈希出现在日志里。"""
        return f"<User id={self.id} email={self.email!r} username={self.username!r}>"


class UserSession(Base):
    """登录会话。

    类名不叫 `Session`，是为了不和 `sqlalchemy.orm.Session` 撞名 —— 表名仍是 `sessions`。

    * `token` 是主键，就是 `mp_session` Cookie 里那串 64 字符 hex，**明文存库不做哈希**
    * 删用户会连带删掉他的全部会话（`ON DELETE CASCADE`）
    * `expires_at` 是 ISO 字符串，过期判断靠字符串比较；**过期行不会自动消失**，
      只在进程启动时清一次（`SessionRepository.delete_expired()`）
    """

    __tablename__ = "sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        Index("idx_sessions_user", "user_id"),
        Index("idx_sessions_expiry", "expires_at"),
    )


class EmailCode(Base):
    """邮箱验证码。

    * **没有外键** —— 按邮箱字符串记录，所以给尚未注册的邮箱发码（注册场景）也成立
    * `purpose`：`register` / `change` / `reset`，同一邮箱的不同用途互不干扰
    * `code_hash` 存 `sha256(email:code)`，明文只出现在邮件正文里
    * `attempts` 记校验失败次数，到 `Limits.CODE_MAX_ATTEMPTS` 后该行作废
    * `consumed_at` 为空表示还没用过；`expires_at` 过后直接查不到
    """

    __tablename__ = "email_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[str] = mapped_column(String(32), nullable=False)
    consumed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    __table_args__ = (Index("idx_codes_email", "email", "purpose"),)
