"""数据库连接与会话。

对应原 Node 版的 `lib/db.js`。差别在于：

* 原版用 `node:sqlite`（同步 API、模块级单例、没有连接池）
* 这里用 SQLAlchemy 的 Engine + Session**工厂**，天生带连接池，也才能换 PostgreSQL

开发用 SQLite、部署用 PostgreSQL 只靠 `DATABASE_URL` 区分，业务代码不用改。
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings


def _build_engine(url: str) -> Engine:
    """按数据库类型建 Engine。

    SQLite 有两条特殊处理，都不是可选项：

    1. **打开外键**：SQLite 默认**不**执行外键约束，而库里的级联删除
       （删站点连带删文件、删用户连带删会话）全靠它。原 Node 版在
       `getDb()` 里显式 `PRAGMA foreign_keys = ON`，这里用事件钩子做同样的事。
       —— 忘了这条的后果是"删了站点，文件还留在库里"，而且不会报错。
    2. **check_same_thread=False**：FastAPI 的同步依赖可能在不同线程里用同一个连接。

    PostgreSQL 用默认设置即可。
    """
    if url.startswith("sqlite"):
        # SQLite 文件所在目录可能还不存在
        if ":///" in url:
            path_part = url.split(":///", 1)[1]
            dirname = os.path.dirname(path_part)
            if dirname:
                os.makedirs(dirname, exist_ok=True)

        engine = create_engine(url, connect_args={"check_same_thread": False}, future=True)

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn: Any, _record: Any) -> None:
            """每条 SQLite 连接建成后立刻打开外键与 WAL。

            **外键这条不是可选项**：SQLite 默认**不执行**外键约束，而库里的级联删除
            （删站点连带删文件、删用户连带删会话）全靠它。忘了这条的后果是
            "删了站点，文件还留在库里"，而且不会报错。
            """
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.execute("PRAGMA journal_mode = WAL")
            cursor.close()

        return engine

    # pool_pre_ping：连接可能被数据库端掐断，取用前先探活，避免拿到死连接
    return create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=20, future=True)


class Database:
    """Engine + Session 工厂的持有者。

    写成类而不是模块级全局，是为了测试里能建一个指向临时库的实例。
    """

    def __init__(self, url: str | None = None) -> None:
        """`url` 不传就用配置里的（环境变量 `DATABASE_URL`）。"""
        self._url = url or settings.database_url
        self._engine = _build_engine(self._url)
        self._session_factory = sessionmaker(
            bind=self._engine,
            # ⚠️ **不要设 autoflush=False**。踩过：设了之后 `create()` 刚加进会话的对象
            # 在下一条 SELECT 里查不到（SQLAlchemy 不会先 flush），于是
            # "建完立刻读"这种写法（注册后读用户、发完码查冷却）全部静默失效。
            # 原版 Node 是同步写库，行为上等价于 autoflush=True。
            autoflush=True,
            expire_on_commit=False,
        )

    @property
    def engine(self) -> Engine:
        """底层 Engine。Alembic 与测试建表要用。"""
        return self._engine

    @property
    def url(self) -> str:
        """当前连接串。用来判断是不是 SQLite（见 `app/main.py` 的 `ensure_schema`）。"""
        return self._url

    def new_session(self) -> Session:
        """建一个会话。调用方负责关闭（用下面的 session() 上下文管理器更省心）。"""
        return self._session_factory()

    @contextmanager
    def session(self) -> Iterator[Session]:
        """会话上下文：正常退出提交、出错回滚、最后一定关闭。

        注意这里**只保证一次操作是一个事务**。跨多个 Repository 的业务操作
        要在 Service 里用 `with session.begin():` 显式圈定范围，否则中途失败
        会留下写了一半的数据。
        """
        session = self._session_factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def dispose(self) -> None:
        """关闭连接池。进程退出时调用。"""
        self._engine.dispose()


# 全局实例：与 FastAPI 的 Depends 配合使用。
# 测试里可以自己 new 一个指向临时 SQLite 的 Database 覆盖掉它。
database = Database()


def get_session(request: Request) -> Iterator[Session]:
    """FastAPI 依赖：每个请求一个会话。

    **提交由 `app/core/routing.py` 的 `CommitBeforeResponseRoute` 负责**，
    它落在"端点跑完"和"响应发出"之间 —— 详见那个文件开头的事故说明。

    这里 `with` 退出时**还会再提交一次**，当兜底：任何没走那个路由类的路径
    （或将来新增的挂载点）仍然有提交。第二次提交是空操作。

    **只读请求也会走到提交** —— 这是有意的：原版有些接口在读取时顺带写库
    （比如浏览站点时 `incrementViews`、进通知页时推进已读时间戳）。

    Args:
        request: 用来把会话挂到 `request.state.db_session` 上，
            让路由类能在响应发出前拿到它并提交。
    """
    with database.session() as session:
        request.state.db_session = session
        yield session
