"""实体层。

**这里必须把所有模型 import 进来** —— Alembic 的自动迁移靠 `Base.metadata` 收集表定义，
少 import 一张表，自动生成的迁移就会漏掉它（而且不报错，只是那张表不存在）。
"""

from app.models.base import Base, iso_in_days, utcnow_iso
from app.models.message import McpToken, Message
from app.models.site import Site, SiteFile
from app.models.social import Comment, Favorite, Follow, Like, ViewHistory
from app.models.user import EmailCode, User, UserSession

__all__ = [
    "Base",
    "Comment",
    "EmailCode",
    "Favorite",
    "Follow",
    "Like",
    "McpToken",
    "Message",
    "Site",
    "SiteFile",
    "User",
    "UserSession",
    "ViewHistory",
    "iso_in_days",
    "utcnow_iso",
]
