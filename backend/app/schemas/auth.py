"""身份相关的 DTO。

## 为什么入参字段**全是可选的**

原版每个 handler 都自己校验，错误响应统一是：

```json
{"ok": false, "message": "邮箱格式不对"}
```

如果这里用 Pydantic 的必填字段 + 校验器，FastAPI 会回它自己的 **422**：

```json
{"detail": [{"type": "string_type", "loc": ["body", "email"], ...}]}
```

**形状完全不同，前端读 `data.message` 会拿到 `undefined`** —— 弹窗里就是一片空白，
而且不会有任何报错。所以：

* 入参模型只用来**让类型注解成立**（`str | None`），不做校验
* 真正的校验在 Service 层，抛 `ValidationError` → 由全局异常处理器变成
  `{ok: false, message}` + 正确的状态码

**这是刻意的取舍**：用 Pydantic 的校验能力，换回契约的一致性。
换取的代价是"每个字段都要在 Service 里手写一次校验" —— 但那些校验本来就要写，
因为它们的状态码和文案各不相同（400 / 401 / 403 / 409 / 429）。
"""

from __future__ import annotations

from typing import NamedTuple

from pydantic import BaseModel

from app.schemas.user import UserOut


class AuthResult(NamedTuple):
    """登录 / 注册的结果。

    * `user` —— 对外的用户视图（**不含 `password_hash`**）
    * `token` —— 会话 token。调用方要拿它写 `Set-Cookie`，**服务层不碰 HTTP**

    这两个一起返回而不是让调用方再查一次，是因为 token 的生成时机在服务层内部
    （注册和登录都要建会话），拆开会让 HTTP 层重复实现一遍。
    """

    user: UserOut
    token: str


# ---------------------------------------------------------------- 入参


class RegisterIn(BaseModel):
    """`POST /api/auth/register` 的入参。"""

    email: str | None = None
    password: str | None = None
    code: str | None = None


class LoginIn(BaseModel):
    """`POST /api/auth/login` 的入参。`login` 可以是邮箱，也可以是用户名。"""

    login: str | None = None
    password: str | None = None


class SendCodeIn(BaseModel):
    """`POST /api/auth/send-code` 的入参。

    `purpose` 取 `register` / `change` / `reset`；`change` 用不到 `email`
    （发给当前登录用户自己绑定的邮箱）。
    """

    purpose: str | None = None
    email: str | None = None


class ChangePasswordIn(BaseModel):
    """`POST /api/auth/password` 的入参（设置页改密码，要邮箱验证码）。"""

    currentPassword: str | None = None  # noqa: N815 - 契约要求驼峰
    code: str | None = None
    newPassword: str | None = None  # noqa: N815 - 契约要求驼峰


class ForgotPasswordIn(BaseModel):
    """`POST /api/auth/forgot-password` 的入参。"""

    email: str | None = None


class ResetPasswordIn(BaseModel):
    """`POST /api/auth/reset-password` 的入参。"""

    email: str | None = None
    code: str | None = None
    password: str | None = None


# ---------------------------------------------------------------- 出参


class AuthOut(BaseModel):
    """登录 / 注册成功。

    契约：`{ok: true, user: {...}}`。注册回 **201**，登录回 200 —— 别把注册写成 200。
    """

    ok: bool = True
    user: UserOut


class SendCodeOut(BaseModel):
    """发码成功。

    **`dev` 只在真的发了码时出现**：

    * `register` / `change` → `{ok: true, dev: <bool>}`
    * `reset` → `{ok: true}`（**没有 `dev` 键**，因为邮箱不存在时静默不发，防探测）

    前端靠 `dev` 决定提示"验证码已发送"还是"未配置 SMTP，请到服务器控制台查看"。
    所以 **`dev: false` 也要出现**，不能省 —— 用 `response_model_exclude_unset=True`
    让"没 set 的字段"才被丢掉（见 `app/api/auth.py`）。
    """

    ok: bool = True
    dev: bool | None = None
