"""管理后台接口（5 条）的测试。

覆盖四件事：

1. **鉴权** —— 匿名 401、普通用户 403、管理员 200（5 条逐一验）
2. **契约** —— 字段名与形状（用户列表**驼峰**、页面列表**蛇形**，故意不同）
3. **状态归一化** —— 只认一个词，其它一切值都变正常（危险的默认值，要钉住）
4. **闭环** —— 管理动作**真的会改变执行侧的行为**：
   封了人 → 他下个请求就掉线、重新登录被 403；
   下线页面 → 访问变 451；删了页面 → 访问变 404

第 4 条最重要：只验"接口回了 200"是不够的，那证明不了**封禁真的生效**。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import Limits
from app.core.database import Database
from app.repositories.site_repository import SiteRepository
from app.repositories.user_repository import UserRepository

ADMIN_ENDPOINTS: list[tuple[str, str, dict[str, object] | None]] = [
    ("GET", "/api/admin/users", None),
    ("POST", "/api/admin/users/1/status", {"status": "banned"}),
    ("GET", "/api/admin/sites", None),
    ("POST", "/api/admin/sites/1/status", {"status": "offline"}),
    ("DELETE", "/api/admin/sites/1", None),
]


def call(client: TestClient, method: str, url: str, body: dict[str, object] | None) -> object:
    """按方法发请求。抽出来是为了能把 5 条接口放进参数化测试。"""
    if method == "GET":
        return client.get(url)
    if method == "DELETE":
        return client.delete(url)
    return client.post(url, json=body)


# ---------------------------------------------------------------- 鉴权


class TestAdminGuard:
    """5 条接口的鉴权 —— 一个都不能漏。"""

    @pytest.mark.parametrize(("method", "url", "body"), ADMIN_ENDPOINTS)
    def test_anonymous_gets_401(
        self, client: TestClient, method: str, url: str, body: dict[str, object] | None
    ) -> None:
        """未登录一律 401。**不是 403** —— 403 是"登录了但没权限"。"""
        assert call(client, method, url, body).status_code == 401

    @pytest.mark.parametrize(("method", "url", "body"), ADMIN_ENDPOINTS)
    def test_plain_user_gets_403(
        self,
        client: TestClient,
        plain_user: dict[str, object],
        login: object,
        method: str,
        url: str,
        body: dict[str, object] | None,
    ) -> None:
        """普通用户一律 403。"""
        login(client, int(plain_user["id"]))  # type: ignore[operator]
        assert call(client, method, url, body).status_code == 403

    @pytest.mark.parametrize(("method", "url", "body"), ADMIN_ENDPOINTS)
    def test_admin_passes_the_guard(
        self,
        client: TestClient,
        admin: dict[str, object],
        login: object,
        method: str,
        url: str,
        body: dict[str, object] | None,
    ) -> None:
        """管理员不该被拦。

        这几条路径里的 id 都是 `1` —— 可能不存在（那会 404），
        但**绝不能是 401 / 403**。这里只断言"过了鉴权"。
        """
        login(client, int(admin["id"]))  # type: ignore[operator]
        status = call(client, method, url, body).status_code
        assert status not in (401, 403), f"管理员被拦住了，回了 {status}"


# ---------------------------------------------------------------- 用户列表


class TestAdminUsers:
    """`GET /api/admin/users`。"""

    def test_shape_and_total(
        self, client: TestClient, admin: dict[str, object], plain_user: dict[str, object], login: object
    ) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        data = client.get("/api/admin/users").json()

        assert data["ok"] is True
        assert data["total"] == 2, "total 是**全库总数**，不是本页条数"
        assert len(data["users"]) == 2

    def test_no_password_hash(
        self, client: TestClient, admin: dict[str, object], plain_user: dict[str, object], login: object
    ) -> None:
        """**这条是这个接口最要紧的断言。**"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        raw = client.get("/api/admin/users").text
        assert "password_hash" not in raw
        assert "scrypt$" not in raw

    def test_keys_are_camel_case(
        self, client: TestClient, admin: dict[str, object], plain_user: dict[str, object], login: object
    ) -> None:
        """用户列表是**驼峰**（`isAdmin` / `createdAt`）—— `admin.html` 读的就是这个。

        和下面的页面列表（蛇形）相反，两边都不能"顺手统一"。
        """
        login(client, int(admin["id"]))  # type: ignore[operator]
        user = client.get("/api/admin/users").json()["users"][0]

        assert "isAdmin" in user
        assert "createdAt" in user
        assert "is_admin" not in user
        assert "created_at" not in user

    def test_newest_first(
        self, client: TestClient, admin: dict[str, object], plain_user: dict[str, object], login: object
    ) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        ids = [u["id"] for u in client.get("/api/admin/users").json()["users"]]
        assert ids == sorted(ids, reverse=True), "新的在前（id 倒序）"


