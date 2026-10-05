"""评论的数据访问。

**目前只实现了计数** —— 因为 `GET /api/sites/:名字/stats` 要返回评论数。

列表、发布、删除属于「互动」模块（`/api/sites/:名字/comments` 三条），
按 `backend/README.md` 的进度表排在后面 —— 补的时候加在这个文件里。

对应原版 `lib/social.js` 里跟 `comments` 表有关的那几个函数。
"""

from __future__ import annotations

from sqlalchemy import func, select

from app.models.social import Comment
from app.repositories.base import BaseRepository


class CommentRepository(BaseRepository[Comment]):
    """`comments` 表。"""

    model = Comment

    def count(self, site_id: int) -> int:  # type: ignore[override]
        """这个站点有几条评论（**含回复**，不区分层级）。

        Args:
            site_id: 站点主键。
        """
        stmt = select(func.count()).select_from(Comment).where(Comment.site_id == site_id)
        return int(self._session.scalar(stmt) or 0)
