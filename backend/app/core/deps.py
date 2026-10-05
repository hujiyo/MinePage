r"""依赖装配（对应 Java 的 `@Autowired`）。

FastAPI 用 `Depends` 做依赖注入：**函数签名声明它需要什么，框架负责给**。
这里集中放"从 HTTP 请求推出对象"的那几个函数 —— 会话、当前用户、各 Service。

放一处的理由：这些都是**横切关注点**，散在 56 个路由里会重复 56 遍，
而且任何一处写错（比如忘了判 `status != 'active'`）就是一个安全漏洞。

## 三种"当前用户"要分清

| 依赖 | 返回 | 未登录时 | 什么时候用 |
|---|---|---|---|
| `get_session_token` | `str or None` | `None` | 要拿 token 本身（登出、改密后保留当前会话） |
| `get_optional_user` | `CurrentUser or None` | `None` | **公开但读登录态**的接口（`/api/me`、站点 stats） |
| `require_user` | `CurrentUser` | **抛 401** | 必须登录的接口 |

`get_current_user` 返回的是 **ORM 实体**，只给 `deps.py` 内部用 ——
Controller 一律走 DTO（`app/api` 不许 import `app/models`）。
"""

from __future__ import annotations

from fastapi import Cookie, Depends
from sqlalchemy.orm import Session

from app.core.config import Limits, settings
from app.core.database import get_session
from app.core.exceptions import Forbidden, Unauthorized
from app.interfaces.mail_sender import build_mail_sender
from app.models.user import User
from app.repositories.comment_repository import CommentRepository
from app.repositories.favorite_repository import FavoriteRepository
from app.repositories.like_repository import LikeRepository
from app.repositories.message_repository import MessageRepository
from app.repositories.notification_repository import NotificationRepository
from app.repositories.session_repository import SessionRepository
from app.repositories.site_file_repository import SiteFileRepository
from app.repositories.site_repository import SiteRepository
from app.repositories.user_repository import UserRepository
from app.repositories.verification_repository import VerificationRepository
from app.schemas.user import CurrentUser
from app.services.admin_service import AdminService
from app.services.auth_service import AuthService
from app.services.site_manage_service import SiteManageService
from app.services.site_service import SiteService
from app.services.social_service import LikeService
from app.services.user_service import UserService
from app.services.verification_service import VerificationService

# ---------------------------------------------------------------- 会话与当前用户


def get_session_token(
    token: str | None = Cookie(default=None, alias=Limits.SESSION_COOKIE),
) -> str | None:
    """当前请求携带的会话 token；没有 Cookie 时是 `None`。

    **单独抽出来是因为有两条路要它本身而不是"用户"**：

    * 登出 —— 只要把这条会话删掉，不关心它是谁
    * 改密后踢其他设备 —— 要保留**当前这一条**，所以得知道当前 token 是什么
    """
    return token


def get_current_user(
    session: Session = Depends(get_session),
    token: str | None = Depends(get_session_token),
) -> User | None:
    """从会话 Cookie 解出当前用户；未登录返回 `None`。

    **不抛异常** —— 因为有一批接口是"公开但读登录态"（`/api/me`、站点 stats、
    创作者主页）：未登录也要正常返回，只是少了"我赞过没有"这类字段。
    需要强制登录的地方用下面的 `require_user`。

    Args:
        session: 本次请求的数据库会话。
        token: `mp_session` Cookie 的值。**没有 Cookie 时是 `None`，这不是错误**。
    """
    if not token:
        return None
    user = SessionRepository(session).find_user(token)
    # 封禁账号在这里就被挡住 —— 原版也是"每个请求按 status 现查"，
    # 所以封禁立即生效，不需要去吊销会话。
    if user is None or user.status != "active":
        return None
    return user


def get_optional_user(user: User | None = Depends(get_current_user)) -> CurrentUser | None:
    """当前登录用户的 **DTO**；未登录返回 `None`。

    给"公开但读登录态"的接口用 —— 它们不需要 401，只需要知道"有没有人登录"。
    """
    if user is None:
        return None
    return _as_dto(user)


