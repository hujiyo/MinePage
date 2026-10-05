"""点赞接口的契约测试 —— **垂直切片的测试模板**。

每条用例都对着一个**具体的业务规则**或**前端依赖的字段**，不是"跑通就行"。
写新接口的测试时照这个格式：

* 用例名说清"什么情况 → 应该怎样"（中文用例名，pytest 支持）
* 断言里带上实际值，失败时不用再手动复现
* 每条都注明这条规则从哪来（原版行为 / 契约文档 / 刻意的取舍）
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import Limits
from app.core.database import Database
from app.core.security import cookie_codec
from app.repositories.site_repository import SiteRepository


class TestLikeContract:
    """契约：`POST/DELETE /api/sites/:名字/like` → `{ok, liked, likes}`。

    字段名来自 `docs/rewrite/rewrite-contract.md`（从原 server.js 的 sendJson 抠出来的）。
    """

    def test_未登录点赞返回401且文案是请先登录(self, client: TestClient, site: dict[str, object]) -> None:
        """原版 `requireLogin` 的文案就是「请先登录」，前端可能直接展示它。"""
        res = client.post(f"/api/sites/{site['name']}/like")
        assert res.status_code == 401, res.text
        body = res.json()
        assert body["ok"] is False
        assert body["message"] == "请先登录"

    def test_站点不存在返回404(self, client: TestClient, admin: dict[str, object], login: object) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        res = client.post("/api/sites/zzz-not-exist/like")
        assert res.status_code == 404, res.text
        assert res.json()["message"] == "没有这个站点"

    def test_站点已下线不能点赞并返回451(
        self,
        client: TestClient,
        admin: dict[str, object],
        offline_site: dict[str, object],
        login: object,
    ) -> None:
        """451 是原版用的状态码（`activeSiteOrRespond`），保持一致。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        res = client.post(f"/api/sites/{offline_site['name']}/like")
        assert res.status_code == 451, res.text
        assert res.json()["message"] == "站点已下线，暂停互动"

    def test_点赞成功返回liked_true和总数(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        """**字段名必须精确**：前端读的是 `liked` 和 `likes`，不是 `count`。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        res = client.post(f"/api/sites/{site['name']}/like")
        assert res.status_code == 200, res.text
        assert res.json() == {"ok": True, "liked": True, "likes": 1}

    def test_重复点赞是幂等的计数不会涨(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        """原版靠 `INSERT OR IGNORE` 实现幂等；重写后靠主键冲突。行为必须一样。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        first = client.post(f"/api/sites/{site['name']}/like").json()
        second = client.post(f"/api/sites/{site['name']}/like").json()
        assert first["likes"] == 1
        assert second == {"ok": True, "liked": True, "likes": 1}, second

    def test_取消点赞返回liked_false(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        login(client, int(admin["id"]))  # type: ignore[operator]
        client.post(f"/api/sites/{site['name']}/like")
        res = client.delete(f"/api/sites/{site['name']}/like")
        assert res.status_code == 200, res.text
        assert res.json() == {"ok": True, "liked": False, "likes": 0}

    def test_没赞过也能取消不报错(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        login: object,
    ) -> None:
        """原版 `unlikeSite` 返回受影响行数，0 也不抛错。"""
        login(client, int(admin["id"]))  # type: ignore[operator]
        res = client.delete(f"/api/sites/{site['name']}/like")
        assert res.status_code == 200, res.text
        assert res.json()["likes"] == 0

    def test_已下线站点仍然可以取消点赞(
        self,
        client: TestClient,
        admin: dict[str, object],
        site: dict[str, object],
        database: Database,
        login: object,
    ) -> None:
        """**这是刻意的行为不对称**，原版注释里写明了：

        > 取消点赞。这里不校验站点状态，已下线的站点也能取消（只有点赞那条路才会挡）。

        理由：站点被下线后，已经点过赞的人应该能收回那个赞，否则它永远留在那里。
        重写时必须保留 —— 这类"看起来该对称、但故意不对称"的地方最容易在重写时丢掉。
        """
        login(client, int(admin["id"]))  # type: ignore[operator]
        assert client.post(f"/api/sites/{site['name']}/like").status_code == 200

        # 把站点下线
        with database.session() as session:
            repo = SiteRepository(session)
            found = repo.find_by_name(str(site["name"]))
            assert found is not None
            repo.set_status(found, "offline")

        res = client.delete(f"/api/sites/{site['name']}/like")
        assert res.status_code == 200, res.text
        assert res.json()["likes"] == 0

    def test_列表页拿到的点赞数是按站点分组的(
        self, database: Database, admin: dict[str, object], site: dict[str, object]
    ) -> None:
        """`count_for_sites` 是给列表页避免 N+1 用的，顺手验一下它对不对。"""
        from app.repositories.like_repository import LikeRepository

        with database.session() as session:
            repo = LikeRepository(session)
            repo.add(int(site["id"]), int(admin["id"]))
            assert repo.count_for_sites([int(site["id"])]) == {int(site["id"]): 1}
            assert repo.liked_site_ids(int(admin["id"]), [int(site["id"])]) == {int(site["id"])}


class TestCompatWithNodeVersion:
    """与原 Node 版必须逐字/逐字节对齐的地方。改这些会让前端静默失效。"""

    def test_会话Cookie的名字与属性(
        self, client: TestClient, admin: dict[str, object], login: object
    ) -> None:
        """Cookie 名、`Path=/`、`HttpOnly`、`SameSite=Lax` —— 浏览器行为依赖它们。

        注意：这里直接验 `CookieCodec`，不走登录接口（登录模块还没实现）。
        """
        token = "x" * 64
        cookie = cookie_codec.build(Limits.SESSION_COOKIE, token, max_age=Limits.SESSION_TTL_DAYS * 86400)
        assert cookie.startswith(f"{Limits.SESSION_COOKIE}={token}")
        assert "Path=/" in cookie
        assert "HttpOnly" in cookie
        assert "SameSite=Lax" in cookie
        assert "Secure" not in cookie  # 非 HTTPS 环境不该带

    def test_退出登录的Cookie是Max_Age_0(self) -> None:
        """原版靠 `Max-Age=0` 让浏览器删掉 Cookie，没有服务端重定向。"""
        cookie = cookie_codec.build(Limits.SESSION_COOKIE, "", max_age=0)
        assert "Max-Age=0" in cookie

    def test_密码哈希格式是scrypt三段式(self, database: Database, admin: dict[str, object]) -> None:
        """`scrypt$<salt>$<hash>` —— **格式不对，库里现有账号的密码就全部失效**。"""
        from app.core.security import password_hasher

        hashed = password_hasher.hash("test-password")
        parts = hashed.split("$")
        assert len(parts) == 3, hashed
        assert parts[0] == "scrypt"
        assert len(parts[1]) == 32, "salt 应该是 16 字节的 hex（32 个字符）"
        assert len(parts[2]) == 128, "派生密钥 64 字节 → hex 128 个字符"
        assert password_hasher.verify("test-password", hashed)
        assert not password_hasher.verify("wrong-password", hashed)

    def test_密码哈希能被原Node版算出的值验证(self) -> None:
        """拿一个**由原 Node 代码真实生成**的哈希来验，确认两边算法真的兼容。

        这比"自己 hash 再自己 verify"强得多 —— 后者两个方向都错也能通过。
        下面这个值来自原仓库的 `lib/auth.js`（`hashPassword('hello-world-2026')`），
        已用原版 `verifyPassword` 确认过是有效的。

        **如果这条挂了，说明 scrypt 参数（N/r/p/dklen）或 salt 的编码方式变了，
        库里所有账号的密码都会失效。**

        重新生成向量的办法（在仓库根跑；反引号是 PowerShell 的续行符）：

        ```powershell
        node --input-type=module -e "import {hashPassword} from './lib/auth.js'; `
          console.log(hashPassword('hello-world-2026'))"
        ```
        """
        from app.core.security import password_hasher

        node_hash = (
            "scrypt$a0764f71c247d873d472ea848aff883d$"
            "c2b6c409be86c9d6089f343bff950410d3a5b86c2fd86c70fda72c753e90fff6"
            "48506524d478e737d7964a20602b20cd99e8e2668b3d36daa8d7c66135607347"
        )
        assert password_hasher.verify("hello-world-2026", node_hash) is True
        assert password_hasher.verify("wrong-password", node_hash) is False


@pytest.mark.parametrize("bad_input", ["", "not-a-hash", "scrypt$only-two", "bcrypt$aa$bb"])
def test_脏哈希不会抛错只返回False(bad_input: str) -> None:
    """库里有历史数据/脏数据时，不该让登录接口炸成 500。"""
    from app.core.security import password_hasher

    assert password_hasher.verify("any", bad_input) is False
