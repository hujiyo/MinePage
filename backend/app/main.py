"""应用装配（对应 Java 的 `Application` 启动类 + `@Configuration`）。

这里做四件事：
1. 建 FastAPI 应用
2. **注册全局异常处理器** —— 业务层只管 `raise NotFound(...)`，状态码和响应体在这一处决定
3. 挂路由与静态资源
4. 生命周期：建表（开发用）、播种管理员、清理过期会话

**`/api` 与页面必须同源同端口** —— 前端 `public/` 里全是相对路径，这是硬约束。
所以这个进程既提供 API，也提供那 15 个 HTML 和 `/_assets/`。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app import __version__
from app.api.router import api_router
from app.core.config import Settings, settings
from app.core.database import database
from app.core.exceptions import AppError
from app.models import Base
from app.repositories.session_repository import SessionRepository
from app.repositories.user_repository import UserRepository


def ensure_schema() -> None:
    """建表。

    **开发用**：SQLite 下直接按模型建表，`uvicorn app.main:app` 就能跑起来。
    **部署用**：走 `alembic upgrade head`，让迁移可追溯、可回滚。
    所以这里只对 SQLite 生效 —— PostgreSQL 下故意不自动建，避免绕过迁移。
    """
    if database.url.startswith("sqlite"):
        Base.metadata.create_all(database.engine)


def seed_admin(config: Settings) -> None:
    """没有管理员时建一个，凭据从环境变量读。

    只在库里一个管理员都没有时执行，所以**改过密码之后重启不会被覆盖回去**。
    注意：管理员默认口令 `123` **低于 `Limits.PASSWORD_MIN`**，而 `UserRepository.create()`
    刻意不校验长度（与原版一致）—— 所以这条种子路径能过，普通注册路径过不了。
    这是已知的不一致（`tests/new-findings.md` N7）。
    """
    with database.session() as session:
        repo = UserRepository(session)
        if repo.find_admin() is not None:
            return
        user = repo.create(
            email=config.admin_email,
            password=config.admin_password,
            is_admin=True,
            username=config.admin_username,
        )
        print(f"[bootstrap] 已创建管理员账号 {user.email}（用户名 {user.username}）")


def cleanup_expired_sessions() -> None:
    """清掉过期会话行。

    原版只在启动时清一次，这里保持一致（后台定时清理是后续的事）。
    """
    with database.session() as session:
        removed = SessionRepository(session).remove_expired()
        if removed:
            print(f"[bootstrap] 清理了 {removed} 条过期会话")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """启动时建表、播种管理员、清过期会话；退出时释放连接池。"""
    ensure_schema()
    seed_admin(settings)
    cleanup_expired_sessions()
    print(f"[startup] MinePage 后端已启动，数据库 {database.url.split('://', 1)[0]}")
    yield
    database.dispose()


def create_app(config: Settings | None = None) -> FastAPI:
    """工厂函数。

    写成工厂而不是模块级单例，是为了测试里能造一个用临时数据库的实例。
    """
    cfg = config or settings

    app = FastAPI(
        title="MinePage 后端",
        version=__version__,
        lifespan=lifespan,
        # 前端是同一套页面，不需要单独的 API 文档入口，但保留 /docs 方便联调
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    # ---------------------------------------------------------------- 异常处理
    # 对应 Java 的 @ControllerAdvice：业务层抛异常，这里统一变 HTTP 响应。

    @app.exception_handler(AppError)
    async def _app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
        """业务异常 → `{ok: false, message} + 对应状态码`。

        响应体形状与原版一致：前端读 `data.message` 直接展示。
        """
        return JSONResponse(status_code=exc.status_code, content=exc.to_payload())

    # ---------------------------------------------------------------- 路由与静态

    app.include_router(api_router)

    # `/_assets/` 与 15 个页面都由 `app/api/pages.py` 提供，**这里不挂 StaticFiles**。
    # 原因：`StaticFiles` 默认不发 `Cache-Control`，而前端依赖 `no-cache`
    # （改完 app.js / style.css 刷新就要看到）。显式路由才能控住这个头。
    if not Path(cfg.public_dir).resolve().is_dir():
        print(f"[warn] 静态资源目录不存在：{Path(cfg.public_dir).resolve()}（前端页面会 404）")

    return app


app = create_app()
