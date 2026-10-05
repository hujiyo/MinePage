#!/usr/bin/env python
r"""上传 → 显示 → 管理 → 权限，这条主链路的端到端验证。

**为什么要单独写这个脚本**：接口"能返回 200"和"这条链路是通的"是两回事。
这个脚本按真实用户的操作顺序走一遍，并且**专门验权限矩阵** ——
A 的站点，B 能不能看、能不能改、能不能删；管理员能不能。

用 `httpx` 打真实运行中的后端（不是 TestClient），所以它验的是**部署后的真实行为**。

用法：
  .venv\Scripts\python.exe tools/verify_upload_chain.py [baseUrl]

约定：脚本会自己建临时站点、跑完删掉，**不动库里已有的数据**。
"""

from __future__ import annotations

import sys
import uuid

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"

#: 通过项的名字。最后汇总时只打印失败清单 —— 通过的不刷屏。
PASS: list[str] = []
#: 失败项的名字。
FAIL: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    """记一条验证结果并立刻打印。

    Args:
        name: 这条验证在说什么（会出现在失败汇总里，所以要写清楚）。
        ok: 是否通过。
        detail: 补充信息（状态码、实际值…），失败时尤其有用。
    """
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  — {detail}" if detail else ""))


def login(email: str, password: str) -> httpx.Client:
    """登录并返回带着会话 Cookie 的客户端。

    Args:
        email: 账号邮箱。
        password: 明文密码。

    Returns:
        已持有 `mp_session` Cookie 的客户端，后续请求都用它发。
    """
    c = httpx.Client(base_url=BASE, timeout=15)
    r = c.post("/api/auth/login", json={"login": email, "password": password})
    assert r.status_code == 200, f"{email} 登录失败：{r.status_code} {r.text}"
    return c


