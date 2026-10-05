"""社区互动相关的 DTO。

**字段名对照来源**：`docs/rewrite/rewrite-contract.md`（从原 `server.js` 的
`sendJson(res, 2xx, {...})` 抠出来的）。改字段名之前先去看那份契约。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class LikeOut(BaseModel):
    """点赞 / 取消点赞的响应。

    对应原版：

    * `POST   /api/sites/:名字/like` → `{ok: true, liked: true,  likes: N}`
    * `DELETE /api/sites/:名字/like` → `{ok: true, liked: false, likes: N}`

    注意是 `likes`（总数）而不是 `count` —— 前端读的就是 `likes`。
    """

    ok: bool = True
    liked: bool
    likes: int = Field(description="该站点的点赞总数")


class SiteStatsOut(BaseModel):
    """站点互动数字。

    对应 `GET /api/sites/:名字/stats` 的 `stats` 字段：

    ```json
    {"views": 0, "likes": 0, "comments": 0, "favorites": 0,
     "liked": false, "favorited": false}
    ```

    `liked` / `favorited` 是**当前登录用户**的状态；未登录时都是 false
    （所以这个接口是"公开但读登录态"）。
    """

    views: int = 0
    likes: int = 0
    comments: int = 0
    favorites: int = 0
    liked: bool = False
    favorited: bool = False
