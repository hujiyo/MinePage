"""管理后台接口（5 条）。

契约对照 **`docs/rewrite/rewrite-contract.md`**：

| 方法 | 路径 | 关键点 |
|---|---|---|
| GET | `/api/admin/users` | 全部用户，**新的在前**，最多 200；`total` 是全库总数 |
| POST | `/api/admin/users/:id/status` | 封禁 / 解封；**不能封自己**（400） |
| GET | `/api/admin/sites` | **含已下线**的站点；键名**蛇形** |
| POST | `/api/admin/sites/:id/status` | 上线 / 下线 |
| DELETE | `/api/admin/sites/:id` | 管理员删任意页面；**按 id 不按名字** |

**全部要管理员**（`require_admin`）—— 非管理员 403，未登录 401。

这套接口补上之前，`admin.html` 打开是"一句错误提示 + 两张空表"，
而且**没有任何接口能调用 `set_status`** —— 管理员实际上无管理能力可用。

## 两个"归一化"提醒

用户状态**只认 `banned`**、站点状态**只认 `offline`**，其它值一律变成正常。
传 `"xxx"` 不会 400，而是**静默解封**。详见 `services/admin_service.py`。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.deps import get_admin_service, require_admin
from app.core.routing import CommitBeforeResponseRoute
from app.schemas.admin import (
    AdminDeleteOut,
    AdminSiteItem,
    AdminSitesOut,
    AdminSiteStatusOut,
    AdminUsersOut,
    AdminUserStatusOut,
    SetSiteStatusIn,
    SetUserStatusIn,
)
from app.schemas.user import CurrentUser
from app.services.admin_service import AdminService

router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["admin"])


# ---------------------------------------------------------------- 用户


@router.get("/api/admin/users", response_model=AdminUsersOut)
def admin_users(
    _: CurrentUser = Depends(require_admin),
    service: AdminService = Depends(get_admin_service),
) -> AdminUsersOut:
    """全部用户，**新的在前**，最多 200 条。

    `total` 是**全库用户数**，不是 `users` 的长度。
    响应**不含 `password_hash`**（过 `UserOut`）。
    """
    total, users = service.list_users()
    return AdminUsersOut(total=total, users=users)


@router.post("/api/admin/users/{user_id}/status", response_model=AdminUserStatusOut)
def admin_user_status(
    user_id: int,
    payload: SetUserStatusIn,
    admin: CurrentUser = Depends(require_admin),
    service: AdminService = Depends(get_admin_service),
) -> AdminUserStatusOut:
    """封禁 / 解封一个用户。

    `status` 传 `banned` 封禁，**其它任何值**都解封（原版行为，不是校验）。
    封禁**立即生效** —— 会话不吊销，但每个请求都现查 `status`，所以下个请求就掉线。

    **不能封自己**：封了当场把自己踢出后台，而且没人能解封（需要管理员权限）。
    """
    target_id, status = service.set_user_status(admin_id=admin.id, target_id=user_id, status=payload.status)
    return AdminUserStatusOut(id=target_id, status=status)


# ---------------------------------------------------------------- 页面


@router.get("/api/admin/sites", response_model=AdminSitesOut)
def admin_sites(
    _: CurrentUser = Depends(require_admin),
    service: AdminService = Depends(get_admin_service),
) -> AdminSitesOut:
    """全部站点，**含已下线**，最近更新的在前，最多 200 条。

    和发现流的区别：发现流只回上线站点，这里回全部 ——
    否则管理员没法把已下线的页面恢复回来。

    列表项的键**是蛇形**（`created_at` / `owner_email` / `owner_username`），
    与上面的用户列表（驼峰）不同，前端按各自风格读。
    """
    total, sites = service.list_sites()
    return AdminSitesOut(total=total, sites=[AdminSiteItem(**s) for s in sites])


@router.post("/api/admin/sites/{site_id}/status", response_model=AdminSiteStatusOut)
def admin_site_status(
    site_id: int,
    payload: SetSiteStatusIn,
    _: CurrentUser = Depends(require_admin),
    service: AdminService = Depends(get_admin_service),
) -> AdminSiteStatusOut:
    """上线 / 下线一个站点。

    `status` 传 `offline` 下线，**其它任何值**都上线（原版行为）。

    下线之后：访问 `/:站名` → **451**，点赞 / 收藏 / 评论 → 451。
    但**看统计和评论列表不受影响**（原版刻意保留的例外）。
    """
    target_id, status = service.set_site_status(site_id=site_id, status=payload.status)
    return AdminSiteStatusOut(id=target_id, status=status)


@router.delete("/api/admin/sites/{site_id}", response_model=AdminDeleteOut)
def admin_delete_site(
    site_id: int,
    _: CurrentUser = Depends(require_admin),
    service: AdminService = Depends(get_admin_service),
) -> AdminDeleteOut:
    """删除任意站点（**不看归属**）。

    **按主键 id，不是站名** —— 属主那条 `DELETE /api/sites/:名字` 是按名字的。
    站点下的文件由外键级联清掉。

    页面不存在回 **404**（不是幂等 200）—— 这样前端能区分"删掉了"和"本来就没有"。
    """
    deleted = service.delete_site(site_id=site_id)
    return AdminDeleteOut(id=deleted)
