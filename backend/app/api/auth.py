"""身份接口：注册、登录、登出、发验证码、改密、找回密码（7 条）。

契约对照 `docs/rewrite/rewrite-contract.md`：

| 方法 | 路径 | 鉴权 | 请求字段 | 响应 |
|---|---|---|---|---|
| POST | `/api/auth/register` | 公开 | `email` `password` `code` | **201** `{ok, user}` |
| POST | `/api/auth/login` | 公开 | `login` `password` | 200 `{ok, user}` |
| POST | `/api/auth/logout` | 公开 | — | 200 `{ok}` |
| POST | `/api/auth/send-code` | 公开 / 登录 | `purpose` `email` | 200 `{ok, dev?}` |
| POST | `/api/auth/password` | 登录 | `currentPassword` `code` `newPassword` | 200 `{ok}` |
| POST | `/api/auth/forgot-password` | 公开 | `email` | 200 `{ok}` |
| POST | `/api/auth/reset-password` | 公开 | `email` `code` `password` | 200 `{ok}` |

**这一层只做三件事**：取依赖、调 Service、设置 Cookie。
校验顺序、状态码、文案全在 `services/auth_service.py` 里 —— 那些是业务规则。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from app.api.cookies import clear_session_cookie, set_session_cookie
from app.core.deps import (
    get_auth_service,
    get_optional_user,
    get_session_token,
    require_user,
)
from app.core.routing import CommitBeforeResponseRoute
from app.schemas.auth import (
    AuthOut,
    ChangePasswordIn,
    ForgotPasswordIn,
    LoginIn,
    RegisterIn,
    ResetPasswordIn,
    SendCodeIn,
    SendCodeOut,
)
from app.schemas.common import ApiOk
from app.schemas.user import CurrentUser
from app.services.auth_service import AuthService

router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["auth"])


# ---------------------------------------------------------------- 注册 / 登录 / 登出


@router.post("/api/auth/register", response_model=AuthOut, status_code=201)
def register(
    payload: RegisterIn,
    response: Response,
    auth: AuthService = Depends(get_auth_service),
) -> AuthOut:
    """注册。**成功回 201 不是 200** —— 契约里写死了，别改。

    注册成功直接建会话、下发 Cookie，用户不用再登录一次。
    """
    result = auth.register(
        email=payload.email or "",
        password=payload.password or "",
        code=payload.code or "",
    )
    set_session_cookie(response, result.token)
    return AuthOut(user=result.user)


@router.post("/api/auth/login", response_model=AuthOut)
def login(
    payload: LoginIn,
    response: Response,
    auth: AuthService = Depends(get_auth_service),
) -> AuthOut:
    """登录。`login` 字段可以是邮箱，也可以是用户名。"""
    result = auth.login(login=payload.login or "", password=payload.password or "")
    set_session_cookie(response, result.token)
    return AuthOut(user=result.user)


@router.post("/api/auth/logout", response_model=ApiOk)
def logout(
    response: Response,
    token: str | None = Depends(get_session_token),
    auth: AuthService = Depends(get_auth_service),
) -> ApiOk:
    """退出登录。

    **本来就没登录也照常回 `{ok: true}`** —— 原版就是这样。
    前端"退出登录"不该因为会话已经过期而报错。
    """
    auth.logout(token)
    clear_session_cookie(response)
    return ApiOk()


# ---------------------------------------------------------------- 发验证码


@router.post(
    "/api/auth/send-code",
    response_model=SendCodeOut,
    # `reset` 用途**不带 `dev` 键**（原版：邮箱不存在时静默不发，防探测）。
    # `exclude_unset` 让"没 set 的字段"才被丢掉 —— 所以 `dev: false` 仍然会出现，
    # 而前端正是靠 `dev` 决定提示文案的。
    response_model_exclude_unset=True,
)
def send_code(
    payload: SendCodeIn,
    user: CurrentUser | None = Depends(get_optional_user),
    auth: AuthService = Depends(get_auth_service),
) -> SendCodeOut:
    """发邮箱验证码。三种用途的行为**刻意不同**，详见 `AuthService.send_code`。

    返回值里的 `dev` 决定前端提示文案：

    * `dev=True` → 「验证码已生成（未配置 SMTP，请到服务器控制台查看）」
    * `dev=False` → 「验证码已发送，10 分钟内有效」
    * 没有 `dev` 键 → `reset` 那条静默路径，前端只说"如果这个邮箱注册过，我们已发送"
    """
    dev = auth.send_code(purpose=payload.purpose or "", email=payload.email, user=user)
    # ⚠️ `ok=True` 必须**显式传**。用了 `response_model_exclude_unset=True` 之后，
    # "没被 set 过的字段"会被丢掉 —— 而 `ok` 有默认值，不显式传就等于没 set，
    # 于是响应变成 `{"dev": true}`，前端读 `data.ok` 拿到 `undefined`。
    # （这个是测试抓到的：断言 `{"ok": True, "dev": True}` 实际只回了 `{"dev": True}`。）
    if dev is None:
        return SendCodeOut(ok=True)  # reset 的静默路径：不带 dev 键
    return SendCodeOut(ok=True, dev=dev)


# ---------------------------------------------------------------- 改密 / 找回


@router.post("/api/auth/password", response_model=ApiOk)
def change_password(
    payload: ChangePasswordIn,
    user: CurrentUser = Depends(require_user),
    token: str | None = Depends(get_session_token),
    auth: AuthService = Depends(get_auth_service),
) -> ApiOk:
    """设置页改密码：当前密码 + 邮箱验证码 + 新密码。

    成功后**踢掉其他设备的会话，保留当前这一个** —— 用户自己还在用，不该被踢下线。
    """
    auth.change_password(
        user_id=user.id,
        token=token,
        current_password=payload.currentPassword or "",
        code=payload.code or "",
        new_password=payload.newPassword or "",
    )
    return ApiOk()


@router.post("/api/auth/forgot-password", response_model=ApiOk)
def forgot_password(
    payload: ForgotPasswordIn,
    auth: AuthService = Depends(get_auth_service),
) -> ApiOk:
    """找回密码第一步：要验证码。

    **邮箱不存在、或处于 60 秒冷却中，都回同样的 `{ok: true}`** —— 防账号探测。
    """
    auth.request_password_reset(payload.email or "")
    return ApiOk()


@router.post("/api/auth/reset-password", response_model=ApiOk)
def reset_password(
    payload: ResetPasswordIn,
    auth: AuthService = Depends(get_auth_service),
) -> ApiOk:
    """找回密码第二步：验证码 + 新密码。成功后**该用户全部会话失效**。"""
    auth.reset_password(
        email=payload.email or "",
        code=payload.code or "",
        password=payload.password or "",
    )
    return ApiOk()
