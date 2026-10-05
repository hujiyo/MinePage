"""持久层：只做数据库读写，不写业务规则、不抛业务异常。

**约定：一个文件一个 Repository 类**，文件名 = 类名的蛇形。
（`__init__.py` 的导入就按这个约定写，破例会立刻 ImportError —— 这是好事，
比"文件里放两个类、别处按猜测的路径导入"要可靠。）

判断某段代码该不该住在这里，问两个问题：

1. 它**只关心数据怎么存**吗？（是 → 留下；否 → 应该去 services）
2. 换个数据库它要改吗？（要 → 留下来，这正是这层存在的意义）

**这一层不许 import `services` 或 `api`** —— 由 `tests/test_layering.py` 和
`pyproject.toml` 里的 import-linter 双重强制。
"""

from app.repositories.base import BaseRepository
from app.repositories.like_repository import LikeRepository
from app.repositories.session_repository import SessionRepository
from app.repositories.site_file_repository import SiteFileRepository
from app.repositories.site_repository import SiteRepository
from app.repositories.user_repository import UserRepository

__all__ = [
    "BaseRepository",
    "LikeRepository",
    "SessionRepository",
    "SiteFileRepository",
    "SiteRepository",
    "UserRepository",
]
