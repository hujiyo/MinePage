"""通用 DTO。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ApiOk(BaseModel):
    """最简单的成功响应。

    前端几乎所有地方都先判 `data.ok` 再往下走，所以**每个成功响应都要带 `ok: true`**
    —— 原版就是这么写的，别省这一个字段。
    """

    ok: bool = True


class ErrorOut(BaseModel):
    """统一错误响应。

    `message` 是**可以直接展示给用户的中文文案**。
    """

    ok: bool = False
    message: str = Field(description="可直接展示给用户的原因")
