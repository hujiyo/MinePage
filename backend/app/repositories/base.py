"""Repository 基类。

用**泛型 + 继承**把各表重复的 CRUD 收拢到一处 —— 这既是工程上的省事，
也是课程"面向对象"要求的直接体现（继承、泛型、封装）。

泛型用的是 PEP 695 的语法（`class BaseRepository[ModelT]`），Python 3.12+ 可用，
比旧的 `Generic[TypeVar("ModelT")]` 少一层样板。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session


class BaseRepository[ModelT]:
    """某个实体的数据访问基类。

    子类只要设好 `model`，通用的增删查就有了；表特有的查询写在子类里。
    """

    #: 子类必须指定自己管哪个实体
    model: type[ModelT]

    def __init__(self, session: Session) -> None:
        """持有一个会话。

        **不自己开会话、不自己提交** —— 会话的生命周期由调用方（依赖注入）管，
        这样一个请求里的多个 Repository 才能共享同一个事务。
        """
        self._session = session

    @property
    def session(self) -> Session:
        """给子类用（也要给测试用，方便断言写了什么）。"""
        return self._session

    def add(self, instance: ModelT) -> ModelT:
        """加入会话（还没落库，等事务提交）。"""
        self._session.add(instance)
        return instance

    def delete(self, instance: ModelT) -> None:
        """标记删除（同样等事务提交）。"""
        self._session.delete(instance)

    def get(self, primary_key: Any) -> ModelT | None:
        """按主键取一行。"""
        return self._session.get(self.model, primary_key)

    def all(self) -> list[ModelT]:
        """取全表。数据量小的表才该用。"""
        return list(self._session.scalars(select(self.model)))

    def count(self, statement: Select[Any] | None = None) -> int:
        """计数。传 `statement` 就数它的结果行数，不传就数整张表。

        注意这是**数结果行数**，不是 `COUNT(*)` 优化 —— 数据量小，够用且不容易错。
        """
        if statement is None:
            return int(self._session.scalar(select(func.count()).select_from(self.model)) or 0)
        return len(list(self._session.scalars(statement)))