# ---------------------------------------------------------------- 封禁 / 解封


class TestAdminUserStatus:
    """`POST /api/admin/users/:id/status`。"""

    def test_ban_and_unban(
        self, client: TestClient, admin: dict[str, object], plain_user: dict[str, object], login: object
    ) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        target = int(plain_user["id"])  # type: ignore[arg-type]

        r = client.post(f"/api/admin/users/{target}/status", json={"status": "banned"})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "id": target, "status": "banned"}

        r = client.post(f"/api/admin/users/{target}/status", json={"status": "active"})
        assert r.json()["status"] == "active"

    def test_cannot_ban_self(self, client: TestClient, admin: dict[str, object], login: object) -> None:
        """封自己等于当场把自己踢出后台，而且没人能解封 —— 必须拦住。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        r = client.post(f"/api/admin/users/{admin['id']}/status", json={"status": "banned"})

        assert r.status_code == 400
        assert r.json()["message"] == "不能封禁自己"

    def test_unknown_user_404(self, client: TestClient, admin: dict[str, object], login: object) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        r = client.post("/api/admin/users/999999/status", json={"status": "banned"})

        assert r.status_code == 404
        assert r.json()["message"] == "没有这个用户"

    @pytest.mark.parametrize("value", ["xxx", "", "BANNED", "banned ", "1", None])
    def test_status_normalisation_defaults_to_active(
        self,
        client: TestClient,
        admin: dict[str, object],
        plain_user: dict[str, object],
        login: object,
        value: str | None,
    ) -> None:
        """**只认 `banned`，其它一切值都解封。**

        这是原版行为，照抄了 —— 但它是个**危险的默认值**：
        打错字不会报 400，而是静默解封。这组用例就是把这个行为钉死，
        免得以后有人"顺手修成校验"而改掉契约。
        """
        login(client, int(admin["id"]))  # type: ignore[operator]
        target = int(plain_user["id"])  # type: ignore[arg-type]

        client.post(f"/api/admin/users/{target}/status", json={"status": "banned"})
        r = client.post(f"/api/admin/users/{target}/status", json={"status": value})

        assert r.status_code == 200
        assert r.json()["status"] == "active"


class TestBanTakesEffect:
    """**闭环的核心**：封禁必须真的改变执行侧的行为。

    只验"接口回 200"证明不了封禁生效 —— 这一组验的是"被封的人真的用不了了"。
    """

    def test_banned_user_loses_existing_session(
        self,
        client: TestClient,
        admin: dict[str, object],
        plain_user: dict[str, object],
        login: object,
    ) -> None:
        """已有会话**下个请求就掉线**（不吊销会话，而是每次现查 `status`）。

        这正是 `app/core/deps.py` 里"每请求现查状态"那个设计存在的理由。
        """
        token = login(client, int(plain_user["id"]))  # type: ignore[operator]
        assert client.get("/api/sites").status_code == 200, "封之前应该是登录状态"

        # 换管理员身份去封（同一个 client，所以封完要把普通用户的 Cookie 换回来）
        client.cookies.clear()
        login(client, int(admin["id"]))  # type: ignore[operator]
        assert (
            client.post(f"/api/admin/users/{plain_user['id']}/status", json={"status": "banned"}).status_code
            == 200
        )

        # 把**原来那条**会话 Cookie 装回去 —— 会话行还在，但账号已经不是 active
        client.cookies.clear()
        client.cookies.set(Limits.SESSION_COOKIE, token)
        assert client.get("/api/sites").status_code == 401, "被封的用户应被当成未登录"

    def test_banned_user_cannot_login(
        self,
        client: TestClient,
        admin: dict[str, object],
        plain_user: dict[str, object],
        login: object,
    ) -> None:
        """被封的账号重新登录 → **403**（不是 401 —— 凭证是对的，是账号被禁）。"""
        client.cookies.clear()
        login(client, int(admin["id"]))  # type: ignore[operator]
        client.post(f"/api/admin/users/{plain_user['id']}/status", json={"status": "banned"})

        client.cookies.clear()
        r = client.post(
            "/api/auth/login",
            json={"login": plain_user["email"], "password": plain_user["password"]},
        )
        assert r.status_code == 403

    def test_unban_restores_login(
        self,
        client: TestClient,
        admin: dict[str, object],
        plain_user: dict[str, object],
        login: object,
    ) -> None:
        """解封之后又能登录了 —— 闭环的另一半。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        target = int(plain_user["id"])  # type: ignore[arg-type]

        client.post(f"/api/admin/users/{target}/status", json={"status": "banned"})
        client.post(f"/api/admin/users/{target}/status", json={"status": "active"})

        client.cookies.clear()
        r = client.post(
            "/api/auth/login",
            json={"login": plain_user["email"], "password": plain_user["password"]},
        )
        assert r.status_code == 200


