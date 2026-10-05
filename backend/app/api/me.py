"""当前用户与账号自助设置（4 条）。

| 方法 | 路径 | 鉴权 | 请求字段 | 响应 |
|---|---|---|---|---|
| GET | `/api/me` | 公开（读登录态） | — | `{ok, user, unread, unreadMessages}` |
| POST | `/api/account/username` | 登录 | `username` | `{ok, username}` |
| POST | `/api/account/password` | 登录 | `currentPassword` `newPassword` | `{ok}` |
| POST | `/api/account/bio` | 登录 | `bio` | `{ok, bio}` |

`/api/me` 是**公开但读登录态**的典型：未登录不报 401，而是 `user: null` + 两个未读数为 0。
导航条靠它一次请求拿全，所以它必须永远可用 —— 一旦它 401，整站的顶栏都会空白。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.deps import get_optional_user, get_user_service, require_user
from app.core.routing import CommitBeforeResponseRoute
from app.schemas.common import ApiOk
from app.schemas.me import AccountPasswordIn, BioIn, BioOut, MeOut, UsernameIn, UsernameOut
from app.schemas.user import CurrentUser
from app.services.user_service import UserService

router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["me"])


@router.get("/api/me", response_model=MeOut)
def me(
    user: CurrentUser | None = Depends(get_optional_user),
    service: UserService = Depends(get_user_service),
) -> MeOut:
    """导航条要的全部信息。

    契约：`{ok, user, unread, unreadMessages}`。

    * `unread` = 未读**通知**数（谁赞/评/藏/关注了我）
    * `unreadMessages` = 未读**私信**数（封顶 99）

    **这两个别接反** —— 原版前端就因为语义反了，红点点错地方。
    """
    return service.me(user.id if user else None)


@router.post("/api/account/username", response_model=UsernameOut)
def set_username(
    payload: UsernameIn,
    user: CurrentUser = Depends(require_user),
    service: UserService = Depends(get_user_service),
) -> UsernameOut:
    """改用户名。**传空即清空**（`username` 会返回 `null`）。

    返回的是**真正写进库的规范值**（trim + 转小写），前端要用它回填输入框。
    """
    value = service.set_username(user.id, payload.username)
    return UsernameOut(username=value)


@router.post("/api/account/password", response_model=ApiOk)
def change_password_direct(
    payload: AccountPasswordIn,
    user: CurrentUser = Depends(require_user),
    service: UserService = Depends(get_user_service),
) -> ApiOk:
    """凭「当前密码」直接改密码。

    与 `POST /api/auth/password` 的区别（**原版注释里明确写的，别统一**）：

    * 这里**不校验邮箱验证码**
    * 这里**不踢其他设备的会话**
    """
    service.change_password_direct(
        user.id,
        payload.currentPassword,
        payload.newPassword,
    )
    return ApiOk()


@router.post("/api/account/bio", response_model=BioOut)
def set_bio(
    payload: BioIn,
    user: CurrentUser = Depends(require_user),
    service: UserService = Depends(get_user_service),
) -> BioOut:
    """保存个人简介。返回 trim 后的最终值，前端拿它回填。"""
    return BioOut(bio=service.set_bio(user.id, payload.bio))