def require_user(user: User | None = Depends(get_current_user)) -> CurrentUser:
    """强制登录，返回**DTO**（不是 ORM 实体）。

    为什么返回 DTO：Controller 不该 import `app.models`（分层约束会拦），
    而且实体会话绑在 Repository 的 Session 上、还带着 `password_hash` ——
    一个"只想知道当前用户是谁"的路由没必要握着这些。

    Args:
        user: 由 `get_current_user` 注入。为 `None` 就表示未登录。

    Raises:
        Unauthorized: 未登录（401）。文案「请先登录」与原版一字不差 —— 回归测试断言过它。
    """
    if user is None:
        raise Unauthorized("请先登录")
    return _as_dto(user)


def require_admin(user: CurrentUser = Depends(require_user)) -> CurrentUser:
    """强制管理员。

    Args:
        user: 由 `require_user` 注入，**到这里一定已登录**。

    Raises:
        Forbidden: 已登录但不是管理员（403）。
    """
    if not user.is_admin:
        raise Forbidden("需要管理员权限")
    return user


def _as_dto(user: User) -> CurrentUser:
    """ORM 实体 → Controller 用的 DTO。**这是"实体不外泄"的那道闸。**"""
    return CurrentUser(
        id=user.id,
        username=user.username,
        email=user.email,
        is_admin=user.is_admin,
        status=user.status,
    )


# ---------------------------------------------------------------- Service 工厂
#
# 每个请求一套 Repository + Service。Repository 持有的是"本次请求的会话"，
# 所以不能做成全局单例 —— 那样会让所有请求共享一个事务，出问题很难查。


def get_like_service(session: Session = Depends(get_session)) -> LikeService:
    """装配 `LikeService`（点赞 / 取消点赞）。"""
    return LikeService(
        sites=SiteRepository(session),
        likes=LikeRepository(session),
    )


def get_verification_service(session: Session = Depends(get_session)) -> VerificationService:
    """装配 `VerificationService`（邮箱验证码）。

    注意**发信实现是按配置现挑的**（`build_mail_sender`）—— 没配 SMTP 就是
    `ConsoleMailSender`（打印到控制台），配了就是 `SmtpMailSender`。
    这个分支只在装配点出现一次，业务层拿到的永远是 `MailSender` 抽象。
    """
    return VerificationService(
        codes=VerificationRepository(session),
        mailer=build_mail_sender(settings),
    )


def get_auth_service(
    session: Session = Depends(get_session),
    verification: VerificationService = Depends(get_verification_service),
) -> AuthService:
    """装配 `AuthService`（注册 / 登录 / 登出 / 改密 / 找回）。

    它复用同一个请求里的 `VerificationService`（FastAPI 会缓存依赖实例），
    所以验证码的写入和其它改动**在同一个事务里**。
    """
    return AuthService(
        users=UserRepository(session),
        sessions=SessionRepository(session),
        verification=verification,
    )


def get_user_service(session: Session = Depends(get_session)) -> UserService:
    """装配 `UserService`（`/api/me` + 账号自助设置）。"""
    return UserService(
        users=UserRepository(session),
        notifications=NotificationRepository(session),
        messages=MessageRepository(session),
    )


def get_site_service(session: Session = Depends(get_session)) -> SiteService:
    """装配 `SiteService`（公开侧：`/:站名` 发什么 + 互动数字）。"""
    return SiteService(
        sites=SiteRepository(session),
        files=SiteFileRepository(session),
        users=UserRepository(session),
        likes=LikeRepository(session),
        comments=CommentRepository(session),
        favorites=FavoriteRepository(session),
    )


def get_admin_service(session: Session = Depends(get_session)) -> AdminService:
    """装配 `AdminService`（管理后台：用户列表 / 封禁、页面列表 / 下线 / 删除）。"""
    return AdminService(users=UserRepository(session), sites=SiteRepository(session))


def get_site_manage_service(session: Session = Depends(get_session)) -> SiteManageService:
    """装配 `SiteManageService`（属主侧：我的站点 / 建站 / 改内容 / 文件管理）。"""
    return SiteManageService(
        sites=SiteRepository(session),
        files=SiteFileRepository(session),
    )


__all__ = [
    "get_admin_service",
    "get_auth_service",
    "get_current_user",
    "get_like_service",
    "get_optional_user",
    "get_session_token",
    "get_site_manage_service",
    "get_site_service",
    "get_user_service",
    "get_verification_service",
    "require_admin",
    "require_user",
]
