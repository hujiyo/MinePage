"""收藏的数据访问。

**目前只实现了计数与存在性判断** —— 因为 `GET /api/sites/:名字/stats` 要返回
"这个站点被收藏了几次""我收藏过没有"。

其余的（收藏列表、加收藏、取消收藏、收藏夹）属于「互动」模块
（`/api/favorites`、`POST/DELETE /api/sites/:名字/favorite`），
按 `backend/README.md` 的进度表排在后面 —— 补的时候加在这个文件里。

对应原版 `lib/social.js` 里跟 `favorites` 表有关的那几个函数。
"""

from __future__ import annotations

from sqlalchemy import func, select

from app.models.social import Favorite
from app.repositories.base import BaseRepository


class FavoriteRepository(BaseRepository[Favorite]):
    """`favorites` 表。主键是 `(site_id, user_id)`，**没有 `id` 列**。"""

    model = Favorite

    def count(self, site_id: int) -> int:  # type: ignore[override]
        """这个站点被收藏了几次。

        Args:
            site_id: 站点主键。
        """
        stmt = select(func.count()).select_from(Favorite).where(Favorite.site_id == site_id)
        return int(self._session.scalar(stmt) or 0)

    def exists(self, site_id: int, user_id: int | None) -> bool:
        """这个用户收藏过这个站点没有。

        Args:
            site_id: 站点主键。
            user_id: 查询者。**可以为 `None`（未登录）** —— 那时恒返回 `False`，
                与原版的 `hasFavorited(siteId, viewerId)` 一致。
        """
        if not user_id:
            return False
        stmt = (
            select(func.count())
            .select_from(Favorite)
            .where(Favorite.site_id == site_id, Favorite.user_id == user_id)
        )
        return bool(self._session.scalar(stmt))
