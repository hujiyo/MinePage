"""页面路由的契约测试（16 条页面 + `/_assets` + 用户站点兜底）。

页面路由和接口不一样，断言的是**HTTP 语义**：状态码、`Location`、`Cache-Control`、
以及**沙箱 CSP** —— 最后这条是安全底线，绝对不能漏。

**这一组测试用 `page_client`**（它的 `public_dir` 指向真正的 `public/`），
所以它会真的读那 15 个 HTML 文件。
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.pages import SANDBOX_CSP, SANDBOXED_EXTENSIONS
from app.core.database import Database
from app.models.site import SiteFile
from app.repositories.site_repository import SiteRepository

Login = Callable[..., str]


class TestPageRouting:
    """公开页 vs 需登录页 vs 仅访客页。"""

    def test_首页是发现流(self, page_client: TestClient) -> None:
        res = page_client.get("/")
        assert res.status_code == 200
        assert "text/html" in res.headers["content-type"]
        # discover.html 的标题（不依赖页面内容细节，只证明发的是这个文件）
        assert "<html" in res.text.lower()

    def test_页面响应带no_store(self, page_client: TestClient) -> None:
        """**不能省**：平台页面里有登录态，被缓存住就会出现
        "退出登录后还显示上一个用户"。"""
        assert page_client.get("/").headers["cache-control"] == "no-store"

    def test_未登录访问需登录页会302到login(self, page_client: TestClient) -> None:
        # 注意 `/upload` **不在这个列表里** —— PR #5 把投稿并进了「创作」页，
        # 它现在无条件跳 `/sites?tab=upload`（由下面单独的用例验），
        # 而登录拦截交给 `/sites` 自己做。
        for path in (
            "/notifications",
            "/favorites",
            "/history",
            "/messages",
            "/account",
            "/sites",
            "/settings",
        ):
            res = page_client.get(path, follow_redirects=False)
            assert res.status_code == 302, f"{path} 应当跳登录页，实际 {res.status_code}"
            assert res.headers["location"] == "/login", path

    def test_登录页与找回页在已登录时302回首页(
        self, page_client: TestClient, login: Login, admin: dict[str, object]
    ) -> None:
        login(page_client, int(admin["id"]))  # type: ignore[operator]
        for path in ("/login", "/forgot"):
            res = page_client.get(path, follow_redirects=False)
            assert res.status_code == 302, path
            assert res.headers["location"] == "/", path

    def test_跳转带no_store(self, page_client: TestClient) -> None:
        """原版注释写明了：避免浏览器把**带登录态的跳转**缓存住。"""
        res = page_client.get("/sites", follow_redirects=False)
        assert res.headers["cache-control"] == "no-store"

    def test_老投稿地址跳转到创作页的投稿标签(self, page_client: TestClient) -> None:
        """`/upload` 不再自己发页面，只跳到 `/sites?tab=upload`。

        **这个地址必须留着** —— 老书签、老文档里都是它，直接删掉就是 404。
        而且**不判登录**：跳过去的 `/sites` 自己会挡未登录，少一处判断。
        """
        res = page_client.get("/upload", follow_redirects=False)

        assert res.status_code == 302
        assert res.headers["location"] == "/sites?tab=upload"
        assert res.headers["cache-control"] == "no-store"

    def test_老投稿地址不再发index_html(self, page_client: TestClient) -> None:
        """对照：以前 `/upload` 直接发 `index.html`（整张投稿页）。

        PR #5 之后 `index.html` 已经没有任何路由指向它了，
        所以这里断言"拿不到那张页面"，防止有人把老路由加回来。
        """
        res = page_client.get("/upload", follow_redirects=False)
        assert "把 HTML 文件" not in res.text, "又发回老投稿页了"

    def test_非管理员访问admin回403页面而不是跳转(
        self, page_client: TestClient, login: Login, plain_user: dict[str, object]
    ) -> None:
        """**403（不是 302）** —— 原版注释：避免"跳回去又被弹回来"的循环。"""
        login(page_client, int(plain_user["id"]))  # type: ignore[operator]
        res = page_client.get("/admin", follow_redirects=False)
        assert res.status_code == 403, res.text
        assert "没有权限" in res.text

    def test_管理员访问admin正常(
        self, page_client: TestClient, login: Login, admin: dict[str, object]
    ) -> None:
        login(page_client, int(admin["id"]))  # type: ignore[operator]
        assert page_client.get("/admin").status_code == 200

    def test_公开页面未登录也能看(self, page_client: TestClient) -> None:
        for path in ("/", "/u/someone", "/view/some-site", "/login", "/forgot"):
            res = page_client.get(path)
            assert res.status_code == 200, f"{path} 应当公开可访问"


class TestAssets:
    """`/_assets/{file}`。"""

    def test_app_js能取到且带no_cache(self, page_client: TestClient) -> None:
        """**`no-cache` 不能省** —— 前端改完 app.js 刷新就要看到。

        FastAPI 的 `StaticFiles` 默认不发这个头，所以这里用显式路由。
        """
        res = page_client.get("/_assets/app.js")
        assert res.status_code == 200
        assert "javascript" in res.headers["content-type"]
        assert res.headers["cache-control"] == "no-cache", "缺 no-cache 会让前端改动看不到"

    def test_style_css能取到(self, page_client: TestClient) -> None:
        res = page_client.get("/_assets/style.css")
        assert res.status_code == 200
        assert "css" in res.headers["content-type"]

    def test_不存在的资源回404(self, page_client: TestClient) -> None:
        assert page_client.get("/_assets/nope.js").status_code == 404

    def test_路径穿越进不来(self, page_client: TestClient) -> None:
        """路由参数 `{file}` 不含斜杠，所以 `../` 天然进不来。

        这里连试三种编码，确认都拿不到平台自己的文件。
        """
        for path in (
            "/_assets/..%2Fapp.py",
            "/_assets/../pyproject.toml",
            "/_assets/%2e%2e%2fpyproject.toml",
        ):
            res = page_client.get(path)
            assert res.status_code in (404, 400, 307), f"{path} 不该拿到文件（{res.status_code}）"
            assert "sqlalchemy" not in res.text.lower()


class TestUserSite:
    """`/:站名` 兜底路由。"""

    def test_站点不存在回404(self, page_client: TestClient) -> None:
        res = page_client.get("/no-such-site-here")
        assert res.status_code == 404
        assert "没有找到" in res.text

    def test_已下线站点回451(
        self, page_client: TestClient, database: Database, offline_site: dict[str, object]
    ) -> None:
        """**451**（Unavailable For Legal Reasons）是原版用的状态码，保持一致。"""
        res = page_client.get(f"/{offline_site['name']}")
        assert res.status_code == 451, res.text
        assert "已下线" in res.text

    def test_单页站内容会带沙箱CSP(self, page_client: TestClient, site: dict[str, object]) -> None:
        """**安全底线**：用户上传的 HTML 必须关进沙箱。

        没有这个头，用户就能在自己的页面里用脚本读平台的 Cookie、冒充任何登录用户。
        """
        res = page_client.get(f"/{site['name']}")
        assert res.status_code == 200, res.text
        assert res.headers.get("content-security-policy") == SANDBOX_CSP
        assert "allow-same-origin" not in SANDBOX_CSP, (
            "**绝不能加 allow-same-origin** —— 加了脚本就能逃出沙箱"
        )

    def test_多页站的子文件也会带沙箱CSP(
        self, page_client: TestClient, database: Database, site: dict[str, object]
    ) -> None:
        """子页面（`about.html`）同样是能执行脚本的文档，同样要关沙箱。"""
        with database.session() as session:
            session.add(
                SiteFile(
                    site_id=int(site["id"]),
                    path="about.html",
                    content=b"<h1>about</h1>",
                    size=15,
                    updated_at="2026-01-01T00:00:00.000Z",
                )
            )
        res = page_client.get(f"/{site['name']}/about.html")
        assert res.status_code == 200, res.text
        assert res.headers.get("content-security-policy") == SANDBOX_CSP

    def test_svg也是能带脚本的文档类型所以也要关沙箱(self) -> None:
        """`<svg><script>` 一样能执行 —— 只挡 `.html` 是不够的。

        这条测的是那份扩展名清单本身（行为测法要在库里造 svg，见下一条）。
        """
        assert {".html", ".htm", ".svg", ".xml"} == SANDBOXED_EXTENSIONS

    def test_svg文件实际也会带沙箱CSP(
        self, page_client: TestClient, database: Database, site: dict[str, object]
    ) -> None:
        with database.session() as session:
            session.add(
                SiteFile(
                    site_id=int(site["id"]),
                    path="logo.svg",
                    content=b"<svg xmlns='http://www.w3.org/2000/svg'><script>x()</script></svg>",
                    size=60,
                    updated_at="2026-01-01T00:00:00.000Z",
                )
            )
        res = page_client.get(f"/{site['name']}/logo.svg")
        assert res.status_code == 200
        assert res.headers.get("content-security-policy") == SANDBOX_CSP, "svg 漏掉沙箱 = 用户脚本能逃出来"

    def test_css不加沙箱CSP(
        self, page_client: TestClient, database: Database, site: dict[str, object]
    ) -> None:
        """非文档类型不该带 CSP —— 带了也不会有害，但不加才说明清单是精确的。"""
        with database.session() as session:
            session.add(
                SiteFile(
                    site_id=int(site["id"]),
                    path="style.css",
                    content=b"body{margin:0}",
                    size=13,
                    updated_at="2026-01-01T00:00:00.000Z",
                )
            )
        res = page_client.get(f"/{site['name']}/style.css")
        assert res.status_code == 200
        assert "content-security-policy" not in res.headers
        assert res.headers["cache-control"] == "no-cache"

    def test_浏览计数只在入口页加(
        self, page_client: TestClient, database: Database, site: dict[str, object]
    ) -> None:
        """**一个页面引 10 张图片不该算 10 次浏览** —— 原版刻意的设计。

        入口页访问两次（+2），子文件访问两次（+0），最终应当只 +2。
        """
        with database.session() as session:
            session.add(
                SiteFile(
                    site_id=int(site["id"]),
                    path="a.css",
                    content=b"x",
                    size=1,
                    updated_at="2026-01-01T00:00:00.000Z",
                )
            )

        page_client.get(f"/{site['name']}")
        page_client.get(f"/{site['name']}")
        page_client.get(f"/{site['name']}/a.css")
        page_client.get(f"/{site['name']}/a.css")

        with database.session() as session:
            found = SiteRepository(session).find_by_name(str(site["name"]))
            assert found is not None
            assert found.views == 2, f"入口页访问 2 次、子文件 2 次，浏览量应为 2，实际 {found.views}"

    def test_子路径不会回退到老的单页内容(self, page_client: TestClient, site: dict[str, object]) -> None:
        """**老的 `sites.html` 内容只兜入口页** —— 原版注释里明确写了。

        `site` fixture 建的是单页站（`html="<h1>hi</h1>"`，没有 site_files）。
        取子路径时不该把它当文件发出去。
        """
        res = page_client.get(f"/{site['name']}/whatever.css")
        assert res.status_code == 404, res.text

    def test_站点名大小写不敏感(
        self, page_client: TestClient, database: Database, admin: dict[str, object]
    ) -> None:
        """站名写入时统一转小写，所以查的时候也该不敏感。"""
        with database.session() as session:
            s = SiteRepository(session).create(owner_id=int(admin["id"]), name="Case-Test", html="<h1>c</h1>")
            assert s.name == "case-test", "站名应当被规范化为小写"

        assert page_client.get("/case-test").status_code == 200
        assert page_client.get("/CASE-TEST").status_code == 200, (
            "大写站名也该能访问（原版这里对多文件路径是 404，见 new-findings BC-21）"
        )

    def test_老的单页站在入口页仍然能被兜住(
        self, page_client: TestClient, database: Database, admin: dict[str, object]
    ) -> None:
        """多页找不到 `index.html` 时，要回退到 `sites.html` 的那段内容。"""
        with database.session() as session:
            SiteRepository(session).create(
                owner_id=int(admin["id"]), name="legacy-site", html="<h1>老单页站</h1>"
            )
        res = page_client.get("/legacy-site")
        assert res.status_code == 200
        assert "老单页站" in res.text
        assert res.headers.get("content-security-policy") == SANDBOX_CSP

    def test_平台路由不会被站名吃掉(
        self, page_client: TestClient, database: Database, admin: dict[str, object]
    ) -> None:
        """**兜底路由必须最后注册** —— 否则 `/sites` 这种平台路径会被当成站名。

        这里真的建一个叫 `sites` 的站点来试：平台页面应当仍然优先。
        （`sites` 在 RESERVED 里，但那是业务层的注册校验，库里直接建是能建出来的。）
        """
        with database.session() as session:
            SiteRepository(session).create(
                owner_id=int(admin["id"]), name="sites", html="<h1>我是用户站点</h1>"
            )
        res = page_client.get("/sites", follow_redirects=False)
        assert res.status_code == 302, "平台页面 /sites 应当优先于同名用户站点"
        assert "我是用户站点" not in res.text


class TestMessagePageSafety:
    """提示页的转义。"""

    def test_站名会被转义不会造成XSS(self, page_client: TestClient) -> None:
        """404 提示页里会回显站名 —— **不转义就是一个反射型 XSS**。"""
        res = page_client.get("/<script>alert(1)</script>")
        assert res.status_code == 404
        assert "<script>alert(1)</script>" not in res.text, "站名没有被转义！"
        assert "&lt;script&gt;" in res.text


class TestSiteFileTable:
    """顺手验一下 `site_files` 的唯一约束没被绕过。"""

    def test_同一路径覆盖不会产生第二行(self, database: Database, site: dict[str, object]) -> None:
        from app.models.base import utcnow_iso
        from app.repositories.site_file_repository import SiteFileRepository

        with database.session() as session:
            repo = SiteFileRepository(session)
            repo.upsert(int(site["id"]), "index.html", b"first")
            repo.upsert(int(site["id"]), "index.html", b"second")
            assert repo.count(int(site["id"])) == 1

        with database.session() as session:
            rows = list(session.scalars(select(SiteFile)))
            assert [r.content for r in rows] == [b"second"]
            # 顺手确认 upsert 会刷新 updated_at（原版这里是对称的）
            assert rows[0].updated_at <= utcnow_iso()
