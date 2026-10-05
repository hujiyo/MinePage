"""业务异常。

原 Node 版把「校验失败 / 没权限 / 找不到」写成散落在每个 handler 里的
`sendJson(res, 400, {ok: false, message: '...'})`。那样有三个问题：

1. 同一类错误在不同 handler 里的状态码可能不一致
2. 业务层没法表达"这里应该失败"，只能返回 null 让调用方自己判断
3. 前端拿到的响应形状靠人工保证一致

这里改成**抛异常 + 统一的异常处理器**（对应 Java 的 `@ControllerAdvice`）：
业务层只负责 `raise NotFound("没有这个站点")`，状态码和响应体由一处决定。
"""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """所有业务异常的基类。

    `status_code` 决定 HTTP 状态码，`message` 会原样进响应体 —— 所以**文案要能直接给用户看**。
    """

    status_code: int = 400
    code: str = "bad_request"

    def __init__(self, message: str, *, extra: dict[str, Any] | None = None) -> None:
        """构造一个业务异常。

        Args:
            message: **会原样进响应体，所以要能直接给用户看** ——
                别写"参数错误"这种，要写清是哪个参数、为什么不行。
            extra: 额外的顶层字段，会合并进响应体（给前端补充上下文用）。
        """
        super().__init__(message)
        self.message = message
        self.extra = extra or {}

    def to_payload(self) -> dict[str, Any]:
        """统一的错误响应体。前端读的是 `message`，不要改这个键名。"""
        payload: dict[str, Any] = {"ok": False, "message": self.message}
        payload.update(self.extra)
        return payload


class ValidationError(AppError):
    """参数不合法（长度、格式、取值）。"""

    status_code = 400
    code = "validation_error"


class Unauthorized(AppError):
    """未登录，或凭据无效。"""

    status_code = 401
    code = "unauthorized"


class Forbidden(AppError):
    """已登录但没权限（不是站点的属主、不是管理员）。"""

    status_code = 403
    code = "forbidden"


class NotFound(AppError):
    """资源不存在。"""

    status_code = 404
    code = "not_found"


class Conflict(AppError):
    """与现有状态冲突（站名已占用、邮箱已注册）。"""

    status_code = 409
    code = "conflict"


class PayloadTooLarge(AppError):
    """请求体或文件超限。"""

    status_code = 413
    code = "payload_too_large"


class SiteOffline(AppError):
    """站点被管理员下线，暂停互动。

    原版用的状态码是 **451**（Unavailable For Legal Reasons），这里保持一致 ——
    虽然语义上是"管理员下线"而不是"法律原因"，但前端和测试都按 451 写的，改了会不一致。
    """

    status_code = 451
    code = "site_offline"


class TooManyRequests(AppError):
    """验证码重发冷却中。"""

    status_code = 429
    code = "too_many_requests"
