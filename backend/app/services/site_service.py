"""用户站点的内容解析。

对应原版 `server.js` 的 `handleSite`（L1767~L1804）。

**这里只回答"要发什么"，不管"怎么发"** ——
HTTP 头、状态码、沙箱 CSP 都在 `app/api/pages.py` 里，因为那些是 HTTP 语义。

## 两条容易搞错的业务规则

**1. 浏览计数只在入口页 +1。**

一个页面里引 10 张图片，不该算 10 次浏览。所以只有 `/站名` 和 `/站名/`
（也就是 `index.html`）才加，站内 css / js / 图片都不加。

**2. 老的「单 HTML 文件」站点只兜入口页。**

平台有两条并存的存储路径：单页站内容在 `sites.html` 列，多页站在 `site_files` 表。
查找顺序是**先多页、后单页**；而单页那条**只在入口页兜底** ——
子路径（`/站名/css/style.css`）绝不会去 `sites.html` 里找。
"""

from __future__ import annotations

from typing import Any, NamedTuple

from app.core.config import SiteTags
from app.core.exceptions import NotFound
from app.repositories.comment_repository import CommentRepository
from app.repositories.favorite_repository import FavoriteRepository
from app.repositories.like_repository import LikeRepository
from app.repositories.site_file_repository import SiteFileRepository
from app.repositories.site_repository import SiteRepository
from app.repositories.user_repository import UserRepository
from app.schemas.site import AuthorOut, SiteStatsOuter
from app.schemas.social import SiteStatsOut


class SiteResolution(NamedTuple):
    """一次 `/:站名` 请求的结果。

    `kind` 是判别字段，`app/api/pages.py` 按它决定回什么：

    | kind | 含义 | 用得到的字段 |
    |---|---|---|
    | `file` | 多页站里的一个文件 | `file_path` `content` |
    | `legacy` | 老单页站的 `sites.html` 内容 | `content` |
    | `missing_site` | 没有这个站点 | `site_name` |
    | `offline` | 站点被管理员下线 | — |
    | `missing_file` | 站点在，但这个文件没有 | `file_path` |
    """

    kind: str
    file_path: str = ""
    content: bytes = b""
    site_name: str = ""


