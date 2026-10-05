"""实体层：12 张表到类的映射。

原 Node 版把表结构写成一段 SQL 字符串（`lib/db.js` 的 `SCHEMA`），代码里到处
拿裸行对象（`row.site_id`）。这里换成 SQLAlchemy 的声明式类：

* 表结构就是类 —— 类型注解能被 mypy 检查，字段名写错在**启动时**就会报错
  （原版 `ORDER BY f.id` 引用了不存在的列，只有真请求一次才暴露）
* 关系能用 `relationship()` 表达，Service 层不用手拼 JOIN

**时间列一律用 ISO 8601 字符串**，与原版一致。不要改成 `DateTime` ——
原版所有比较都靠字符串序（`expires_at > 当前时间`），换类型会改变排序和相等语义。
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """所有实体的基类。

    Alembic 的自动迁移靠它收集元数据（见 `alembic/env.py`）。
    """


def utcnow_iso() -> str:
    """当前时间的 ISO 8601 字符串，带 `Z` 后缀。

    全库时间列都用它 —— 与原版 `new Date().toISOString()` 的输出格式一致
    （形如 `2026-10-05T16:14:17.755Z`），所以字符串比较等于时间比较。
    """
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_in_days(days: int) -> str:
    """从此刻起 N 天后的 ISO 字符串。用来算 `sessions.expires_at`。"""
    return (
        datetime.fromtimestamp(datetime.now(UTC).timestamp() + days * 86400, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
