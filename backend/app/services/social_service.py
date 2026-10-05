"""社区互动的业务规则。

这个文件是**垂直切片的模板**：一个 Service 类，构造函数注入它需要的 Repository，
方法里写业务规则，返回 DTO。

四个 Repository 都还没写的部分（收藏/关注/评论）照 `LikeService` 的样子补即可。
"""

from __future__ import annotations

from app.core.exceptions import NotFound, SiteOffline
from app.repositories.like_repository import LikeRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.social import LikeOut


class LikeService:
    """点赞与取消点赞。

    **依赖是构造注入的** —— 不 import 全局 db、不 new Repository。
    这样测试里可以塞一个指向临时库的 Repository，不用起 HTTP 服务。
    这也是 Java 里 `@Autowired` 想达到的效果，Python 里手动传反而更清楚。
    """

    def __init__(self, sites: SiteRepository, likes: LikeRepository) -> None:
        """组装点赞服务。

        Args:
            sites: 站点仓储 —— 用来判站点存在与是否上线。
            likes: 点赞仓储。
        """
        self._sites = sites
        self._likes = likes

    def like(self, *, site_name: str, user_id: int) -> LikeOut:
        """点赞。

        业务规则（与原版 `handleSiteLike` 一致，**别漏**）：

        1. 站点必须存在，否则 404
        2. 站点必须是 `active`，被管理员下线的站点**不能点赞**（451）
        3. 重复点赞必须幂等 —— 不报错，也不让计数涨

        Args:
            site_name: 站名，**大小写不敏感**（内部统一转小写后查）。
            user_id: 点赞者主键。**调用方必须保证已登录** —— 这里不判登录态。

        Returns:
            点赞后的状态与总数（`liked` 恒为 True）。

        Raises:
            NotFound: 没有这个站点。
            SiteOffline: 站点被管理员下线（451），暂停互动。
        """
        site = self._sites.find_by_name(site_name)
        if site is None:
            raise NotFound("没有这个站点")
        if not site.is_active:
            raise SiteOffline("站点已下线，暂停互动")

        self._likes.add(site.id, user_id)
        return LikeOut(liked=True, likes=self._likes.count(site.id))

    def unlike(self, *, site_name: str, user_id: int) -> LikeOut:
        """取消点赞。

        **刻意不校验站点状态** —— 与原版一致：站点被下线后，已经点过赞的人仍然
        应该能取消（否则那个赞就永远留在那里了）。只有"点赞"这条路才挡下线站点。
        这个不对称是原版注释里明确写的，保留它。

        Args:
            site_name: 站名，大小写不敏感。
            user_id: 取消者主键。调用方保证已登录。

        Returns:
            `liked` 恒为 False，`likes` 是取消后的总数。

        Raises:
            NotFound: 没有这个站点。
                （**刻意不抛 `SiteOffline`** —— 见上面那段，下线站点也允许取消。）
        """
        site = self._sites.find_by_name(site_name)
        if site is None:
            raise NotFound("没有这个站点")

        self._likes.remove(site.id, user_id)
        return LikeOut(liked=False, likes=self._likes.count(site.id))

    def is_liked(self, *, site_name: str, user_id: int | None) -> bool:
        """当前用户赞过没有。

        Args:
            site_name: 站名，大小写不敏感。
            user_id: 查询者主键。**可以是 `None`（未登录）** —— 那时恒返回 False，
                站点不存在时也返回 False（这个方法不抛异常，就是给渲染用的）。
        """
        if not user_id:
            return False
        site = self._sites.find_by_name(site_name)
        if site is None:
            return False
        return self._likes.exists(site.id, user_id)