class SiteService:
    """公开侧的站点信息：`/:站名` 要发什么、互动数字是多少。"""

    def __init__(
        self,
        sites: SiteRepository,
        files: SiteFileRepository,
        users: UserRepository,
        likes: LikeRepository,
        comments: CommentRepository,
        favorites: FavoriteRepository,
    ) -> None:
        """组装站点服务。

        Args:
            sites: 站点仓储（判存在、状态、老的 `html` 列、浏览计数）。
            files: 站点文件仓储（多页站的内容）。
            users: 用户仓储（算作者展示名）。
            likes: 点赞仓储（互动数字）。
            comments: 评论仓储（互动数字）。
            favorites: 收藏仓储（互动数字）。
        """
        self._sites = sites
        self._files = files
        self._users = users
        self._likes = likes
        self._comments = comments
        self._favorites = favorites

    # ---------------------------------------------------------------- 公开：互动数字

    def stats(self, site_name: str, viewer_id: int | None) -> tuple[SiteStatsOut, SiteStatsOuter]:
        """站点的互动数字 + 站点与作者信息（观看包装页一次请求拿全）。

        Args:
            site_name: 站名，大小写不敏感。
            viewer_id: 当前访客主键。**可以是 `None`（未登录）** ——
                那时 `liked` / `favorited` 都是 `False`。

        Returns:
            `(stats, site)` —— 对应契约里的 `{ok, stats, site}`。

        Raises:
            NotFound: 没有这个站点（404）。

        **注意这里不校验站点状态** —— 已下线的站点**仍然能看统计和评论列表**，
        只有"新增互动"（点赞 / 收藏 / 评论）才挡。原版注释写明了这一点。
        """
        site = self._sites.find_by_name(site_name)
        if site is None:
            raise NotFound("没有这个站点")

        stats = SiteStatsOut(
            views=site.views or 0,
            likes=self._likes.count(site.id),
            comments=self._comments.count(site.id),
            favorites=self._favorites.count(site.id),
            liked=self._likes.exists(site.id, viewer_id),
            favorited=self._favorites.exists(site.id, viewer_id),
        )

        author = None
        if site.owner_id is not None:
            owner = self._users.find_by_id(site.owner_id)
            if owner is not None:
                author = AuthorOut(
                    id=owner.id,
                    # 展示名：用户名，没设就用邮箱 @ 前面那段
                    name=self._users.display_name(owner),
                    username=owner.username,
                )

        site_info = SiteStatsOuter(
            name=site.name,
            # 标题回落到站名，前端不用自己兜底
            title=site.title or site.name,
            description=site.description,
            tag=site.tag,
            tagLabel=SiteTags.label_of(site.tag),
            ownerId=site.owner_id,
            status=site.status,
            author=author,
        )
        return stats, site_info

    # ---------------------------------------------------------------- 公开：发现流

    #: 排序白名单。**不在表里的 `sort` 静默退回默认**（原版行为）。
    DISCOVER_SORTS = frozenset({"", "views", "likes", "favorites", "comments", "newest"})

    #: 关键词最大长度。原版 `slice(0, 50)`，超长直接截断而不是报错。
    QUERY_MAX = 50

    def discover(self, *, q: str | None, tag: str | None, sort: str | None) -> list[dict[str, Any]]:
        """发现流：全部上线站点 + 互动数字，可按关键词 / 标签筛选、按热度排序。

        Args:
            q: 关键词（同时匹配标题 / 简介 / 站名）。超长会被**截断**，不报错。
            tag: 内容标签。**不在词表里就当成没传** —— 原版就是这么做的，
                所以前端传错标签不会 400，只是"筛选看起来没生效"。
            sort: 排序键。不在白名单里就退回默认（`updated_at DESC`）。

        Returns:
            站点列表，每项含互动数字与作者。

        **注意三个参数全都是"静默退化"，没有一个是报错的。**
        这是原版的行为，前端 `discover.html` 依赖它（它会把 `tag=hot` 映射成
        `sort=views`，而 `hot` 本身不在词表里）。改这里要连带改前端映射。
        """
        keyword = str(q or "")[: self.QUERY_MAX]
        tag_value = str(tag or "")
        if not any(key == tag_value for key, _ in SiteTags.TAGS):
            tag_value = ""
        sort_value = str(sort or "")
        if sort_value not in self.DISCOVER_SORTS:
            sort_value = ""
        return self._sites.discover(q=keyword, tag=tag_value, sort=sort_value)

    def resolve(self, site_name: str, rest: str) -> SiteResolution:
        """解析 `/:站名[/站内路径]`。

        Args:
            site_name: 站名（URL 里的那一段）。**大小写不敏感** —— 内部统一转小写后查。
            rest: 站内路径（带前导斜杠，如 `/css/style.css`）；入口页时是 `""` 或 `"/"`。

        Returns:
            见 `SiteResolution` 的说明。

        **副作用**：入口页命中时会把浏览数 +1（在同一个事务里，随请求提交）。
        """
        site = self._sites.find_by_name(site_name)
        if site is None:
            return SiteResolution(kind="missing_site", site_name=site_name)
        if not site.is_active:
            return SiteResolution(kind="offline")

        # `/站名` 与 `/站名/` 都算入口页；其余去掉开头斜杠得到站内路径
        file_path = "index.html" if not rest or rest == "/" else rest.lstrip("/")

        content = self._files.get_content(site.id, file_path)
        if content is not None:
            if file_path == "index.html":
                self._sites.increment_views(site)
            return SiteResolution(kind="file", file_path=file_path, content=content)

        # 老的「单 HTML 文件」站点：内容在 sites.html 里，**只兜入口页**
        if file_path == "index.html" and site.html and site.html.strip():
            self._sites.increment_views(site)
            return SiteResolution(kind="legacy", content=site.html.encode("utf-8"))

        return SiteResolution(kind="missing_file", file_path=file_path)
