"""用户自助设置 + `/api/me`。

对应原版 `server.js` 的 `handleMe` / `handleAccountUsername` /
`handleAccountPassword` / `handleAccountBio`（L444~L754），
以及 `lib/users.js` 的 `setUsername` / `setBio` / `changePassword`。

## 两处容易被误认为"写错了"的地方

**1. 改密码有两条路，文案不一样。**

| 接口 | 当前密码错时的文案 |
|---|---|
| `POST /api/auth/password`（设置页，要验证码） | 「当前密码**不对**」 |
| `POST /api/account/password`（不带验证码） | 「当前密码**不正确**」 |

原版就是两个不同的字符串。**别统一** —— 前端可能按文案做分支，改了就是破坏契约。

**2. 账号路径改密码不踢设备。** `/api/auth/password` 会 `remove_others`，
`/api/account/password` 不会。原版注释里写明了两者的区别，保留。
"""

from __future__ import annotations

from app.core.config import USERNAME_PATTERN, Limits
from app.core.exceptions import Conflict, ValidationError
from app.core.security import password_hasher
from app.repositories.message_repository import MessageRepository
from app.repositories.notification_repository import NotificationRepository
from app.repositories.user_repository import UserRepository
from app.schemas.me import MeOut
from app.schemas.user import UserOut


class UserService:
    """用户自己的资料与凭据。"""

    def __init__(
        self,
        users: UserRepository,
        notifications: NotificationRepository,
        messages: MessageRepository,
    ) -> None:
        """组装用户服务。

        Args:
            users: 用户仓储。
            notifications: 通知仓储（算未读通知数）。
            messages: 私信仓储（算未读私信数）。
        """
        self._users = users
        self._notifications = notifications
        self._messages = messages

    # ---------------------------------------------------------------- /api/me

    def me(self, user_id: int | None) -> MeOut:
        """导航条要的全部信息：当前用户 + 两个未读数。

        Args:
            user_id: 当前登录用户主键。**`None` 表示未登录** ——
                这时不报错，返回 `user=null` 且两个未读数都是 0，
                前端据此决定显示"登录"入口还是头像。

        Returns:
            `{ok, user, unread, unreadMessages}`。

        **别把两个未读数接反**：`unread` 是通知、`unreadMessages` 是私信。
        原版前端就因为这两个语义反了，导致红点点错地方。
        """
        if user_id is None:
            return MeOut()

        user = self._users.find_by_id(user_id)
        if user is None:
            return MeOut()

        seen_at = self._notifications.seen_at_of(user)
        return MeOut(
            user=UserOut.of(user),
            unread=self._notifications.count_unread(user_id, seen_at),
            unreadMessages=self._messages.count_unread(user_id),
        )

    # ---------------------------------------------------------------- 用户名

    def set_username(self, user_id: int, username: str | None) -> str | None:
        """改用户名。**传空即清空**。

        Args:
            user_id: 当前登录用户主键。
            username: 新用户名，或 `None` / 空白串表示清空。

        Returns:
            **真正写进库的规范值**（已 trim + 转小写）。前端要用它回填输入框，
            而不是用用户输入的原值 —— 用户可能敲了大写或带了空格。

        Raises:
            ValidationError: 格式不合法（400）。
            Conflict: 已被别人占用（409）。
        """
        if username is None or str(username).strip() == "":
            user = self._users.find_by_id(user_id)
            if user is not None:
                self._users.set_username(user, None)
            return None

        value = str(username).strip().lower()
        if not self._is_valid_username(value):
            raise ValidationError(
                f"用户名只能用小写字母、数字和连字符，长度 {Limits.NAME_MIN}-{Limits.NAME_MAX}"
            )

        taken = self._users.find_by_username(value)
        if taken is not None and taken.id != user_id:
            raise Conflict("这个用户名已经被使用了")

        user = self._users.find_by_id(user_id)
        if user is not None:
            self._users.set_username(user, value)
        return value

    @staticmethod
    def _is_valid_username(value: str) -> bool:
        """长度在 `NAME_MIN`~`NAME_MAX` 之间，且只含小写字母、数字、连字符。"""
        if not (Limits.NAME_MIN <= len(value) <= Limits.NAME_MAX):
            return False
        return bool(USERNAME_PATTERN.match(value))

    # ---------------------------------------------------------------- 简介

    def set_bio(self, user_id: int, bio: str | None) -> str:
        """保存个人简介（个人中心的「想说的话」）。

        **只 trim，不做 HTML 转义** —— 它是纯文本，渲染时的转义责任在页面。
        如果在这里转义，用户看到的就会是 `&amp;` 而不是 `&`。

        Args:
            user_id: 当前登录用户主键。
            bio: 新简介，`None` 按空串处理。

        Returns:
            trim 后的最终值，前端拿它回填。

        Raises:
            ValidationError: 超过 `Limits.BIO_MAX` 字（400）。
        """
        value = str(bio or "").strip()
        if len(value) > Limits.BIO_MAX:
            raise ValidationError(f"简介最多 {Limits.BIO_MAX} 字")

        user = self._users.find_by_id(user_id)
        if user is not None:
            self._users.set_bio(user, value)
        return value

    # ---------------------------------------------------------------- 账号路径改密

    def change_password_direct(
        self, user_id: int, current_password: str | None, new_password: str | None
    ) -> None:
        """已登录状态下凭「当前密码」直接改密码（**不校验邮箱验证码**）。

        与 `AuthService.change_password` 的区别（原版注释里写明了）：

        * 这里**不校验邮箱验证码**
        * 这里**不踢其他设备的会话**

        Args:
            user_id: 当前登录用户主键。
            current_password: 当前密码。
            new_password: 新密码。

        Raises:
            ValidationError: 用户不存在 / 当前密码不正确 / 新密码太短（全部 400）。

        **校验顺序**（与原版 `lib/users.js` 的 `changePassword` 一致）：
        用户存在 → 当前密码正确 → 新密码长度。注意和 `AuthService` 那条路的顺序不同
        （那条先校验新密码长度）。
        """
        user = self._users.find_by_id(user_id)
        if user is None:
            raise ValidationError("用户不存在")

        if not password_hasher.verify(str(current_password or ""), user.password_hash):
            raise ValidationError("当前密码不正确")

        next_password = str(new_password or "")
        if len(next_password) < Limits.PASSWORD_MIN:
            raise ValidationError(f"新密码至少 {Limits.PASSWORD_MIN} 位")

        self._users.set_password(user, next_password)