# ---------------------------------------------------------------- 页面列表


class TestAdminSites:
    """`GET /api/admin/sites`。"""

    def test_includes_offline_sites(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        offline_site: dict[str, object],
        login: object,
    ) -> None:
        """**必须含已下线的站点** —— 否则管理员没法把它们恢复回来。

        这是和发现流的关键区别（发现流只回 `active`）。
        """
        login(client, int(admin["id"]))  # type: ignore[operator]
        data = client.get("/api/admin/sites").json()

        names = {s["name"] for s in data["sites"]}
        assert names == {"demo-site", "offline-site"}
        assert data["total"] == 2

    def test_keys_are_snake_case(
        self, client: TestClient, admin: dict[str, object], site: dict[str, object], login: object
    ) -> None:
        """页面列表是**蛇形**（`created_at` / `owner_email`）—— 与上面的用户列表相反。

        `admin.html` 读的是 `site.owner_username`、`site.size`、`site.status`。
        """
        login(client, int(admin["id"]))  # type: ignore[operator]
        item = client.get("/api/admin/sites").json()["sites"][0]

        for key in ("created_at", "updated_at", "owner_id", "owner_email", "owner_username"):
            assert key in item, f"少了 {key}"
        assert "createdAt" not in item

    def test_owner_columns_are_filled(
        self, client: TestClient, admin: dict[str, object], site: dict[str, object], login: object
    ) -> None:
        """有主的站点要带出作者的邮箱与用户名（前端显示归属列用）。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        item = next(s for s in client.get("/api/admin/sites").json()["sites"] if s["name"] == "demo-site")
        assert item["owner_email"] == admin["email"]
        assert item["owner_username"] == "admin"

    def test_orphan_site_has_null_owner(
        self, client: TestClient, database: Database, admin: dict[str, object], login: object
    ) -> None:
        """**无主站点**（作者被删）的 `owner_*` 都是 `None`，前端显示「（无归属）」。

        靠的是 LEFT JOIN —— 用 INNER JOIN 的话这种站点会**整行消失**。
        """
        with database.session() as session:
            SiteRepository(session).create(owner_id=None, name="orphan-site", html="<h1>x</h1>")

        login(client, int(admin["id"]))  # type: ignore[operator]
        item = next(s for s in client.get("/api/admin/sites").json()["sites"] if s["name"] == "orphan-site")
        assert item["owner_id"] is None
        assert item["owner_email"] is None
        assert item["owner_username"] is None


# ---------------------------------------------------------------- 下线 / 删除


class TestAdminSiteStatus:
    """`POST /api/admin/sites/:id/status`。"""

    def test_offline_then_restore(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        site_id = int(site["id"])  # type: ignore[arg-type]

        r = client.post(f"/api/admin/sites/{site_id}/status", json={"status": "offline"})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "id": site_id, "status": "offline"}

        r = client.post(f"/api/admin/sites/{site_id}/status", json={"status": "active"})
        assert r.json()["status"] == "active"

    def test_unknown_site_404(self, client: TestClient, admin: dict[str, object], login: object) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        r = client.post("/api/admin/sites/999999/status", json={"status": "offline"})

        assert r.status_code == 404
        assert r.json()["message"] == "没有这个页面"

    @pytest.mark.parametrize("value", ["xxx", "", "OFFLINE", "offline ", "banned", None])
    def test_status_normalisation_defaults_to_active(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
        value: str | None,
    ) -> None:
        """同用户状态：**只认 `offline`**，其它一切值都上线（危险默认值，钉住）。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        site_id = int(site["id"])  # type: ignore[arg-type]

        client.post(f"/api/admin/sites/{site_id}/status", json={"status": "offline"})
        r = client.post(f"/api/admin/sites/{site_id}/status", json={"status": value})

        assert r.status_code == 200
        assert r.json()["status"] == "active"


