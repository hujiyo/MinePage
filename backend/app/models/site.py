"""站点与站点文件。

对应原版的 `sites` / `site_files` 两张表。**这是历史包袱最集中的地方**：

平台有两条并存的存储路径 ——
* **单页站（老）**：整段 HTML 存在 `sites.html` 列
* **多页站（新）**：内容在 `site_files`，`sites.html` 只塞一个空字符串占位

`sites.html` 是 `NOT NULL`，所以占位符躲不掉，**同一列因此承载「真实内容」和「占位符」
两种语义**。原版里这个歧义引发过真问题（同一个 `index.html` 走两条路上限差 5 倍、
建多页站时会留下空站点）。重写时保留列，但把歧义收在 `Site.is_multi_page` 一个判断里。
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Index, Integer, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Site(Base):
    """站点。一行一个站点，`name` 唯一，就是访问地址里的那一段（`/站名`）。

    * `owner_id` 是 `ON DELETE SET NULL`：用户被删后站点留下来变成**无主站点**
      （平台目前没有删用户的入口，但约束得写对）
    * `size` 是字节数；`status`：`active` 上线 / `offline` 被管理员下线（下线后访问回 451）
    * `title` / `description` / `tag`：元信息。`tag` 存 `SiteTags` 的 key，空串表示未设置
    * `views`：浏览量。**只在入口页被真正返回时 +1**，站内 css/js/图片不算；
      没有去重、没有防刷，同一个人刷新也照加
    """

    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    owner_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    html: Mapped[str] = mapped_column(String, nullable=False, default="")
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    title: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    description: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    tag: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)
    # 原版这一列不在建表语句里，由 migrate() 补
    views: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (Index("idx_sites_owner", "owner_id"),)

    @property
    def is_multi_page(self) -> bool:
        """是不是多页站。

        **不要直接判断 `html` 是否为空** —— 那是原版歧义的来源。
        唯一的判据是「`site_files` 里有没有行」，由 Service 层注入
        （`SiteService` 查一次 `file_count` 再设这个标志）。
        """
        return bool(getattr(self, "_file_count", 0))

    @property
    def is_active(self) -> bool:
        """是不是上线状态。下线站点访问回 451，而且**不能点赞**（但可以取消点赞）。"""
        return self.status == "active"

    def __repr__(self) -> str:
        """调试用表示。**刻意不含 `html`** —— 那可能是一整页文档，打出来没法看。"""
        return f"<Site id={self.id} name={self.name!r} status={self.status}>"


class SiteFile(Base):
    """多页站的一个文件（子页面、样式、脚本、图片…）。

    * 入口页约定为 `index.html`；老的单页站仍然走 `sites.html`
    * 删站点会连带删掉全部文件（`ON DELETE CASCADE`）
    * `UNIQUE (site_id, path)` 是「一路径一行」的唯一约束，写入靠它做 upsert
    * `content` 是 BLOB（原始字节），`size` 是它的长度
    * **改文件会顺带刷新 `sites.updated_at`**（让站点在「最近更新」排序里冒头）；
      但**删文件不会** —— 这是原版的不对称，见 `tests/new-findings.md` 的 N9
    """

    __tablename__ = "site_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_id: Mapped[int] = mapped_column(Integer, ForeignKey("sites.id", ondelete="CASCADE"), nullable=False)
    path: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        UniqueConstraint("site_id", "path", name="uq_site_files_site_path"),
        Index("idx_site_files_site", "site_id"),
    )
