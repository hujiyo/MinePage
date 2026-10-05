"""会话 Cookie 的读写。

单独一个文件，是因为**写 Cookie 是 HTTP 语义**，不该混在 Service 里，
也不该在 `auth.py` / `me.py` 里各写一遍（两处写法一漂移，就会出现
"登录能成功但下次请求认不出你"这种极难查的问题）。

属性组合与原版 `lib/auth.js` 的 `buildCookie` 一致，**别改**：
`Path=/` · `HttpOnly` · `SameSite=Lax` · 可选 `Max-Age` / `Secure`。

> 原版没有 CSRF token，防跨站写操作**完全依赖 `SameSite=Lax`**。
> 去掉它等于把写操作暴露给任何第三方页面。
"""

from __future__ import annotations

from fastapi import Response

from app.core.config import Limits, settings
from app.core.security import cookie_codec


def set_session_cookie(response: Response, token: str) -> None:
    """下发会话 Cookie（登录 / 注册成功时）。

    Args:
        response: FastAPI 的响应对象，直接往里加 `Set-Cookie` 头。
        token: 会话 token（64 字符 hex）。
    """
    response.headers.append(
        "Set-Cookie",
        cookie_codec.build(
            Limits.SESSION_COOKIE,
            token,
            max_age=Limits.SESSION_TTL_DAYS * 86400,
            secure=settings.cookie_secure,
        ),
    )


def clear_session_cookie(response: Response) -> None:
    """把会话 Cookie 置空（退出登录时）。

    **靠 `Max-Age=0` 让浏览器删掉它** —— 原版就是这么做的，
    没有服务端重定向。值本身置空，但浏览器看到 `Max-Age=0` 就会丢弃这条 Cookie。
    """
    response.headers.append(
        "Set-Cookie",
        cookie_codec.build(
            Limits.SESSION_COOKIE,
            "",
            max_age=0,
            secure=settings.cookie_secure,
        ),
    )
