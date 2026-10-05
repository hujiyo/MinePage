"""站点的数据访问。

原版这部分（`lib/sites.js`）有 20 个函数；这里收拢成 `SiteRepository` 一个类。
站点文件的访问在 `site_file_repository.py`（查询模式不同，见那里的说明）。
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import func, or_, select

from app.models.base import utcnow_iso
from app.models.site import Site, SiteFile
from app.models.social import Comment, Favorite, Like
from app.models.user import User
from app.repositories.base import BaseRepository


def _display_name(user: User) -> str:
    """展示名：用户名 → 邮箱 `@` 前面那段。

    真实用户没有独立的 `name` 字段，所以展示名是算出来的。
    原版在 SQL 里用 `COALESCE(username, substr(email, 1, instr(email,'@')-1))` ——
    `instr` 是 SQLite 专有的（PostgreSQL 用 `strpos`），所以挪到 Python 里算。
    """
    return user.username or user.email.split("@", 1)[0]


class SiteRepository(BaseRepository[Site]):
    """`sites` 表。"""

    model = Site

    # ---------------------------------------------------------------- 查询

    def find_by_name(self, name: str) -> Site | None:
        """按站名查。站名在写入时已规范化为小写，所以这里直接比对。"""
        stmt = select(Site).where(Site.name == name.strip().lower())
        return self._session.scalars(stmt).first()

    def list_by_owner(self, owner_id: int) -> list[Site]:
        """某人名下的全部站点，新的在前（「我的站点」页用）。"""
        stmt = select(Site).where(Site.owner_id == owner_id).order_by(Site.id.desc())
        return list(self._session.scalars(stmt))

    def list_owned_with_stats(self, owner_id: int) -> list[tuple[Site, int, int]]:
        """某人名下的站点 + **文件数** + **文件总字节数**。

        一次 LEFT JOIN + GROUP BY 拿全，避免"每个站点各查一次文件数"的 N+1。

        Returns:
            `[(站点, 文件数, 文件总字节数), ...]`，按站点 id 倒序（新的在前）。

        注意前端的 `totalSize` 是这么算的：`site.size`（入口文件大小）
        **加上**这里的文件总字节数 —— 见 `sites.html` 的 `fmtSize(site.totalSize)`。
        """
        file_count = func.count(SiteFile.id)
        file_bytes = func.coalesce(func.sum(SiteFile.size), 0)
        stmt = (
            select(Site, file_count, file_bytes)
            .outerjoin(SiteFile, SiteFile.site_id == Site.id)
            .where(Site.owner_id == owner_id)
            .group_by(Site.id)
            .order_by(Site.id.desc())
        )
        return [(site, int(count), int(size)) for site, count, size in self._session.execute(stmt)]

    def count_all(self) -> int:
        """站点总数（管理后台的 `total` —— 是全库总数，不是本页条数）。"""
        return int(self._session.scalar(select(func.count()).select_from(Site)) or 0)

    def list_all_admin(self, limit: int = 200) -> list[dict[str, Any]]:
        """管理后台的页面列表：**全部站点（含已下线）**，最近更新的在前。

        对应原版 `lib/sites.js` 的 `listAllSites()`。

        返回的键**是蛇形**（`created_at` / `owner_email` / `owner_username`）——
        这是原版的形状，`admin.html` 按它读（`site.owner_username`、`site.size`…）。
        **别顺手改成驼峰**：同一个后台的**用户**列表是驼峰（走 `publicUser`），
        两个列表风格不同，各自的前端代码依赖各自的风格。

        `owner_*` 三列用 LEFT JOIN 取 —— 用户被删后站点变成无主站点，
        那时 `owner_id/owner_email/owner_username` 都是 `None`，前端显示「（无归属）」。
        """
        stmt = (
            select(Site, User)
            .outerjoin(User, User.id == Site.owner_id)
            .order_by(Site.updated_at.desc())
            .limit(limit)
        )
        return [
            {
                "id": site.id,
                "name": site.name,
                "size": site.size,
                "status": site.status,
                "created_at": site.created_at,
                "updated_at": site.updated_at,
                "owner_id": site.owner_id,
                "owner_email": owner.email if owner else None,
                "owner_username": owner.username if owner else None,
            }
            for site, owner in self._session.execute(stmt)
        ]

    def find_by_id(self, site_id: int) -> Site | None:
        """按主键查（管理后台按 id 操作站点时用）。"""
        return self._session.get(Site, site_id)

    def file_count(self, site_id: int) -> int:
        """这个站点有几个文件。

        **这是区分单页站与多页站的唯一判据** —— 不要靠 `site.html` 是否为空来判断，
        那是原版歧义的来源（多页站建站时会塞一个空字符串占位）。
        """
        stmt = select(func.count()).select_from(SiteFile).where(SiteFile.site_id == site_id)
        return int(self._session.scalar(stmt) or 0)

    def discover(
        self, *, q: str = "", tag: str = "", sort: str = "", limit: int = 100
    ) -> list[dict[str, Any]]:
        """发现流：全部上线站点 + 互动数字 + 作者，按 `sort` 排序。

        对应原版 `lib/social.js` 的 `discoverSites`。

        Args:
            q: 关键词，同时匹配标题 / 简介 / 站名。**调用方已截到 50 字**。
            tag: 内容标签，**调用方已确认它在词表里**。
            sort: 排序键，**调用方已过白名单**（不在表里就退回默认）。
            limit: 上限，默认 100（与原版一致）。

        Returns:
            每项含 `name/title/description/tag/views/likes/comments/favorites/
            file_count/kind/updated_at/author_name/author_username/author_id`。

        **`kind` 由文件数反推**，不是靠 `html` 是否为空 —— 见 `file_count` 的说明。
        """
        likes = select(func.count()).select_from(Like).where(Like.site_id == Site.id).scalar_subquery()
        comments = (
            select(func.count()).select_from(Comment).where(Comment.site_id == Site.id).scalar_subquery()
        )
        favorites = (
            select(func.count()).select_from(Favorite).where(Favorite.site_id == Site.id).scalar_subquery()
        )
        files = (
            select(func.count()).select_from(SiteFile).where(SiteFile.site_id == Site.id).scalar_subquery()
        )

        stmt = (
            select(
                Site,
                User,
                likes.label("likes"),
                comments.label("comments"),
                favorites.label("favorites"),
                files.label("file_count"),
            )
            .outerjoin(User, User.id == Site.owner_id)
            .where(Site.status == "active")
        )

        keyword = q.strip()
        if keyword:
            # 转义 LIKE 的通配符，否则用户搜 `%` 会匹配到所有站点
            escaped = re.sub(r"([\\%_])", r"\\\1", keyword)
            pattern = f"%{escaped}%"
            stmt = stmt.where(
                or_(
                    Site.title.like(pattern, escape="\\"),
                    Site.description.like(pattern, escape="\\"),
                    Site.name.like(pattern, escape="\\"),
                )
            )
        if tag:
            stmt = stmt.where(Site.tag == tag)

        # 白名单排序：**不做字符串拼接**，杜绝注入。
        # 键与原版 `DISCOVER_SORTS` 一致，不在表里的 `sort` 静默退回默认排序
        # （原版就是这样，前端传错不报错）。
        orders: dict[str, tuple[Any, ...]] = {
            "": (Site.updated_at.desc(), Site.id.desc()),
            "views": (Site.views.desc(), Site.updated_at.desc()),
            "likes": (likes.desc(), Site.updated_at.desc()),
            "favorites": (favorites.desc(), Site.updated_at.desc()),
            "comments": (comments.desc(), Site.updated_at.desc()),
            "newest": (Site.created_at.desc(), Site.id.desc()),
        }
        stmt = stmt.order_by(*orders.get(sort, orders[""])).limit(limit)

        out: list[dict[str, Any]] = []
        for site, author, like_n, comment_n, favorite_n, file_n in self._session.execute(stmt):
            file_count = int(file_n or 0)
            out.append(
                {
                    "name": site.name,
                    "title": site.title,
                    "description": site.description,
                    "tag": site.tag,
                    "views": site.views or 0,
                    "likes": int(like_n or 0),
                    "comments": int(comment_n or 0),
                    "favorites": int(favorite_n or 0),
                    "fileCount": file_count,
                    "kind": "multi" if file_count > 0 else "single",
                    "updatedAt": site.updated_at,
                    "author": {
                        "id": site.owner_id,
                        # 展示名：用户名，没设就用邮箱 @ 前面那段。
                        # 原版在 SQL 里用 substr/instr 算 —— 那是 SQLite 专有的，
                        # 放到 Python 里算才两库通用。
                        "name": _display_name(author) if author else None,
                        "username": author.username if author else None,
                    },
                }
            )
        return out

    def touch(self, site: Site) -> None:
        """刷新 `updated_at`，让站点在「最近更新」排序里冒头。

        原版这里是不对称的：改 HTML 会刷、写文件会刷，
        但**改元信息（标题/简介/标签）和删文件不刷** —— 见 `tests/new-findings.md` N9。
        重写时统一成"任何改动都刷"，所有写操作都要调它。
        """
        site.updated_at = utcnow_iso()

    def increment_views(self, site: Site) -> None:
        """浏览量 +1。

        **只在入口页被真正返回时调**，站内 css/js/图片不算 —— 与原版一致。
        没有去重、没有防刷，同一个人刷新也照加。
        """
        site.views = (site.views or 0) + 1

    # ---------------------------------------------------------------- 写入

    def create(self, *, owner_id: int | None, name: str, html: str) -> Site:
        """建站点。同名冲突交给数据库的 UNIQUE 约束去拦，业务层负责翻译成友好错误。

        Args:
            owner_id: 归属用户主键。**可以是 `None`** —— 外键是 `ON DELETE SET NULL`，
                用户被删后站点会变成无主站点，所以业务上也允许建无主站点。
            name: 站名。这里统一转小写存；长度与保留字由业务层校验。
            html: 单页站的整段 HTML。多页站传空串占位（`sites.html` 是 NOT NULL）。
        """
        now = utcnow_iso()
        site = Site(
            name=name.strip().lower(),
            owner_id=owner_id,
            html=html,
            size=len(html.encode("utf-8")),
            status="active",
            title="",
            description="",
            tag="",
            created_at=now,
            updated_at=now,
            views=0,
        )
        self.add(site)
        self._session.flush()
        return site

    def set_html(self, site: Site, html: str) -> None:
        """覆盖单页站的 HTML，并同步 `size` 与 `updated_at`。"""
        site.html = html
        site.size = len(html.encode("utf-8"))
        self.touch(site)

    def set_meta(self, site: Site, *, title: str, description: str, tag: str) -> None:
        """改标题 / 简介 / 标签，并刷新 `updated_at`。

        原版这里**不刷** `updated_at`（不对称，见 N9）；重写后统一刷。
        """
        site.title = title
        site.description = description
        site.tag = tag
        self.touch(site)

    def set_status(self, site: Site, status: str) -> None:
        """上线 / 下线。管理员操作，取值 `active` 或 `offline`。"""
        site.status = status

    def to_summary(self, site: Site, *, author_name: str, author_username: str | None) -> dict[str, Any]:
        """列表页用的摘要。

        键名**必须与 `docs/rewrite/rewrite-contract.md` 里记录的一致** —— 前端直接读这些字段。

        Args:
            site: 站点实体。
            author_name: 展示名。真实用户没有独立的 name 字段，
                由调用方从用户名或邮箱前缀算出来（见 `UserRepository.display_name`）。
            author_username: 用户名。**可以是 `None`**（没设用户名的用户）。
        """
        return {
            "name": site.name,
            "title": site.title or site.name,
            "description": site.description,
            "tag": site.tag,
            "size": site.size,
            "status": site.status,
            "views": site.views or 0,
            "createdAt": site.created_at,
            "updatedAt": site.updated_at,
            "author": {"id": site.owner_id, "name": author_name, "username": author_username},
        }
