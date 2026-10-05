"""路由汇总。

**所有子路由都要在这里挂上** —— 漏挂的表现是"接口 404"，而且不会有任何报错，
只有真请求一次才发现。所以每个模块写完就立刻挂进来。

对照清单：`docs/rewrite/rewrite-contract.md` 里的 56 个接口，逐个打勾。

## ⚠️ 顺序有硬性要求

**`pages` 必须最后挂。** 它里面有一条兜底路由 `/{站名}`（用户上传的站点），
FastAPI 按注册顺序匹配，兜底放前面会把 `/api/...` 和所有平台页面都吃掉 ——
表现为"所有接口都变成 404 提示页"，而且看不出原因。
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api import auth, discover, health, me, pages, sites, social
from app.core.routing import CommitBeforeResponseRoute

api_router = APIRouter(route_class=CommitBeforeResponseRoute)

# 1) API 接口（/api/*）
api_router.include_router(health.router)
api_router.include_router(social.router)
api_router.include_router(auth.router)
api_router.include_router(me.router)
api_router.include_router(sites.router)
api_router.include_router(discover.router)

# 2) 平台页面 + /_assets/ + 用户站点兜底（**必须最后**）
api_router.include_router(pages.router)

# 还没实现的模块（按 `docs/rewrite/rewrite-contract.md` 逐个补，补完就 include 进来）：
#
#   from app.api import mcp
#   api_router.include_router(mcp.router)        # /api/mcp/* /mcp              5 条
#   （社交互动的其余部分：收藏 / 关注 / 评论 / 私信 / 历史 / 通知，共 16 条）
#
# 注意这些也都要挂在 `pages` **之前** —— 它们都是 `/api/*`，
# 被兜底吃掉就变成 404 提示页了。
