"""pytest 公共夹具。

三个设计要点：

1. **每个测试用一个全新的临时 SQLite 文件**。接口测试会真的写库（点赞、注册都改数据），
   共享一个库会让测试互相污染，失败顺序一变结果就变。

2. **不用 `with TestClient(app)`**。那会触发 lifespan，而 lifespan 里会建表、播种管理员，
   动的是**全局 `database`**（也就是真实开发库）。测试只 override 依赖，绝不碰真实库。

3. **登录靠直接造会话行**，不走 `/api/auth/login`。因为登录接口属于"还没实现的模块"，
   如果测试依赖它，骨架阶段就一条都跑不了 —— 而骨架阶段正需要测试能跑。
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Limits, Settings
from app.core.database import Database, get_session
from app.core.security import session_tokens
from app.main import create_app
from app.models import Base
from app.repositories.session_repository import SessionRepository
from app.repositories.site_repository import SiteRepository
from app.repositories.user_repository import UserRepository


@pytest.fixture()
def database(tmp_path: Path) -> Iterator[Database]:
    """一个指向临时文件的 Database，建好全部表。"""
    db = Database(f"sqlite+pysqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(db.engine)
    try:
        yield db
    finally:
        db.dispose()


@pytest.fixture()
def client(database: Database) -> Iterator[TestClient]:
    """把 `get_session` 换成临时库的会话，其余照旧。

    `create_app(Settings(...))` 里的 `public_dir` 指向测试目录 ——
    只是为了让静态目录存在检查不报警告，测试不关心静态资源。
    """
    app = create_app(Settings(public_dir=str(Path(__file__).parent)))

    def _override() -> Iterator[object]:
        with database.session() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    yield TestClient(app)  # 刻意不用 with：见模块开头第 2 点
    app.dependency_overrides.clear()


@pytest.fixture()
def admin(database: Database) -> dict[str, object]:
    """一个管理员账号。"""
    with database.session() as session:
        user = UserRepository(session).create(
            email="admin@test.local", password="test-password", is_admin=True, username="admin"
        )
        return {"id": user.id, "email": user.email, "password": "test-password"}


@pytest.fixture()
def plain_user(database: Database) -> dict[str, object]:
    """一个普通用户（用来验证"不是管理员"的分支）。"""
    with database.session() as session:
        user = UserRepository(session).create(
            email="user@test.local", password="test-password", username="normaluser"
        )
        return {"id": user.id, "email": user.email, "password": "test-password"}


@pytest.fixture()
def site(database: Database, admin: dict[str, object]) -> dict[str, object]:
    """一个上线状态的站点。"""
    with database.session() as session:
        s = SiteRepository(session).create(owner_id=int(admin["id"]), name="demo-site", html="<h1>hi</h1>")
        return {"id": s.id, "name": s.name}


@pytest.fixture()
def offline_site(database: Database, admin: dict[str, object]) -> dict[str, object]:
    """一个被管理员下线的站点 —— 用来验证"下线后不能点赞、但可以取消点赞"。"""
    with database.session() as session:
        repo = SiteRepository(session)
        s = repo.create(owner_id=int(admin["id"]), name="offline-site", html="<h1>bye</h1>")
        repo.set_status(s, "offline")
        return {"id": s.id, "name": s.name}


@pytest.fixture()
def page_client(database: Database) -> Iterator[TestClient]:
    """和 `client` 一样，但 `public_dir` 指向**真正的 `public/`** —— 页面测试要用。

    路径是 `backend/../public`，也就是仓库根下那 15 个页面和 `app.js` / `style.css`。
    """
    real_public = Path(__file__).resolve().parent.parent.parent / "public"
    app = create_app(Settings(public_dir=str(real_public)))

    def _override() -> Iterator[object]:
        with database.session() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture()
def find_code(database: Database):
    """从库里**反推**某个邮箱最新一条验证码的明文。

    库里只存 `sha256('邮箱:码')`，但码只有 6 位数字 —— 枚举 100 万次比对哈希即可。
    所以测试完全不用去服务器控制台抄码（原版那套 E2E 也是这么干的）。

    返回一个函数 `find_code(email) -> str`。
    """
    from sqlalchemy import select

    from app.core.security import hash_email_code
    from app.models.user import EmailCode

    def _find(email: str) -> str:
        with database.session() as session:
            rows = list(session.scalars(select(EmailCode).where(EmailCode.email == email)))
        for row in rows:
            for n in range(10**Limits.CODE_LENGTH):
                candidate = str(n).zfill(Limits.CODE_LENGTH)
                if hash_email_code(email, candidate) == row.code_hash:
                    return candidate
        raise AssertionError(f"{email} 在库里没有可用的验证码记录")

    return _find


@pytest.fixture()
def register(client: TestClient, find_code: object):
    """走完整注册流程（发码 → 反推码 → 注册），返回会话 token。

    包成 fixture 是因为**几乎每个身份测试都要它**，而"注册要一个验证码"
    这件事本身跟被测行为无关 —— 不该让它占满每个测试的开头。
    """

    def _do(email: str, password: str = "pw123456") -> str:
        res = client.post("/api/auth/send-code", json={"purpose": "register", "email": email})
        assert res.status_code == 200, f"发验证码失败：{res.status_code} {res.text}"

        code = find_code(email)  # type: ignore[operator]
        res = client.post(
            "/api/auth/register",
            json={"email": email, "password": password, "code": code},
        )
        assert res.status_code == 201, f"注册失败：{res.status_code} {res.text}"
        return str(res.cookies.get(Limits.SESSION_COOKIE, ""))

    return _do


@pytest.fixture()
def login(database: Database):
    """返回一个「以某个用户登录」的函数（**不经过登录接口**）。

    `login(client, user_id)` 会直接造一条会话行并把 Cookie 塞给 client。
    这样 `test_like.py` 那类"只关心点赞"的测试不必依赖身份模块，
    身份模块自己还没实现时它们也能跑。
    """

    def _login(client: TestClient, user_id: int) -> str:
        token = session_tokens.create()
        with database.session() as session:
            SessionRepository(session).create(user_id, token)
        client.cookies.set(Limits.SESSION_COOKIE, token)
        return token

    return _login