def main() -> int:
    """跑完八组验证，返回进程退出码（0 = 全过）。

    顺序按**真实用户的操作顺序**排：上传 → 显示 → 管理 → 权限 → 移除。
    每一步都建在临时站点上（`chain-<随机>`），跑完删掉，不动库里已有的数据。

    Returns:
        `0` 全过；`1` 有失败项（失败清单已打印）。
    """
    name = "chain-" + uuid.uuid4().hex[:8]  # 每次跑用不同站名，避免撞已有数据

    owner = login("owner@test.local", "pw123456")
    other = login("verify@test.local", "pw123456")
    admin = login("admin@minepage.local", "123")
    anon = httpx.Client(base_url=BASE, timeout=15)

    print("═══ 1. 上传（A 建站） ═══\n")
    r = owner.post(
        "/api/upload",
        json={"name": name, "html": "<h1>链路验证页</h1><p>hello</p>"},
    )
    check("POST /api/upload 回 201", r.status_code == 201, f"{r.status_code}")
    body = r.json()
    check(
        "响应带可访问的绝对 URL",
        isinstance(body.get("url"), str) and name in body["url"],
        body.get("url", ""),
    )
    check("响应带字节数", isinstance(body.get("size"), int) and body["size"] > 0, str(body.get("size")))

    print("\n═══ 2. 显示（网页真的能打开） ═══\n")
    r = anon.get(f"/{name}")
    check("匿名访问 /站名 回 200", r.status_code == 200, f"{r.status_code}")
    check("页面内容就是上传的 HTML", "链路验证页" in r.text)
    check(
        "带沙箱 CSP（用户脚本关在框里）",
        "sandbox" in r.headers.get("content-security-policy", ""),
        r.headers.get("content-security-policy", "(没有这个头)")[:60],
    )
    check("没有 allow-same-origin", "allow-same-origin" not in r.headers.get("content-security-policy", ""))
    check("带 nosniff", r.headers.get("x-content-type-options") == "nosniff")

    print("\n═══ 3. 管理（A 自己的站点） ═══\n")
    r = owner.get("/api/sites")
    check(
        "GET /api/sites 能看到刚建的站",
        r.status_code == 200 and any(s["name"] == name for s in r.json()["sites"]),
    )
    r = owner.get(f"/api/sites/{name}")
    check("GET 详情回 200", r.status_code == 200)
    check(
        "详情里 kind 是 single",
        r.json().get("site", {}).get("kind") == "single",
        str(r.json().get("site", {}).get("kind")),
    )
    check("详情带权威标签词表", len(r.json().get("tags", [])) == 8, f"{len(r.json().get('tags', []))} 个标签")
    r = owner.put(f"/api/sites/{name}", json={"html": "<h1>改过了</h1>"})
    check("PUT 改内容回 200", r.status_code == 200)
    check("改完之后页面内容跟着变", "改过了" in anon.get(f"/{name}").text)
    r = owner.put(f"/api/sites/{name}/meta", json={"title": "链路验证", "description": "说明", "tag": "blog"})
    check("PUT meta 回 200", r.status_code == 200)
    check("meta 回显 tagLabel", r.json().get("tagLabel") == "技术博客", str(r.json().get("tagLabel")))

    print("\n═══ 4. 权限矩阵（B 想动 A 的站点） ═══\n")
    r = other.get(f"/api/sites/{name}")
    check("B 看 A 的详情 → 403", r.status_code == 403, f"{r.status_code} {r.json().get('message', '')}")
    r = other.put(f"/api/sites/{name}", json={"html": "<h1>被黑了</h1>"})
    check("B 改 A 的内容 → 403", r.status_code == 403, f"{r.status_code}")
    r = other.put(f"/api/sites/{name}/meta", json={"title": "x", "description": "", "tag": ""})
    check("B 改 A 的元信息 → 403", r.status_code == 403, f"{r.status_code}")
    r = other.delete(f"/api/sites/{name}")
    check("B 删 A 的站点 → 403", r.status_code == 403, f"{r.status_code}")
    r = other.get(f"/api/sites/{name}/files")
    check("B 看 A 的文件列表 → 403", r.status_code == 403, f"{r.status_code}")
    r = other.post(f"/api/sites/{name}/files?path=evil.html", content=b"<h1>evil</h1>")
    check("B 往 A 的站点传文件 → 403", r.status_code == 403, f"{r.status_code}")
    check("B 的操作确实没生效", "被黑了" not in anon.get(f"/{name}").text)

    r = other.get("/api/sites")
    check("B 的站点列表里没有 A 的站", not any(s["name"] == name for s in r.json()["sites"]))

    print("\n═══ 5. 权限矩阵（管理员） ═══\n")
    r = admin.get(f"/api/sites/{name}")
    check("管理员看 A 的详情 → 200", r.status_code == 200, f"{r.status_code}")
    r = admin.put(f"/api/sites/{name}/meta", json={"title": "管理员改的", "description": "", "tag": ""})
    check("管理员改 A 的元信息 → 200", r.status_code == 200, f"{r.status_code}")

    print("\n═══ 6. 未登录 ═══\n")
    check(
        "匿名上传 → 401",
        anon.post("/api/upload", json={"name": "x" * 5, "html": "<h1>x</h1>"}).status_code == 401,
    )
    check("匿名看列表 → 401", anon.get("/api/sites").status_code == 401)
    check("匿名删 → 401", anon.delete(f"/api/sites/{name}").status_code == 401)

    print("\n═══ 7. 参数校验 ═══\n")
    check(
        "站名太短 → 400",
        owner.post("/api/upload", json={"name": "ab", "html": "<h1>x</h1>"}).status_code == 400,
    )
    check(
        "站名是大写 → 会被规范化（不报错）",
        owner.post("/api/upload", json={"name": name.upper(), "html": "<h1>x</h1>"}).status_code == 409,
        "同名已存在应为 409",
    )
    check(
        "内容为空 → 400",
        owner.post("/api/upload", json={"name": "empty-" + uuid.uuid4().hex[:6], "html": "  "}).status_code
        == 400,
    )
    check(
        "重名 → 409", owner.post("/api/upload", json={"name": name, "html": "<h1>x</h1>"}).status_code == 409
    )
    check(
        "保留字 → 400",
        owner.post("/api/upload", json={"name": "admin", "html": "<h1>x</h1>"}).status_code == 400,
    )
    big = "<h1>" + "x" * (2 * 1024 * 1024) + "</h1>"
    check(
        "超过 2MB → 413",
        owner.post("/api/upload", json={"name": "big-" + uuid.uuid4().hex[:6], "html": big}).status_code
        == 413,
    )

    print("\n═══ 8. 写后立刻读（提交时序竞态） ═══\n")

    # 为什么单列一组：**这个 bug 用 pytest 测不出来**。
    #
    # `TestClient` 是同步顺序的，一个请求（含依赖 teardown）跑完才返回下一个，
    # 所以"响应发出"和"提交落库"之间的窗口被压成了零。而这个脚本打的是**真实 uvicorn**，
    # 背靠背发两个请求就能撞上那个窗口。
    #
    # 症状：写接口回 200（甚至带了新值），但紧接着的读请求拿到旧值。
    # 历史事故：点「封禁」成功 → 该用户立刻还能登录；点「下线」成功 → 站点立刻还能访问。
    #
    # 这里连做 5 轮 —— 单轮有偶然性，5 轮都过才算真的修好了。
    print("  连做 5 轮「改内容 → 立刻读」：")
    stale = 0
    for i in range(5):
        marker = f"<h1>第{i}轮 {uuid.uuid4().hex[:6]}</h1>"
        owner.put(f"/api/sites/{name}", json={"html": marker})
        # **中间不加任何 sleep** —— 要的就是背靠背
        got = anon.get(f"/{name}").text
        if marker not in got:
            stale += 1
            print(f"    第 {i + 1} 轮: ✗ 读到旧内容（提交落在响应之后？）")
    check(f"改完立刻读，5 轮都读到新内容（实际读到旧值 {stale} 次）", stale == 0)

    print("\n  再做 5 轮「封禁 → 立刻登录」：")
    target = next(
        (u for u in admin.get("/api/admin/users").json()["users"] if u["email"] == "verify@test.local"),
        None,
    )
    if target is None:
        check("找到用于封禁测试的账号", False, "verify@test.local 不在用户表里")
    else:
        leak = 0
        for i in range(5):
            admin.post(f"/api/admin/users/{target['id']}/status", json={"status": "banned"})
            fresh = httpx.Client(base_url=BASE, timeout=15)
            code = fresh.post(
                "/api/auth/login", json={"login": "verify@test.local", "password": "pw123456"}
            ).status_code
            if code != 403:
                leak += 1
                print(f"    第 {i + 1} 轮: ✗ 被封的人还能登录（回了 {code}）")
            admin.post(f"/api/admin/users/{target['id']}/status", json={"status": "active"})
        check(f"封完立刻登录，5 轮都是 403（实际漏了 {leak} 次）", leak == 0)

    print("\n═══ 9. 移除（删除后真的没了） ═══\n")
    r = owner.delete(f"/api/sites/{name}")
    check("DELETE 回 200", r.status_code == 200, f"{r.status_code}")
    check("删完 /站名 → 404", anon.get(f"/{name}").status_code == 404)
    check("删完详情 → 404", owner.get(f"/api/sites/{name}").status_code == 404)
    check("删完不在列表里", not any(s["name"] == name for s in owner.get("/api/sites").json()["sites"]))
    check("再删一次 → 404（不是幂等 200）", owner.delete(f"/api/sites/{name}").status_code == 404)

    print("\n" + "═" * 46)
    print(f"  通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("\n  失败项：")
        for f in FAIL:
            print("    ✗ " + f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
