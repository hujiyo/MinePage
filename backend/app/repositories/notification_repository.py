"""通知的查询。

**通知没有自己的表** —— 它是 `likes` / `comments` / `favorites` / `follows`
四张表现算的 UNION。对应原版 `lib/social.js` 的 `NOTIFICATIONS_SQL`。

为什么这么设计（以及它的代价）：不用维护"事件表"，所以**取消点赞、删评论之后
对应的通知会立刻消失**，没有历史事件可追溯。这是原版的取舍，保留。

## 与原版的差别：不用 `instr` / `substr`

原版在 SQL 里算展示名：

```sql
COALESCE(u.username, substr(u.email, 1, instr(u.email, '@') - 1))
```

`instr` 是 SQLite 特有的（PostgreSQL 用 `strpos` 或 `position`）。
这里把这步挪到 Python 里，SQL 只用两库通用的部分 —— 换 PostgreSQL 时不用改。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Select, func, select, union_all

from app.models.site import Site
from app.models.social import Comment, Favorite, Follow, Like
from app.models.user import User
from app.repositories.base import BaseRepository


class NotificationRepository(BaseRepository[User]):
    """这里没有"自己的表"，`model` 只是为了满足基类的泛型约束。"""

    model = User

    @staticmethod
    def _event_selects(user_id: int) -> list[Select[Any]]:
        """四类互动事件各自的 SELECT，每行两个字段：`kind` 与 `at`。

        每类都排除"自己操作自己"（`user_id != ?`）—— 否则自己赞自己的站会给自己发通知。
        关注那条排除的是自己关注自己，原版只在接口层拦，这里保持一致。
        """
        like = (
            select(Like.created_at.label("at"))
            .join(Site, Site.id == Like.site_id)
            .where(Site.owner_id == user_id, Like.user_id != user_id)
        )
        comment = (
            select(Comment.created_at.label("at"))
            .join(Site, Site.id == Comment.site_id)
            .where(Site.owner_id == user_id, Comment.user_id != user_id)
        )
        favorite = (
            select(Favorite.created_at.label("at"))
            .join(Site, Site.id == Favorite.site_id)
            .where(Site.owner_id == user_id, Favorite.user_id != user_id)
        )
        follow = select(Follow.created_at.label("at")).where(Follow.followee_id == user_id)
        return [like, comment, favorite, follow]

    def count_unread(self, user_id: int, seen_at: str) -> int:
        """未读通知数 = 四类互动里时间**晚于 `notify_seen_at`** 的条数。

        Args:
            user_id: 站点归属者 / 被关注者的主键。
            seen_at: `users.notify_seen_at` 的值。**空串表示从没看过**，
                于是所有事件都算未读（与原版一致 —— 它在 SQL 里也是拿空串比大小）。
        """
        events = union_all(*self._event_selects(user_id)).subquery()
        stmt = select(func.count()).select_from(events).where(events.c.at > seen_at)
        return int(self._session.scalar(stmt) or 0)

    def find_unread(self, user_id: int, seen_at: str) -> list[str]:
        """未读通知的时间戳列表（给测试与调试用，按时间倒序）。"""
        events = union_all(*self._event_selects(user_id)).subquery()
        stmt = select(events.c.at).where(events.c.at > seen_at).order_by(events.c.at.desc())
        return [str(x) for x in self._session.scalars(stmt)]

    def seen_at_of(self, user: User) -> str:
        """取某个用户的"通知已读时间"。

        **没看过时返回空串而不是 `None`** —— 因为比较是字符串序，
        空串比任何 ISO 时间戳都小，于是"所有事件都算未读"。
        返回 `None` 会让比较变成 NULL，`WHERE at > NULL` 恒为假，未读数永远是 0。
        """
        return user.notify_seen_at or ""
