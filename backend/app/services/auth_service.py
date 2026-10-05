"""登录、注册、改密、找回密码。

对应原版 `server.js` 的 `handleLogin` / `handleRegister` / `handleLogout` /
`handleChangePassword` / `handleResetPassword`（L459~L685）。

## 这个文件里最要紧的东西：**校验顺序**

原版的校验顺序有几处反直觉，但**每处都有原因**，照抄：

**注册**：邮箱格式 → 密码长度 → **验证码格式** → 邮箱已注册 → 消费验证码。
先做**免费**的格式校验，再查库，最后才动验证码 —— 因为"消费验证码"不可逆。

**改密**：新密码长度 → 新旧是否相同 → **当前密码对不对** → 验证码格式 → 消费验证码。
先挡掉"改成一样"，免得白验一次密码。

**找回**：**邮箱格式与验证码格式一起判** → 密码长度 → 用户存在 → 消费验证码。
一起判是为了**不区分**"邮箱不对"和"验证码不对"，防账号探测。

顺序错了不会报错，但会让用户在错误的时机看到错误的提示 —— 这类问题最难查。
"""

from __future__ import annotations

import re
from contextlib import suppress

from app.core.config import Limits
from app.core.exceptions import (
    Conflict,
    Forbidden,
    TooManyRequests,
    Unauthorized,
    ValidationError,
)
from app.core.security import looks_like_email, password_hasher, session_tokens
from app.repositories.session_repository import SessionRepository
from app.repositories.user_repository import UserRepository
from app.schemas.auth import AuthResult
from app.schemas.user import CurrentUser, UserOut
from app.services.verification_service import VerificationService

#: 验证码必须是 6 位纯数字。与原版 `CODE_PATTERN` 一致。
CODE_PATTERN = re.compile(r"^\d{6}$")


