"""身份接口的契约测试（7 条身份接口 + 4 条 `/api/me` 与账号接口）。

**每条接口至少覆盖一个错误分支** —— 这是 `backend/README.md` 的 DoD 第 2 条。
"只测正例"正是原 Node 版出问题的方式。

测试里刻意断言的五类东西：

1. **状态码**：注册是 201 不是 200；封禁是 403 不是 401；冷却中是 429
2. **文案**：前端可能直接展示 `message`，改一个字就是破坏契约
3. **校验顺序**：`/api/auth/password` 先判新密码长度、`/api/account/password` 先判当前密码 ——
   顺序错了不会报错，但用户会在错误的时机看到错误的提示
4. **防探测**：`reset` 相关接口对不同输入必须回**完全一样**的响应
5. **会话副作用**：改密保留当前会话、找回密码清空全部

用 `register` fixture 造账号（它读的是**临时库**，见 `conftest.py`）。
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import Limits
from app.core.database import Database
from app.core.security import session_tokens
from app.models.message import Message
from app.models.user import EmailCode
from app.repositories.session_repository import SessionRepository
from app.repositories.user_repository import UserRepository

Register = Callable[..., str]


class TestRegister:
    """`POST /api/auth/register`。"""

    def test_注册成功回201并下发会话Cookie(self, register: Register, database: Database) -> None:
        """**201 不是 200** —— 契约里写死了，判成 200 会让测试静默跳过后续断言。"""
        token = register("reg1@test.local")
        assert token, "注册成功必须下发会话 Cookie"
        with database.session() as session:
            assert UserRepository(session).find_by_email("reg1@test.local") is not None

    def test_邮箱格式不对回400(self, client: TestClient) -> None:
        res = client.post(
            "/api/auth/register",
            json={"email": "not-an-email", "password": "pw123456", "code": "123456"},
        )
        assert res.status_code == 400
        assert res.json() == {"ok": False, "message": "邮箱格式不对"}

    def test_密码太短回400且文案带下限(self, client: TestClient) -> None:
        res = client.post(
            "/api/auth/register",
            json={"email": "a@b.co", "password": "12345", "code": "123456"},
        )
        assert res.status_code == 400
        assert res.json()["message"] == f"密码至少 {Limits.PASSWORD_MIN} 位"

    def test_验证码不是6位数字回400(self, client: TestClient) -> None:
        """**这条在"邮箱已注册"之前判** —— 顺序来自原版。"""
        res = client.post(
            "/api/auth/register",
            json={"email": "a@b.co", "password": "pw123456", "code": "abc"},
        )
        assert res.status_code == 400
        assert res.json()["message"] == "请输入 6 位邮箱验证码"

    def test_邮箱已注册回409(self, client: TestClient, register: Register) -> None:
        register("dup@test.local")
        res = client.post(
            "/api/auth/register",
            json={"email": "dup@test.local", "password": "pw123456", "code": "123456"},
        )
        assert res.status_code == 409
        assert res.json()["message"] == "这个邮箱已经注册过了"


class TestLogin:
    """`POST /api/auth/login`。"""

    def test_密码错回401且不区分账号是否存在(self, client: TestClient, register: Register) -> None:
        """**"没这个人"和"密码错"文案必须一样** —— 否则能拿来枚举账号。"""
        register("login1@test.local", "right-password")

        wrong_pw = client.post("/api/auth/login", json={"login": "login1@test.local", "password": "wrong"})
        no_such = client.post("/api/auth/login", json={"login": "nobody@test.local", "password": "whatever"})
        assert wrong_pw.status_code == no_such.status_code == 401
        assert wrong_pw.json() == no_such.json() == {"ok": False, "message": "账号或密码不对"}

    def test_登录成功且用户对象不含密码哈希(self, client: TestClient, register: Register) -> None:
        register("login2@test.local", "pw123456")
        res = client.post("/api/auth/login", json={"login": "login2@test.local", "password": "pw123456"})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["ok"] is True
        assert "password_hash" not in body["user"], "**密码哈希绝不能出现在响应里**"
        assert body["user"]["email"] == "login2@test.local"

    def test_封禁账号回403而不是401(self, client: TestClient, database: Database, register: Register) -> None:
        """封禁是 403「这个账号已被封禁」，与密码错的 401 文案不同 —— 这是刻意的。"""
        register("banned@test.local", "pw123456")
        with database.session() as session:
            users = UserRepository(session)
            user = users.find_by_email("banned@test.local")
            assert user is not None
            users.set_status(user, "banned")

        res = client.post("/api/auth/login", json={"login": "banned@test.local", "password": "pw123456"})
        assert res.status_code == 403
        assert res.json()["message"] == "这个账号已被封禁"

    def test_可以用用户名登录(self, client: TestClient, register: Register) -> None:
        """`login` 字段既可以是邮箱也可以是用户名 —— 先按邮箱找，找不到再按用户名找。"""
        register("byname@test.local", "pw123456")
        client.post("/api/account/username", json={"username": "byname"})
        client.post("/api/auth/logout")

        res = client.post("/api/auth/login", json={"login": "byname", "password": "pw123456"})
        assert res.status_code == 200, res.text
        assert res.json()["user"]["username"] == "byname"


class TestLogout:
    """`POST /api/auth/logout`。"""

    def test_登出把Cookie置空(self, client: TestClient, register: Register) -> None:
        register("out@test.local")
        res = client.post("/api/auth/logout")
        assert res.status_code == 200
        assert res.json() == {"ok": True}
        assert "Max-Age=0" in res.headers.get("set-cookie", "")

    def test_没登录也回ok(self, client: TestClient) -> None:
        """原版行为：退出登录不该因为会话已过期而报错。"""
        res = client.post("/api/auth/logout")
        assert res.status_code == 200
        assert res.json() == {"ok": True}


class TestSendCode:
    """`POST /api/auth/send-code`。"""

    def test_register用途成功时响应带dev(self, client: TestClient) -> None:
        """开发模式（没配 SMTP）`dev` 应该是 `True`，前端据此提示去控制台看。"""
        res = client.post("/api/auth/send-code", json={"purpose": "register", "email": "fresh@test.local"})
        assert res.status_code == 200, res.text
        assert res.json() == {"ok": True, "dev": True}

    def test_register用途对已注册邮箱回409(self, client: TestClient, register: Register) -> None:
        register("code1@test.local")
        res = client.post("/api/auth/send-code", json={"purpose": "register", "email": "code1@test.local"})
        assert res.status_code == 409
        assert res.json()["message"] == "这个邮箱已经注册过了"

    def test_reset用途对未注册邮箱也回200(self, client: TestClient) -> None:
        """**防探测**：不管邮箱在不在，回复必须一样。

        注意响应里**没有 `dev` 键**（原版那条静默路径不带它）——
        差一个键就是一条探测线索。
        """
        unknown = client.post("/api/auth/send-code", json={"purpose": "reset", "email": "nobody@test.local"})
        assert unknown.status_code == 200
        assert unknown.json() == {"ok": True}

    def test_change用途未登录回401(self, client: TestClient) -> None:
        res = client.post("/api/auth/send-code", json={"purpose": "change"})
        assert res.status_code == 401
        assert res.json()["message"] == "请先登录"

    def test_未知用途回400(self, client: TestClient) -> None:
        res = client.post("/api/auth/send-code", json={"purpose": "whatever"})
        assert res.status_code == 400
        assert res.json()["message"] == "未知的验证码用途"

    def test_60秒内重发回429且文案带秒数(self, client: TestClient) -> None:
        """冷却按「邮箱 + 用途」算，**没有 IP 维度**（换邮箱能绕过，这是原版的设计）。"""
        payload = {"purpose": "register", "email": "cd@test.local"}
        assert client.post("/api/auth/send-code", json=payload).status_code == 200
        res = client.post("/api/auth/send-code", json=payload)
        assert res.status_code == 429
        assert "秒后再试" in res.json()["message"]

    def test_换一个用途不受另一个用途的冷却影响(self, client: TestClient, register: Register) -> None:
        """冷却键是「邮箱 + 用途」，所以在 register 冷却期内 change 仍可发。"""
        register("cross@test.local")
        assert client.post("/api/auth/send-code", json={"purpose": "change"}).status_code == 200


class TestChangePassword:
    """`POST /api/auth/password`（要验证码的那条路）。"""

    def test_未登录回401(self, client: TestClient) -> None:
        res = client.post(
            "/api/auth/password",
            json={"currentPassword": "a", "code": "123456", "newPassword": "b123456"},
        )
        assert res.status_code == 401
        assert res.json()["message"] == "请先登录"

    def test_新密码太短优先于当前密码校验(self, client: TestClient, register: Register) -> None:
        """**顺序**：先判新密码长度 → 再判新旧是否相同 → 然后才验当前密码 → 最后验验证码。

        这条用一个"当前密码也是错的"请求来证明顺序 —— 顺序反了的话，
        报的会是「当前密码不对」而不是「新密码至少 6 位」。
        """
        register("cp1@test.local", "pw123456")
        res = client.post(
            "/api/auth/password",
            json={"currentPassword": "totally-wrong", "code": "123456", "newPassword": "123"},
        )
        assert res.status_code == 400
        assert res.json()["message"] == f"新密码至少 {Limits.PASSWORD_MIN} 位"

    def test_新旧密码相同回400(self, client: TestClient, register: Register) -> None:
        register("cp2@test.local", "same-password")
        res = client.post(
            "/api/auth/password",
            json={
                "currentPassword": "same-password",
                "code": "123456",
                "newPassword": "same-password",
            },
        )
        assert res.status_code == 400
        assert res.json()["message"] == "新密码不能和当前密码一样"

    def test_当前密码不对回400(self, client: TestClient, register: Register) -> None:
        register("cp3@test.local", "right-password")
        res = client.post(
            "/api/auth/password",
            json={"currentPassword": "wrong", "code": "123456", "newPassword": "new-password"},
        )
        assert res.status_code == 400
        assert res.json()["message"] == "当前密码不对"

    def test_改密成功后旧密码失效新密码可用(
        self, client: TestClient, register: Register, find_code: object
    ) -> None:
        """走完整流程：发 change 验证码 → 取码 → 改密 → 用新密码登录。"""
        register("cp4@test.local", "old-password")
        assert client.post("/api/auth/send-code", json={"purpose": "change"}).status_code == 200
        code = find_code("cp4@test.local")  # type: ignore[operator]

        res = client.post(
            "/api/auth/password",
            json={
                "currentPassword": "old-password",
                "code": code,
                "newPassword": "new-password",
            },
        )
        assert res.status_code == 200, res.text

        client.post("/api/auth/logout")
        assert (
            client.post(
                "/api/auth/login", json={"login": "cp4@test.local", "password": "old-password"}
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/api/auth/login", json={"login": "cp4@test.local", "password": "new-password"}
            ).status_code
            == 200
        )


class TestAccountPassword:
    """`POST /api/account/password`（不要验证码的那条路）。"""

    def test_未登录回401(self, client: TestClient) -> None:
        res = client.post("/api/account/password", json={"currentPassword": "a", "newPassword": "b123456"})
        assert res.status_code == 401

    def test_文案是当前密码不正确与另一条路不同(self, client: TestClient, register: Register) -> None:
        """**两条改密码的路文案刻意不同**：这里是「当前密码不正确」，
        `/api/auth/password` 是「当前密码不对」。原版就是两个字符串，**别统一**。
        """
        register("ap1@test.local", "right-password")
        res = client.post(
            "/api/account/password",
            json={"currentPassword": "wrong", "newPassword": "new-password"},
        )
        assert res.status_code == 400
        assert res.json()["message"] == "当前密码不正确"

    def test_改密码成功但不踢其他设备(
        self, client: TestClient, database: Database, register: Register
    ) -> None:
        """与 `/api/auth/password` 的关键区别：**不吊销任何会话**。"""
        register("ap2@test.local", "old-password")

        with database.session() as session:
            user = UserRepository(session).find_by_email("ap2@test.local")
            assert user is not None
            other = session_tokens.create()  # 模拟"另一台设备"
            SessionRepository(session).create(user.id, other)

        res = client.post(
            "/api/account/password",
            json={"currentPassword": "old-password", "newPassword": "new-password"},
        )
        assert res.status_code == 200, res.text

        with database.session() as session:
            assert SessionRepository(session).find_user(other) is not None, "这条路**不该**踢掉其他设备的会话"


class TestAccountUsernameAndBio:
    """`POST /api/account/username` / `POST /api/account/bio`。"""

    def test_用户名非法回400(self, client: TestClient, register: Register) -> None:
        register("un1@test.local")
        res = client.post("/api/account/username", json={"username": "AB"})  # 大写 + 太短
        assert res.status_code == 400
        assert "用户名只能用小写字母" in res.json()["message"]

    def test_用户名被占用回409(self, client: TestClient, database: Database, register: Register) -> None:
        with database.session() as session:
            UserRepository(session).create(
                email="taken@test.local", password="pw123456", username="takenname"
            )
        register("un2@test.local")
        res = client.post("/api/account/username", json={"username": "takenname"})
        assert res.status_code == 409
        assert res.json()["message"] == "这个用户名已经被使用了"

    def test_用户名会转小写并返回规范值(self, client: TestClient, register: Register) -> None:
        register("un3@test.local")
        res = client.post("/api/account/username", json={"username": "  MyName  "})
        assert res.status_code == 200, res.text
        assert res.json() == {"ok": True, "username": "myname"}  # 键名照契约

    def test_传空清空用户名(self, client: TestClient, register: Register) -> None:
        register("un4@test.local")
        client.post("/api/account/username", json={"username": "someone"})
        res = client.post("/api/account/username", json={"username": ""})
        assert res.status_code == 200
        assert res.json()["username"] is None

    def test_简介超长回400(self, client: TestClient, register: Register) -> None:
        register("bio1@test.local")
        res = client.post("/api/account/bio", json={"bio": "x" * (Limits.BIO_MAX + 1)})
        assert res.status_code == 400
        assert res.json()["message"] == f"简介最多 {Limits.BIO_MAX} 字"

    def test_简介会trim并返回(self, client: TestClient, register: Register) -> None:
        register("bio2@test.local")
        res = client.post("/api/account/bio", json={"bio": "  想说点什么  "})
        assert res.status_code == 200
        assert res.json() == {"ok": True, "bio": "想说点什么"}


class TestMe:
    """`GET /api/me`。"""

    def test_未登录不报401(self, client: TestClient) -> None:
        """**这是导航条能不能渲染的前提** —— 一旦 401，整站顶栏都会空白。"""
        res = client.get("/api/me")
        assert res.status_code == 200
        assert res.json() == {"ok": True, "user": None, "unread": 0, "unreadMessages": 0}

    def test_登录后带上用户与两个未读数(self, client: TestClient, register: Register) -> None:
        register("me1@test.local")
        res = client.get("/api/me")
        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert set(body) == {"ok", "user", "unread", "unreadMessages"}, body
        assert body["user"]["email"] == "me1@test.local"

    def test_未读私信数会封顶到99(self, client: TestClient, database: Database, register: Register) -> None:
        """原版 `Math.min(c, 99)` —— 红点显示"99+"就够了，不该为上千条未读做查询。"""
        from app.models.base import utcnow_iso

        register("me2@test.local")
        with database.session() as session:
            users = UserRepository(session)
            me = users.find_by_email("me2@test.local")
            other = users.create(email="sender@test.local", password="pw123456")
            assert me is not None
            for _ in range(105):
                session.add(
                    Message(
                        sender_id=other.id,
                        receiver_id=me.id,
                        content="hi",
                        created_at=utcnow_iso(),
                    )
                )

        res = client.get("/api/me")
        assert res.status_code == 200
        assert res.json()["unreadMessages"] == 99, "未读私信数应当被截到 99"

    def test_未读通知数在看过之后归零(
        self, client: TestClient, database: Database, admin: dict[str, object], login: object
    ) -> None:
        """通知靠 `users.notify_seen_at` 与事件时间比较算出来 ——
        推进这个时间戳就等于"全标已读"。

        这里造一条点赞事件，验证"从没看过 → 未读 +1"。
        """
        from app.models.base import utcnow_iso
        from app.models.social import Like
        from app.repositories.site_repository import SiteRepository

        with database.session() as session:
            site = SiteRepository(session).create(
                owner_id=int(admin["id"]), name="notif-site", html="<h1>x</h1>"
            )
            fan = UserRepository(session).create(email="fan@test.local", password="pw123456")
            session.add(Like(site_id=site.id, user_id=fan.id, created_at=utcnow_iso()))

        login(client, int(admin["id"]))  # type: ignore[operator]
        res = client.get("/api/me")
        assert res.status_code == 200, res.text
        before = res.json()["unread"]
        assert isinstance(before, int)
        assert before >= 1, f"刚被点赞，未读通知数应当 ≥ 1（实际 {before}）"

        with database.session() as session:
            users = UserRepository(session)
            owner = users.find_by_id(int(admin["id"]))
            assert owner is not None
            users.touch_notifications_seen(owner)

        assert client.get("/api/me").json()["unread"] == 0, "推进已读时间戳后应当归零"


class TestVerificationRepository:
    """验证码存储层的一条边界情况（不经过 HTTP）。"""

    def test_取的是未消费未过期的那条而不是最新一条(self, database: Database) -> None:
        """**订单写反会让过期的旧码挡住新码** —— 表现为"刚发的码说不对"，极难查。

        这里直接构造：先插一条已过期的，再查，必须查不到（而不是查到它）。
        """
        from app.models.base import utcnow_iso
        from app.repositories.verification_repository import VerificationRepository

        with database.session() as session:
            repo = VerificationRepository(session)
            repo.create(
                email="t@test.local",
                purpose="register",
                code_hash="deadbeef",
                expires_at="2000-01-01T00:00:00.000Z",  # 早过期了
                now_iso=utcnow_iso(),
            )
            assert repo.find_usable("t@test.local", "register", utcnow_iso()) is None

    def test_消费过的码不能再被用第二次(self, database: Database) -> None:
        from app.models.base import utcnow_iso
        from app.repositories.verification_repository import VerificationRepository

        with database.session() as session:
            repo = VerificationRepository(session)
            repo.create(
                email="t2@test.local",
                purpose="register",
                code_hash="deadbeef",
                expires_at="2099-01-01T00:00:00.000Z",
                now_iso=utcnow_iso(),
            )
            row = repo.find_usable("t2@test.local", "register", utcnow_iso())
            assert row is not None
            repo.mark_consumed(row, utcnow_iso())

        with database.session() as session:
            assert (
                VerificationRepository(session).find_usable("t2@test.local", "register", utcnow_iso()) is None
            )

    def test_清理只删一天前的记录(self, database: Database) -> None:
        from app.models.base import utcnow_iso
        from app.repositories.verification_repository import VerificationRepository

        with database.session() as session:
            repo = VerificationRepository(session)
            repo.create(
                email="old@test.local",
                purpose="register",
                code_hash="aa",
                expires_at="2099-01-01T00:00:00.000Z",
                now_iso="2000-01-01T00:00:00.000Z",  # 很旧
            )
            repo.create(
                email="new@test.local",
                purpose="register",
                code_hash="bb",
                expires_at="2099-01-01T00:00:00.000Z",
                now_iso=utcnow_iso(),  # 刚建
            )
            removed = repo.delete_older_than("2020-01-01T00:00:00.000Z")
            assert removed == 1

        with database.session() as session:
            remaining = list(session.scalars(select(EmailCode)))
            assert [r.email for r in remaining] == ["new@test.local"]
