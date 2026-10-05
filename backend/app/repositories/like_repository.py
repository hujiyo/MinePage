"""点赞的数据访问。

这个文件是**垂直切片的模板** —— 其它 Repository 照它的写法来。
"""

from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.models.base import utcnow_iso
from app.models.social import Like
from app.repositories.base import BaseRepository


class LikeRepository(BaseRepository[Like]):
    """`likes` 表。主键是 `(site_id, user_id)`，**没有 `id` 列**。"""

    model = Like

    def exists(self, site_id: int, user_id: int | None) -> bool:
        """这个用户赞过这个站点没有。

        `user_id` **可以是 `None`（未登录）**，那种情况直接 False —— 原版 `hasLiked` 就是这么做的，
        所以这里把"未登录"当成类型的一部分，而不是让调用方每次自己判空。
        """
        if not user_id:
            return False
        stmt = select(func.count()).select_from(Like).where(Like.site_id == site_id, Like.user_id == user_id)
        return bool(self._session.scalar(stmt))

    def add(self, site_id: int, user_id: int) -> bool:  # type: ignore[override]
        """点赞。**幂等** —— 已经赞过就什么都不做，返回 False。

        实现方式：靠主键冲突，而不是"先查再插"。原因是**先查再插在并发下会双写**
        （两个请求同时查到"没赞过"，然后都插入，第二个撞唯一约束报 500）。
        用 `begin_nested()` 开个保存点，让失败的 INSERT 只回滚它自己，
        不会把外层事务也弄脏 —— 这是 SQLAlchemy 里捕获 IntegrityError 后继续用同一个
        session 的正确姿势。
        """
        if self.exists(site_id, user_id):
            return False
        try:
            with self._session.begin_nested():
                self._session.add(Like(site_id=site_id, user_id=user_id, created_at=utcnow_iso()))
        except IntegrityError:
            # 并发下别人先插进去了 —— 结果相同，静默忽略
            return False
        return True

    def remove(self, site_id: int, user_id: int) -> int:
        """取消点赞，返回被删条数（0 表示本来就没赞过）。**没赞过也不报错。**"""
        result = self._session.execute(delete(Like).where(Like.site_id == site_id, Like.user_id == user_id))
        # SQLAlchemy 把 Session.execute 的返回类型标成 Result，但 DELETE 实际拿到的是
        # CursorResult（才有 rowcount）。这里按实际类型取，mypy 需要显式忽略。
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

    def count(self, site_id: int) -> int:  # type: ignore[override]
        """这个站点的点赞总数。"""
        stmt = select(func.count()).select_from(Like).where(Like.site_id == site_id)
        return int(self._session.scalar(stmt) or 0)

    def count_for_sites(self, site_ids: list[int]) -> dict[int, int]:
        """一次查出多个站点的点赞数，避免列表页 N+1 次查询。"""
        if not site_ids:
            return {}
        stmt = select(Like.site_id, func.count()).where(Like.site_id.in_(site_ids)).group_by(Like.site_id)
        return {int(site_id): int(n) for site_id, n in self._session.execute(stmt)}

    def liked_site_ids(self, user_id: int, site_ids: list[int]) -> set[int]:
        """这个用户在这批站点里赞过哪些 —— 卡片上"赞过没有"的高亮靠它。

        Args:
            user_id: 查询者。**为 0 或 `None`（未登录）时直接返回空集**，不查库。
            site_ids: 这一页的站点主键。**空列表也直接返回空集**（避免生成 `IN ()`）。
        """
        if not user_id or not site_ids:
            return set()
        stmt = select(Like.site_id).where(Like.user_id == user_id, Like.site_id.in_(site_ids))
        return {int(x) for x in self._session.scalars(stmt)}
