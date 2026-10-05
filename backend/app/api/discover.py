"""发现流（1 条）。

`GET /api/discover` —— 首页 `/`（`discover.html`）的唯一数据来源。
**公开接口，不用登录。**

## 三个查询参数都是"静默退化"的

| 参数 | 传错了会怎样 |
|---|---|
| `q` | 超过 50 字被**截断**，不报错 |
| `tag` | 不在词表里 → **当成没传**（不报错，只是筛选看起来没生效） |
| `sort` | 不在白名单 → **退回默认排序**（`updated_at DESC`） |

**这是原版行为，不是我的疏漏** —— 而且前端依赖它：
`discover.html` 会把 `tag=hot` 和 `?sort=rank` 显式映射成 `sort=views`，
正是因为知道"传 `hot` 过去也不会报错，只会什么都不筛"。

改这里的退化行为，必须连带改 `public/discover.html` 的映射。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.config import SiteTags
from app.core.deps import get_site_service
from app.core.routing import CommitBeforeResponseRoute
from app.schemas.site import AuthorOut, DiscoverOut, DiscoverSite
from app.services.site_service import SiteService

router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["discover"])


@router.get("/api/discover", response_model=DiscoverOut)
def discover(
    q: str = Query(default="", description="关键词，同时匹配标题 / 简介 / 站名"),
    tag: str = Query(default="", description="内容标签，不在词表里就当成没传"),
    sort: str = Query(default="", description="views / likes / favorites / comments / newest"),
    service: SiteService = Depends(get_site_service),
) -> DiscoverOut:
    """发现流：全部上线站点 + 互动数字，新的在前。

    `total` 是**本次返回的条数**（上限 100），不是全库总数。
    """
    rows = service.discover(q=q, tag=tag, sort=sort)
    sites = [
        DiscoverSite(
            name=row["name"],
            title=row["title"],
            description=row["description"],
            tag=row["tag"],
            tagLabel=SiteTags.label_of(row["tag"]),
            views=row["views"],
            likes=row["likes"],
            comments=row["comments"],
            favorites=row["favorites"],
            fileCount=row["fileCount"],
            kind=row["kind"],
            updatedAt=row["updatedAt"],
            author=AuthorOut(
                id=row["author"]["id"] or 0,
                # 无主站点（作者被删）时名字回落到空串，前端会显示"未知"
                name=row["author"]["name"] or "",
                username=row["author"]["username"],
            ),
        )
        for row in rows
    ]
    return DiscoverOut(total=len(sites), sites=sites)
