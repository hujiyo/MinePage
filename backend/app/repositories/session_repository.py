"""会话的数据访问。

会话 token **明文存库不做哈希** —— 与原版一致：它是短期且可随时删除的，
哈希它没有收益，反而让「按 token 查」变成全表扫。
"""

from __future__ import annotations

from sqlalchemy import select

from app.core.config import Limits
from app.models.base import iso_in_days, utcnow_iso
from app.models.user import User, UserSession
from app.repositories.base import BaseRepository


class SessionRepository(BaseRepository[UserSession]):
    """`sessions` 表。"""

    model = UserSession

    def create(self, user_id: int, token: str) -> UserSession:
        """开一条会话，有效期 `Limits.SESSION_TTL_DAYS` 天。"""
        session = UserSession(
            token=token,
            user_id=user_id,
            created_at=utcnow_iso(),
            expires_at=iso_in_days(Limits.SESSION_TTL_DAYS),
        )
        self.add(session)
        return session

    def find_user(self, token: str) -> User | None:
        """按 token 取用户，顺带判过期。

        过期判断用**字符串比较**（`expires_at > 现在`）—— 因为时间列是 ISO 8601 字符串，
        这个比较等价于时间比较。别改成日期类型，会改变语义。

        **调用方还要自己判 `status == 'active'`** —— 封禁不该在这个方法里处理，
        因为它也可以被"只是查一下这个会话属于谁"的场景调用。
        """
        if not token:
            return None
        stmt = (
            select(User)
            .join(UserSession, UserSession.user_id == User.id)
            .where(
                UserSession.token == token,
                UserSession.expires_at > utcnow_iso(),
            )
        )
        return self._session.scalars(stmt).first()

    def remove(self, token: str) -> int:
        """删一个会话（退出登录）。返回删掉的行数，0 表示本来就没有。"""
        session = self._session.get(UserSession, token)
        if session is None:
            return 0
        self._session.delete(session)
        return 1

    def remove_others(self, user_id: int, keep_token: str | None = None) -> int:
        """踢掉某个用户的其他会话。

        * 找回密码后**不带** `keep_token` —— 全部失效，因为密码可能已泄露
        * 用户自己在设置页改密码时**传当前 token** —— 免得把自己也踢下线

        Args:
            user_id: 要清理的用户主键。
            keep_token: 保留哪一个会话。**不传就是全踢**（包含调用者自己那一条）。
        """
        stmt = select(UserSession).where(UserSession.user_id == user_id)
        if keep_token:
            stmt = stmt.where(UserSession.token != keep_token)
        rows = list(self._session.scalars(stmt))
        for row in rows:
            self._session.delete(row)
        return len(rows)

    def remove_expired(self) -> int:
        """清掉已过期的会话行。

        **只在进程启动时调一次**（见 `app/main.py`）—— 过期行不会自动消失，所以库里会攒。
        这条列在 `tests/new-findings.md` 的 B7。
        """
        stmt = select(UserSession).where(UserSession.expires_at <= utcnow_iso())
        rows = list(self._session.scalars(stmt))
        for row in rows:
            self._session.delete(row)
        return len(rows)
