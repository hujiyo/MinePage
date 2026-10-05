"""社区互动：点赞、评论、收藏、关注、浏览历史。

对应原版的 `likes` / `comments` / `favorites` / `follows` / `view_history` 五张表。

这五张表有四个**复合主键**，没有 `id` 列。原版在这里栽过：

> `lib/social.js` 的 `listFollows` 写了 `ORDER BY f.id DESC`，
> 而 `follows` 表**根本没有 `id` 列** —— 于是 `GET /api/users/:id/follow-list`
> 对任何用户都必然 500。只有真请求一次才暴露。

用 SQLAlchemy 的类之后，这类错误在**启动时**就会被 mypy / 映射检查拦住。
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Like(Base):
    """点赞。一人一站最多一条。

    主键 `(site_id, user_id)` 同时就是唯一约束 —— **没有 `id` 列**，取消点赞按这对主键删。
    重复点赞要幂等（原版靠 `INSERT OR IGNORE`，这里在 Repository 里先查后插）。
    """

    __tablename__ = "likes"

    site_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)


class Comment(Base):
    """评论。`reply_to` 指向同站内另一条评论（**只做一级回复**）。

    * 删父评论时它的回复一并被删（`reply_to` 自引用 + `ON DELETE CASCADE`）
    * 「`reply_to` 必须存在且属于同一站点」这条规则靠**业务层校验**，库里没有约束
      —— 放在 `CommentService.add()` 里，别漏
    """

    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_id: Mapped[int] = mapped_column(Integer, ForeignKey("sites.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    reply_to: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("comments.id", ondelete="CASCADE"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (Index("idx_comments_site", "site_id"),)


class Favorite(Base):
    """收藏。一人一站最多一条。

    * 重复收藏只改 `folder`，**不刷新 `created_at`**（原版是 `ON CONFLICT DO UPDATE`）
    * `folder` 只是文本，**不是外键** —— 没有收藏夹表，也没有「重命名收藏夹」这类操作。
      所以前端「新建收藏夹」那个入口目前做不出来（见 `tests/new-findings.md` N17）
    """

    __tablename__ = "favorites"

    site_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    folder: Mapped[str] = mapped_column(String(64), nullable=False, default="默认收藏夹")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (Index("idx_favorites_user", "user_id"),)


class Follow(Base):
    """关注：`follower_id` 关注 `followee_id`。

    主键 `(follower_id, followee_id)` —— 一人对一人最多一条，
    而且**这张表没有 `id` 列**（就是当年那个 500 的来源）。
    「不能关注自己」只在业务层拦，库里没有约束。
    """

    __tablename__ = "follows"

    follower_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    followee_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (Index("idx_follows_target", "followee_id"),)


class ViewHistory(Base):
    """浏览历史。一人一站一条，重复浏览只刷新时间（简单版，不做时长/次数）。

    索引 `(user_id, viewed_at)` 供列表按时间倒序取。
    —— 注意原版**没有**以 `site_id` 打头的索引，所以删站点时对这张表的级联删除要全表扫
    （见 `tests/new-findings.md` N19）。这里补上 `idx_history_site`。
    """

    __tablename__ = "view_history"

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    site_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True
    )
    viewed_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        Index("idx_history_time", "user_id", "viewed_at"),
        # 原版缺这个索引：删站点时级联删除 view_history 会全表扫
        Index("idx_history_site", "site_id"),
    )