class AuthService:
    """身份的四个动作：注册、登录、登出、改密。"""

    def __init__(
        self,
        users: UserRepository,
        sessions: SessionRepository,
        verification: VerificationService,
    ) -> None:
        """组装身份服务。

        Args:
            users: 用户仓储。
            sessions: 会话仓储（发 token、踢设备）。
            verification: 验证码服务（改密与找回要消费码）。
        """
        self._users = users
        self._sessions = sessions
        self._verification = verification

    # ---------------------------------------------------------------- 注册

    def register(self, *, email: str, password: str, code: str) -> AuthResult:
        """注册新账号，成功后**直接建会话**（不用再登录一次）。

        Args:
            email: 邮箱，这里会 trim + 转小写。
            password: 明文口令。
            code: 邮箱收到的 6 位验证码。

        Returns:
            用户视图 + 新会话 token。

        Raises:
            ValidationError: 邮箱格式不对 / 密码太短 / 验证码不是 6 位数字 /
                验证码不对或过期（400）。
            Conflict: 邮箱已注册（409）。
        """
        email = email.strip().lower()

        if not looks_like_email(email):
            raise ValidationError("邮箱格式不对")
        if len(password) < Limits.PASSWORD_MIN:
            raise ValidationError(f"密码至少 {Limits.PASSWORD_MIN} 位")
        if not CODE_PATTERN.match(code.strip()):
            raise ValidationError("请输入 6 位邮箱验证码")
        if self._users.find_by_email(email) is not None:
            raise Conflict("这个邮箱已经注册过了")

        self._verification.consume(email, "register", code.strip())

        user = self._users.create(email=email, password=password)
        token = self._sessions.create(user.id, session_tokens.create()).token
        return AuthResult(user=UserOut.of(user), token=token)

    # ---------------------------------------------------------------- 登录

    def login(self, *, login: str, password: str) -> AuthResult:
        """用邮箱或用户名登录。

        Args:
            login: 邮箱**或**用户名。先按邮箱找，找不到再按用户名找。
            password: 明文口令。

        Returns:
            用户视图 + 新会话 token。

        Raises:
            Unauthorized: 账号或密码不对（401）。**不区分"没这个人"和"密码错"**，
                免得被拿来枚举账号。
            Forbidden: 账号被封禁（403）。
        """
        user = self._users.find_by_login(login.strip())
        if user is None or not password_hasher.verify(password, user.password_hash):
            raise Unauthorized("账号或密码不对")
        if user.status != "active":
            raise Forbidden("这个账号已被封禁")

        token = self._sessions.create(user.id, session_tokens.create()).token
        return AuthResult(user=UserOut.of(user), token=token)

    # ---------------------------------------------------------------- 登出

    def logout(self, token: str | None) -> None:
        """删掉服务端会话记录。

        **本来就没登录也照常返回**（不抛错）—— 原版就是这样，
        前端"退出登录"不该因为会话已过期而报错。

        Args:
            token: `mp_session` Cookie 的值，可以是 `None`。
        """
        if token:
            self._sessions.remove(token)

    # ---------------------------------------------------------------- 改密（要验证码）

    def change_password(
        self,
        *,
        user_id: int,
        token: str | None,
        current_password: str,
        code: str,
        new_password: str,
    ) -> None:
        """设置页改密码：当前密码 + 邮箱验证码 + 新密码。

        成功后**踢掉其他设备的会话，保留当前这一个** —— 用户自己还在用，不该被踢下线。

        Args:
            user_id: 当前登录用户主键。
            token: 当前会话 token（要保留的那一个）。
            current_password: 当前密码。
            code: 6 位邮箱验证码（发到该用户绑定的邮箱）。
            new_password: 新密码。

        Raises:
            ValidationError: 新密码太短 / 新旧密码相同 / 当前密码不对 /
                验证码格式不对 / 验证码不对（全部 400，**文案各不相同**）。
        """
        if len(new_password) < Limits.PASSWORD_MIN:
            raise ValidationError(f"新密码至少 {Limits.PASSWORD_MIN} 位")
        if new_password == current_password:
            raise ValidationError("新密码不能和当前密码一样")

        user = self._users.find_by_id(user_id)
        if user is None or not password_hasher.verify(current_password, user.password_hash):
            raise ValidationError("当前密码不对")

        if not CODE_PATTERN.match(code.strip()):
            raise ValidationError("请输入 6 位邮箱验证码")

        self._verification.consume(user.email, "change", code.strip())

        self._users.set_password(user, new_password)
        self._sessions.remove_others(user.id, keep_token=token)

    # ---------------------------------------------------------------- 找回密码

    def reset_password(self, *, email: str, code: str, password: str) -> None:
        """忘记密码：邮箱 + 验证码 + 新密码。

        成功后**该用户所有会话全部失效**（不保留任何一个）—— 与改密不同，
        因为这里无法确认改密的人就是原主人，只能要求全部重新登录。

        Args:
            email: 注册邮箱。
            code: 6 位验证码。
            password: 新密码。

        Raises:
            ValidationError: 邮箱或验证码格式不对 / 密码太短 / 用户不存在 /
                验证码不对（全部 400）。

        **注意两处刻意的模糊**（都是防账号探测）：

        * 邮箱格式与验证码格式**合并成一个判断**，文案统一为「邮箱或验证码不对」
        * 用户不存在时文案是「验证码不对或已过期」，**和验证码真的错时一样**
        """
        email = email.strip().lower()
        code = code.strip()

        if not looks_like_email(email) or not CODE_PATTERN.match(code):
            raise ValidationError("邮箱或验证码不对")
        if len(password) < Limits.PASSWORD_MIN:
            raise ValidationError(f"密码至少 {Limits.PASSWORD_MIN} 位")

        user = self._users.find_by_email(email)
        if user is None:
            # 与"验证码不对"同文案 —— 否则这个接口能拿来枚举哪些邮箱注册过
            raise ValidationError("验证码不对或已过期")

        self._verification.consume(email, "reset", code)

        self._users.set_password(user, password)
        self._sessions.remove_others(user.id)  # 不保留：全部设备重新登录

    # ---------------------------------------------------------------- 发验证码

    def send_code(self, *, purpose: str, email: str | None, user: CurrentUser | None) -> bool | None:
        """发验证码。三种用途的行为**刻意不同**：

        | purpose | 谁要登录 | 邮箱已注册时 | 邮箱不存在时 |
        |---|---|---|---|
        | `register` | 不要 | **409**「这个邮箱已经注册过了」 | 正常发 |
        | `reset` | 不要 | 正常发 | **静默不发，但仍回 200** ← 防探测 |
        | `change` | **要** | —（发给当前登录用户自己的邮箱） | — |

        `reset` 那条是**反账号探测**的设计：不管邮箱存不存在，回复完全一样。
        别"顺手优化"成报错 —— 那等于提供了"哪些邮箱注册过"的查询接口。

        Args:
            purpose: `register` / `reset` / `change`。
            email: 邮箱；`register` / `reset` 用得到。
            user: 当前登录用户 DTO；`change` 用得到。

        Returns:
            `dev` 标志；**`None` 表示响应里不该出现 `dev` 键**（reset 的静默路径）。

        Raises:
            ValidationError: 邮箱格式不对 / 用途未登记（400）。
            Conflict: `register` 用途但邮箱已注册（409）。
            Unauthorized: `change` 用途但未登录（401）。
            TooManyRequests: 距上次发送不足 60 秒（429）。
        """
        if purpose in {"register", "reset"}:
            address = (email or "").strip().lower()
            if not looks_like_email(address):
                raise ValidationError("邮箱格式不对")

            if purpose == "register":
                if self._users.find_by_email(address) is not None:
                    raise Conflict("这个邮箱已经注册过了")
                return self._verification.issue(address, "register")

            # reset：不管邮箱在不在，回复都一样
            if self._users.find_by_email(address) is not None:
                self._verification.issue(address, "reset")
            return None

        if purpose == "change":
            if user is None:
                raise Unauthorized("请先登录")
            return self._verification.issue(user.email, "change")

        raise ValidationError("未知的验证码用途")

    # ---------------------------------------------------------------- 找回密码第一步

    def request_password_reset(self, email: str) -> None:
        """找回密码第一步：给已注册的邮箱发码。

        **邮箱不存在时静默跳过，不报错** —— 与 `send_code` 的 `reset` 是同一设计。

        Args:
            email: 邮箱。

        Raises:
            ValidationError: 邮箱格式不对（400）。

        注意这里**不做冷却判断也不抛 429** —— 原版 `handleForgotPassword` 直接
        `await issueCode(...)`，把结果丢掉了，所以冷却中的请求也回 200。
        保持这个行为：这个接口的回复必须是"永远一样"，多一个 429 就多一条探测线索。
        """
        address = email.strip().lower()
        if not looks_like_email(address):
            raise ValidationError("邮箱格式不对")

        if self._users.find_by_email(address) is not None:
            # 冷却中也不告诉调用方 —— 回复必须与"已发送"完全一致
            with suppress(TooManyRequests):
                self._verification.issue(address, "reset")
