"""私信的数据访问。

**目前只实现了未读计数** —— 因为 `GET /api/me` 要返回导航条上的未读私信数，
不实现它红点就永远不亮。

会话列表、按对话取消息、发私信这些属于「私信」模块（`/api/messages*`，3 条），
按 `backend/README.md` 的接口进度表排在后面 —— 补的时候加在这个文件里。

对应原版 `lib/social.js` 里跟 `messages` 表有关的那几个函数。
"""

from __future__ import annotations

from sqlalchemy import func, select

from app.models.message import Message
from app.repositories.base import BaseRepository


class MessageRepository(BaseRepository[Message]):
    """`messages` 表。"""

    model = Message

    #: 未读数的上限。原版用 `Math.min(c, 99)` 封顶 ——
    #: 导航条上的红点显示"99+"就够了，没必要为上千条未读做查询。
    UNREAD_CAP = 99

    def count_unread(self, user_id: int) -> int:
        """未读私信数（**封顶** `UNREAD_CAP`）。

        Args:
            user_id: 收件人主键。
        """
        return min(self._count_unread(user_id), self.UNREAD_CAP)

    def count_unread_uncapped(self, user_id: int) -> int:
        """不封顶的未读数。

        单独留一个公开方法，是为了让测试能验证"封顶确实生效了" ——
        只测封顶后的结果，没法区分"真的封顶了"和"本来就不到 99"。
        """
        return self._count_unread(user_id)

    def _count_unread(self, user_id: int) -> int:
        """未读的原始条数：`read_at IS NULL` 的那些。"""
        stmt = (
            select(func.count())
            .select_from(Message)
            .where(Message.receiver_id == user_id, Message.read_at.is_(None))
        )
        return int(self._session.scalar(stmt) or 0)
