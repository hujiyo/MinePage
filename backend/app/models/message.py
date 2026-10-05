"""私信与 MCP 密钥。

对应原版的 `messages` / `mcp_tokens` 两张表。
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Message(Base):
    """私信。按发送时间排，`read_at` 为空表示收件人还没看。

    会话列表按「每个对话取 id 最大的那条」实现 —— 所以同一个人的往来**只靠这张表推**，
    没有会话表。这意味着「删除会话」做不到，只能一条条删（原版也没有这个功能）。
    """

    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sender_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    receiver_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    read_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    __table_args__ = (
        Index("idx_messages_receiver", "receiver_id", "read_at"),
        Index("idx_messages_sender", "sender_id"),
    )


class McpToken(Base):
    """MCP 密钥。**只存 sha256，明文不落库**；吊销 = 删行。

    * `token_hash` 唯一，是密钥全串的 sha256；明文只在创建响应里出现一次，之后无法找回
    * `label` 是用户自己起的备注
    * `last_used_at` 可空，写入受 `Limits.MCP_LAST_USED_THROTTLE_MS` 节流
      （避免每次调用都写库）
    * 每账户上限 `Limits.MCP_TOKENS_PER_USER` 由业务层校验，**库里没有约束** ——
      所以「判上限 → 插入」不是原子的，并发下理论上能超一把（见 `tests/new-findings.md` N20）
    """

    __tablename__ = "mcp_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    last_used_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    __table_args__ = (Index("idx_mcp_tokens_user", "user_id"),)