class TestOfflineTakesEffect:
    """**闭环的另一半**：下线之后站点真的访问不了了。"""

    def test_offline_site_returns_451(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        """下线后访问 `/:站名` → **451**（不是 404 —— 站点存在，是"因法律/管理原因不可用"）。"""
        site_id = int(site["id"])  # type: ignore[arg-type]
        name = str(site["name"])

        assert client.get(f"/{name}").status_code == 200, "下线前应该能访问"

        login(client, int(admin["id"]))  # type: ignore[operator]
        client.post(f"/api/admin/sites/{site_id}/status", json={"status": "offline"})

        r = client.get(f"/{name}")
        assert r.status_code == 451

    def test_offline_site_disappears_from_discover(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        """下线后不再出现在发现流里（但仍在管理后台的列表里 —— 见上面那条）。"""
        site_id = int(site["id"])  # type: ignore[arg-type]

        login(client, int(admin["id"]))  # type: ignore[operator]
        client.post(f"/api/admin/sites/{site_id}/status", json={"status": "offline"})

        names = {s["name"] for s in client.get("/api/discover").json()["sites"]}
        assert str(site["name"]) not in names

    def test_restore_brings_it_back(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        site_id = int(site["id"])  # type: ignore[arg-type]
        name = str(site["name"])

        login(client, int(admin["id"]))  # type: ignore[operator]
        client.post(f"/api/admin/sites/{site_id}/status", json={"status": "offline"})
        client.post(f"/api/admin/sites/{site_id}/status", json={"status": "active"})

        assert client.get(f"/{name}").status_code == 200


class TestAdminDeleteSite:
    """`DELETE /api/admin/sites/:id`。"""

    def test_delete_removes_site(
        self,
        client: TestClient,
        admin: dict[str, object],
        plain_user: dict[str, object],
        database: Database,
        login: object,
    ) -> None:
        """管理员能删**别人的**站点（这是和属主那条接口的关键区别）。"""
        with database.session() as session:
            s = SiteRepository(session).create(
                owner_id=int(plain_user["id"]),
                name="doomed",
                html="<h1>x</h1>",  # type: ignore[arg-type]
            )
            site_id = s.id

        login(client, int(admin["id"]))  # type: ignore[operator]
        r = client.delete(f"/api/admin/sites/{site_id}")

        assert r.status_code == 200
        assert r.json() == {"ok": True, "id": site_id}
        assert client.get("/doomed").status_code == 404, "删完就访问不到了"

    def test_delete_cascades_files(
        self,
        client: TestClient,
        admin: dict[str, object],
        plain_user: dict[str, object],
        database: Database,
        login: object,
    ) -> None:
        """站点下的文件由外键级联清掉 —— 不留孤儿行。"""
        from app.repositories.site_file_repository import SiteFileRepository

        with database.session() as session:
            s = SiteRepository(session).create(
                owner_id=int(plain_user["id"]),
                name="doomed-multi",
                html="",  # type: ignore[arg-type]
            )
            SiteFileRepository(session).upsert(s.id, "index.html", b"<h1>x</h1>")
            site_id = s.id

        login(client, int(admin["id"]))  # type: ignore[operator]
        client.delete(f"/api/admin/sites/{site_id}")

        with database.session() as session:
            assert SiteFileRepository(session).count(site_id) == 0

    def test_unknown_site_404(self, client: TestClient, admin: dict[str, object], login: object) -> None:
        """不存在回 404，**不是幂等的 200** —— 前端要能区分"删掉了"和"本来就没有"。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        r = client.delete("/api/admin/sites/999999")

        assert r.status_code == 404
        assert r.json()["message"] == "没有这个页面"

    def test_owner_cannot_delete_others_site(
        self,
        client: TestClient,
        admin: dict[str, object],
        plain_user: dict[str, object],
        database: Database,
        login: object,
    ) -> None:
        """对照：**属主那条接口**（按名字）删不了别人的站，管理员这条能。

        两条接口的差别就在这 —— 一条按名字 + 校验归属，一条按 id + 只认管理员。
        """
        with database.session() as session:
            s = SiteRepository(session).create(
                owner_id=int(admin["id"]), name="admins-own", html="<h1>x</h1>"
            )
            name = s.name

        login(client, int(plain_user["id"]))  # type: ignore[operator]
        assert client.delete(f"/api/sites/{name}").status_code == 403


# ---------------------------------------------------------------- 死代码复活


class TestPreviouslyDeadCode:
    """这两个 `set_status` 在管理接口出现之前**没有任何调用方**。

    这组用例保证它们通过接口真的被用上了 —— 而不是又退化成死代码。
    """

    def test_user_set_status_reachable(
        self, client: TestClient, database: Database, admin: dict[str, object], login: object
    ) -> None:
        with database.session() as session:
            u = UserRepository(session).create(email="dead@test.local", password="pw123456")
            target = u.id

        login(client, int(admin["id"]))  # type: ignore[operator]
        client.post(f"/api/admin/users/{target}/status", json={"status": "banned"})

        with database.session() as session:
            assert UserRepository(session).find_by_id(target).status == "banned"  # type: ignore[union-attr]

    def test_site_set_status_reachable(
        self, client: TestClient, database: Database, admin: dict[str, object], login: object
    ) -> None:
        with database.session() as session:
            s = SiteRepository(session).create(owner_id=int(admin["id"]), name="dead-site", html="<h1>x</h1>")
            site_id = s.id

        login(client, int(admin["id"]))  # type: ignore[operator]
        client.post(f"/api/admin/sites/{site_id}/status", json={"status": "offline"})

        with database.session() as session:
            assert SiteRepository(session).find_by_id(site_id).status == "offline"  # type: ignore[union-attr]
