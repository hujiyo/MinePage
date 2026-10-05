"""Alembic 迁移环境。

对应 Java 生态里的 Flyway / Liquibase。作用：**把建表从"启动时顺手 create_all"
变成可追溯、可回滚的版本化迁移**。

原 Node 版没有迁移工具，于是 `sites.views`、`users.notify_seen_at` 这两列
只存在于一个 `migrate()` 补列函数里，建表语句里根本没有 —— 想搞清楚这张表
到底有哪些列，得同时看两处（见 `tests/new-findings.md` N13）。
"""

from __future__ import annotations

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# 让 alembic 能 import 到 app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import settings  # noqa: E402
from app.models import Base  # noqa: E402  —— 这个 import 会把 12 张表都注册进 metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 连接串只有一个来源：环境变量。不在 alembic.ini 里写死。
config.set_main_option("sqlalchemy.url", settings.database_url)

# autogenerate 靠它比对"模型定义"与"库里现状"。
# 注意：`app/models/__init__.py` 必须把所有模型都 import 进来，少一个这张表就会被漏掉。
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """离线模式：不连数据库，直接把 SQL 打到标准输出。"""
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：连数据库真的执行迁移。"""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # 改字段类型也要被 autogenerate 检出来
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
