"""健康检查。

原版没有这个接口。加上它是为了：
* `docker compose` 能判断容器是否真的可用
* 部署后能一眼看出「服务活着」还是「数据库连不上」

放在 `/healthz` 而不是 `/health`：`health` 在 `RESERVED` 里是个保留站名，
虽然路由优先级上不冲突，但避开它省得以后解读错误。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.routing import CommitBeforeResponseRoute

router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["health"])


@router.get("/healthz")
def healthz(session: Session = Depends(get_session)) -> dict[str, str]:
    """探活：顺带真的查一次数据库，否则"服务活着但连不上库"这种情况探不出来。"""
    session.execute(text("SELECT 1"))
    return {"status": "ok", "database": "ok"}
