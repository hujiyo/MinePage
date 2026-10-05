"""管理后台的业务逻辑（封禁用户 / 下线页面 / 删页面）。

对应原版 `server.js` 的 `handleAdminUsers` / `handleAdminUserStatus` /
`handleAdminSites` / `handleAdminSiteStatus` / `handleAdminDeleteSite`。

## 🔑 这个模块补上的是"管理侧"，不是"执行侧"

执行侧（**谁能干什么**）一直是完整的，而且**不依赖这里**：

* 被封禁的用户登录 → 403；已有会话**下一个请求**就失效
  （因为 `deps.get_current_user` 每个请求都现查 `status`）
* 已下线的站点访问 → 451；不能再被赞 / 收藏 / 评论
* 站点归属：属主**或管理员**可以改

这个模块补的是**管理动作本身** —— 在此之前，`UserRepository.set_status()` 和
`SiteRepository.set_status()` 都是**死代码**（写了但没有接口能调用），
所以一个管理员**没有任何办法**去封禁别人或下线别人的页面。

## ⚠️ 两个"归一化"，不是"校验"

两个状态接口都**只认一个词**，其它一切输入都当成正常值：

| 接口 | 认 | 其它一律变成 |
|---|---|---|
| 用户状态 | `banned` | `active` |
| 站点状态 | `offline` | `active` |

**所以传 `"xxx"` 不会报 400，而是把用户解封了。** 这是原版行为，照抄 ——
但它是个**危险的默认值**（打错字会静默解封）。前端只会传这两个词，
所以保持原样；如果将来要在别处调这个接口，务必注意。
"""

from __future__ import annotations

from typing import Any

from app.core.exceptions import NotFound, ValidationError
from app.repositories.site_repository import SiteRepository
from app.repositories.user_repository import UserRepository
from app.schemas.user import UserOut

#: 状态取值。**只有这两个**，见模块开头关于"归一化"的说明。
USER_BANNED = "banned"
USER_ACTIVE = "active"
SITE_OFFLINE = "offline"
SITE_ACTIVE = "active"

#: 两个列表一次最多回多少条。与原版 `listUsers()` / `listAllSites()` 的 `limit` 一致。
LIST_LIMIT = 200


class AdminService:
    """管理后台的三个能力：用户列表 / 封禁、页面列表 / 下线 / 删除。"""

    def __init__(self, users: UserRepository, sites: SiteRepository) -> None:
        """组装管理服务。

        Args:
            users: 用户仓储。
            sites: 站点仓储。
        """
        self._users = users
        self._sites = sites

    # ---------------------------------------------------------------- 用户

    def list_users(self) -> tuple[int, list[UserOut]]:
        """全部用户，**新的在前**，最多 200 条。

        Returns:
            `(全库用户数, 本页用户列表)` —— 注意第一个是**总数**，不是列表长度。

        **不含 `password_hash`** —— 过 `UserOut`，这是这个类的首要职责。
        """
        return self._users.count_all(), [UserOut.of(u) for u in self._users.list_desc(LIST_LIMIT)]

    def set_user_status(self, *, admin_id: int, target_id: int, status: str | None) -> tuple[int, str]:
        """封禁 / 解封一个用户。

        Args:
            admin_id: 操作者主键（用来拦住"封自己"）。
            target_id: 目标用户主键。
            status: `banned` 封禁，**其它一切值**都解封（见模块开头的说明）。

        Returns:
            `(目标主键, 归一化后的状态)`。

        Raises:
            ValidationError: 管理员想封自己（400「不能封禁自己」）。
            NotFound: 没有这个用户（404）。

        **为什么不能封自己**：封禁是立即生效的（每个请求现查 `status`），
        所以封自己等于**当场把自己踢出后台**，而且**没人能解封**（得有管理员权限）。
        原版就挡了这一条。
        """
        value = USER_BANNED if status == USER_BANNED else USER_ACTIVE

        if target_id == admin_id:
            raise ValidationError("不能封禁自己")

        user = self._users.find_by_id(target_id)
        if user is None:
            raise NotFound("没有这个用户")

        self._users.set_status(user, value)
        return target_id, value

    # ---------------------------------------------------------------- 页面

    def list_sites(self) -> tuple[int, list[dict[str, Any]]]:
        """全部站点（**含已下线**），最近更新的在前，最多 200 条。

        Returns:
            `(全库站点数, 本页站点列表)`。列表项的键**是蛇形**，见 `schemas/admin.py`。

        **和发现流的区别**：发现流只回 `status='active'` 的站点，
        这里回全部 —— 否则管理员没法把已下线的页面恢复回来。
        """
        return self._sites.count_all(), self._sites.list_all_admin(LIST_LIMIT)

    def set_site_status(self, *, site_id: int, status: str | None) -> tuple[int, str]:
        """上线 / 下线一个站点。

        Args:
            site_id: 站点主键。
            status: `offline` 下线，**其它一切值**都上线。

        Returns:
            `(站点主键, 归一化后的状态)`。

        Raises:
            NotFound: 没有这个页面（404）。

        **下线之后会发生什么**（执行侧，不在这个方法里）：
        访问 `/:站名` → 451；点赞 / 收藏 / 评论 → 451。
        但**看统计和评论列表不受影响**（原版刻意如此）。
        """
        value = SITE_OFFLINE if status == SITE_OFFLINE else SITE_ACTIVE

        site = self._sites.find_by_id(site_id)
        if site is None:
            raise NotFound("没有这个页面")

        self._sites.set_status(site, value)
        return site_id, value

    def delete_site(self, *, site_id: int) -> int:
        """删除任意站点（不看归属），返回被删的主键。

        Raises:
            NotFound: 没有这个页面（404）。

        站点下的文件由外键 `ON DELETE CASCADE` 连带清掉。

        **注意 `site_id` 是主键，不是站名** —— 和 `DELETE /api/sites/:名字`
        那条属主接口不一样，那条按名字、这条按 id。
        """
        site = self._sites.find_by_id(site_id)
        if site is None:
            raise NotFound("没有这个页面")

        self._sites.delete(site)
        return site_id
