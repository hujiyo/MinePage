"""邮箱验证码的数据访问。

对应原版的 `email_codes` 表（逻辑在 `lib/verification.js`）。

两个容易写错的地方，都在这里收着：

1. **只有哈希落库** —— `code_hash` 存 `sha256('邮箱:验证码')`，明文只出现在邮件正文里。
   把邮箱混进来当盐，所以同一串验证码在不同邮箱下哈希不同。
2. **取的是"最近一条未消费未过期"** —— 不是"最近一条"。顺序写反会导致
   过期的旧码挡住新码，表现为"刚发的验证码说不对"，而且很难查。
"""

from __future__ import annotations

from sqlalchemy import delete, func, select

from app.models.user import EmailCode
from app.repositories.base import BaseRepository


class VerificationRepository(BaseRepository[EmailCode]):
    """`email_codes` 表。"""

    model = EmailCode

    # ---------------------------------------------------------------- 查询

    def latest(self, email: str, purpose: str) -> EmailCode | None:
        """该邮箱 + 用途下**最新的一条**（无论是否消费/过期）。

        **只看 `created_at` 是为了算重发冷却** —— 冷却期内不该再发，
        所以要拿"最近一次发送"的时间，而不是"最近一条还能用的码"。
        """
        stmt = (
            select(EmailCode)
            .where(EmailCode.email == email, EmailCode.purpose == purpose)
            .order_by(EmailCode.id.desc())
            .limit(1)
        )
        return self._session.scalars(stmt).first()

    def find_usable(self, email: str, purpose: str, now_iso: str) -> EmailCode | None:
        """取最近一条**未消费且未过期**的码。

        Args:
            email: 邮箱（调用方已转小写）。
            purpose: `register` / `change` / `reset`。
            now_iso: 当前时间的 ISO 字符串 —— 过期判断靠字符串比较，与原版一致。
        """
        stmt = (
            select(EmailCode)
            .where(
                EmailCode.email == email,
                EmailCode.purpose == purpose,
                EmailCode.consumed_at.is_(None),
                EmailCode.expires_at > now_iso,
            )
            .order_by(EmailCode.id.desc())
            .limit(1)
        )
        return self._session.scalars(stmt).first()

    # ---------------------------------------------------------------- 写入

    def create(self, *, email: str, purpose: str, code_hash: str, expires_at: str, now_iso: str) -> EmailCode:
        """落一行验证码。**明文不在这里** —— 调用方传进来的已经是哈希。"""
        row = EmailCode(
            email=email,
            purpose=purpose,
            code_hash=code_hash,
            attempts=0,
            created_at=now_iso,
            expires_at=expires_at,
            consumed_at=None,
        )
        self.add(row)
        return row

    def bump_attempts(self, row: EmailCode) -> None:
        """失败次数 +1。

        **必须在比对哈希之前调**（与原版一致）—— 这样"失败次数"是包含本次的，
        到 `Limits.CODE_MAX_ATTEMPTS` 之后即使填对也拒绝。
        """
        row.attempts = (row.attempts or 0) + 1

    def mark_consumed(self, row: EmailCode, now_iso: str) -> None:
        """标记已用掉。同一行不能再被用第二次。"""
        row.consumed_at = now_iso

    def delete_older_than(self, cutoff_iso: str) -> int:
        """清掉指定时间之前的旧记录，防表无限涨。

        原版每次发码前都跑一次，阈值是 1 天 —— 验证码本身 10 分钟就过期，
        1 天是很宽松的界限，不会误删还有效的码。
        """
        result = self._session.execute(delete(EmailCode).where(EmailCode.created_at <= cutoff_iso))
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

    def count(self) -> int:  # type: ignore[override]
        """全表行数。测试与运维用。"""
        return int(self._session.scalar(select(func.count()).select_from(EmailCode)) or 0)
