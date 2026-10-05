"""页面路由与用户站点（16 条页面 + 兜底 `/:站名`）。

**这个文件和别的 `api/*.py` 不一样**：它不返回 JSON，而是发 HTML、
或者 302 跳转、或者把用户上传的站点关进沙箱返回。

对应原版 `server.js` 的页面路由段（L330~L436、L1360~L1428、L1740~L1804）。

## 三条必须守住的规则

**1. 用户站点必须带沙箱 CSP。**

```python
SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-downloads ..."
```

**绝不能加 `allow-same-origin`** —— 加了之后用户脚本就能读到平台的 Cookie、
拿到登录态、冒充任何用户。`html` / `htm` / `svg` / `xml` **四种扩展名都要加**，
漏一个就前功尽弃（`<svg><script>` 一样能执行）。

**2. 页面响应带 `Cache-Control: no-store`。**

平台自己的页面里有登录态（顶栏显示谁登录了）。被浏览器缓存住就会出现
"退出登录后还是显示上一个用户"。

**3. `/_assets/` 带 `Cache-Control: no-cache`。**

这个**不能省**：前端改完 `app.js` / `style.css`，用户刷新要立刻看到。
FastAPI 的 `StaticFiles` 默认不发这个头，所以这里用显式路由而不是挂载。

## 注册顺序很关键

`/api/*` → 页面固定路径 → `/_assets/{file}` → **最后**才是 `/{站名}` 兜底。
兜底放最后，平台路由才不会被站名吃掉（原版也是这个顺序）。
"""

from __future__ import annotations

from collections.abc import Callable
from enum import StrEnum
from pathlib import Path

from fastapi import APIRouter, Depends, Response
from fastapi.responses import HTMLResponse, RedirectResponse

from app.core.config import settings
from app.core.deps import get_optional_user, get_site_service
from app.core.routing import CommitBeforeResponseRoute
from app.schemas.user import CurrentUser
from app.services.site_service import SiteService

router = APIRouter(route_class=CommitBeforeResponseRoute, include_in_schema=False)

#: 用户站点的沙箱策略。**绝不含 `allow-same-origin`** —— 见模块开头。
SANDBOX_CSP = (
    "sandbox allow-scripts allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation"
)

#: 能执行脚本的文档类型。**这四种都要关沙箱**，漏一个就前功尽弃。
SANDBOXED_EXTENSIONS = frozenset({".html", ".htm", ".svg", ".xml"})

#: 扩展名 → Content-Type。与原版 `server.js` 的 `MIME_TYPES` 逐条一致，
#: 查不到就回 `application/octet-stream`。
MIME_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml; charset=utf-8",
}


class PagePolicy(StrEnum):
    """页面的访问策略。原版把这段逻辑抄在 16 个几乎一样的函数里。"""

    #: 谁都能看
    PUBLIC = "public"
    #: 未登录 → 302 `/login`
    LOGIN = "login"
    #: 已登录 → 302 `/`（登录页、找回密码页）
    GUEST_ONLY = "guest_only"
    #: 未登录 → 302 `/login`；已登录但非管理员 → **403 页面（不跳转）**
    ADMIN = "admin"


#: 路径 → (HTML 文件名, 访问策略)。**顺序无关**（都是固定路径，不重叠）。
PAGES: dict[str, tuple[str, PagePolicy]] = {
    "/": ("discover.html", PagePolicy.PUBLIC),
    "/notifications": ("notifications.html", PagePolicy.LOGIN),
    "/favorites": ("favorites.html", PagePolicy.LOGIN),
    "/history": ("history.html", PagePolicy.LOGIN),
    "/messages": ("messages.html", PagePolicy.LOGIN),
    "/account": ("account.html", PagePolicy.LOGIN),
    "/sites": ("sites.html", PagePolicy.LOGIN),
    "/settings": ("settings.html", PagePolicy.LOGIN),
    "/admin": ("admin.html", PagePolicy.ADMIN),
    "/login": ("login.html", PagePolicy.GUEST_ONLY),
    "/forgot": ("forgot.html", PagePolicy.GUEST_ONLY),
    # 这两个页面本身是公开的，内容由 `/api/u/:名字/profile` 之类的接口填
    "/u/{username}": ("user.html", PagePolicy.PUBLIC),
    "/view/{site_name}": ("view.html", PagePolicy.PUBLIC),
    "/edit/{site_name}": ("site.html", PagePolicy.LOGIN),
}

#: 老地址 → 新地址的 **302 跳转**（发不出一张页面，只能跳）。
#:
#: `/upload` 原来发的是 `index.html`（整张投稿页）。PR #5 把投稿并进了「创作」页的
#: 「投稿」标签，所以现在只做跳转 —— **保留这个地址是为了老链接不 404**。
#:
#: 这里**刻意不判登录**：跳过去的 `/sites` 自己要求登录，
#: 未登录用户最终仍会被送到登录页，效果与在这里挡一次相同，少一处判断。
#:
#: 注意 `index.html` 现在已经**没有路由指向它**了（PR #5 把它改成了一个会自己
#: `location.replace` 的存根）。它留在 `public/` 里只是为了老书签能打开。
REDIRECTS: dict[str, str] = {
    "/upload": "/sites?tab=upload",
}


# ---------------------------------------------------------------- 响应构造


def message_page(title: str, message: str) -> str:
    """通用的提示页（404 / 403 / 451 / 500）。

    对应原版 `server.js` 的 `messagePage()`。**要转义**：`title` 和 `message`
    里可能出现用户输入（比如站名），不转义就是一个反射型 XSS。
    """
    from html import escape

    return (
        "<!DOCTYPE html>\n"
        '<html lang="zh-CN">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{escape(title)} · MinePage</title>\n"
        '<link rel="stylesheet" href="/_assets/style.css">\n'
        "</head>\n"
        "<body>\n"
        '  <main class="narrow center">\n'
        f"    <h1>{escape(title)}</h1>\n"
        f'    <p class="muted">{escape(message)}</p>\n'
        '    <p><a href="/">回到首页</a></p>\n'
        "  </main>\n"
        "</body>\n"
        "</html>"
    )


def html_response(html: str, status: int = 200, *, no_store: bool = True) -> HTMLResponse:
    """回一段 HTML，带 `nosniff`（原版每个 `sendHtml` 都带）。"""
    headers = {"X-Content-Type-Options": "nosniff"}
    if no_store:
        headers["Cache-Control"] = "no-store"
    return HTMLResponse(content=html, status_code=status, headers=headers)


def redirect(to: str) -> RedirectResponse:
    """302 跳转，固定带 `no-store`。

    原版注释里写明了原因：**避免浏览器把带登录态的跳转缓存住**。
    不加的话，退出登录后点返回可能还能看到上一个用户的页面。
    """
    return RedirectResponse(url=to, status_code=302, headers={"Cache-Control": "no-store"})


def send_page(filename: str, status: int = 200) -> HTMLResponse:
    """读 `public/` 下的页面下发。

    Args:
        filename: 页面文件名，**由上面的 `PAGES` 表硬编码，不来自用户输入**。
        status: HTTP 状态码。

    文件缺失时**降级成一张 500 提示页而不是抛异常** —— 原版就是这么做的，
    服务继续跑，不至于因为少一个 HTML 就整个挂掉。
    """
    path = settings.public_path / filename
    try:
        return html_response(path.read_text(encoding="utf-8"), status)
    except OSError:
        return html_response(message_page("页面文件缺失", "服务器上找不到这个页面。"), 500)


# ---------------------------------------------------------------- 页面路由


def _serve(filename: str, policy: PagePolicy, user: CurrentUser | None) -> Response:
    """按策略决定发页面、跳转、还是回 403。"""
    if policy is PagePolicy.LOGIN and user is None:
        return redirect("/login")

    if policy is PagePolicy.GUEST_ONLY and user is not None:
        return redirect("/")

    if policy is PagePolicy.ADMIN:
        if user is None:
            return redirect("/login")
        if not user.is_admin:
            # **回 403 页面而不是跳转** —— 原版注释：避免"跳回去又被弹回来"的循环
            return html_response(
                message_page("没有权限", "这个页面只有管理员能看。"),
                403,
            )

    return send_page(filename)


def _make_handler(filename: str, policy: PagePolicy) -> Callable[..., Response]:
    """给一个页面造一个路由处理函数。

    16 个页面如果各写一个函数，会有 16 份几乎一样的鉴权分支 —— 改一处必然漏几处。
    这里用一张表 + 一个工厂，**策略只有一份实现**。

    Returns:
        一个签名兼容 FastAPI 的处理函数（`user` 由 `Depends` 注入）。
    """

    def handler(user: CurrentUser | None = Depends(get_optional_user)) -> Response:
        return _serve(filename, policy, user)

    handler.__name__ = f"page_{filename.replace('.', '_')}_{policy.value}"
    handler.__doc__ = f"发 `public/{filename}`（策略：`{policy.value}`）。"
    return handler


for _path, (_filename, _policy) in PAGES.items():
    router.add_api_route(
        _path,
        _make_handler(_filename, _policy),
        methods=["GET"],
        include_in_schema=False,
        name=f"page{_path}",
    )


def _make_redirect_handler(target: str) -> Callable[..., Response]:
    """给每个跳转地址造一个处理器。

    `target` 来自上面的 `REDIRECTS` 常量、**不来自用户输入**，所以直接跳不会有
    开放重定向的问题。绑成默认参数是为了避免闭包晚绑定（循环里所有处理器都指向最后一个）。
    """

    def _handler() -> Response:
        return redirect(target)

    return _handler


for _old, _target in REDIRECTS.items():
    router.add_api_route(
        _old,
        _make_redirect_handler(_target),
        methods=["GET"],
        include_in_schema=False,
        name=f"redirect{_old}",
    )


# ---------------------------------------------------------------- 平台静态资源


@router.get("/_assets/{file}")
def asset(file: str) -> Response:
    """平台自己的静态资源（目前是 `app.js` / `style.css`）。

    路径参数 `{file}` **不含斜杠**，所以 `../` 之类的穿越天然进不来 ——
    原版额外写了一个正则来挡这个，这里由路由形状保证。

    带 `Cache-Control: no-cache`：**刷新就能看到改动**。
    用 `no-cache` 而不是 `no-store`，是因为它允许浏览器缓存但**每次都要回源确认** ——
    既省流量又不会拿到过期的 JS。
    """
    path = settings.public_path / file
    try:
        data = path.read_bytes()
    except OSError:
        return html_response(message_page("404", "找不到这个文件。"), 404)

    return Response(
        content=data,
        media_type=MIME_TYPES.get(Path(file).suffix.lower(), "application/octet-stream"),
        headers={"Cache-Control": "no-cache"},
    )


# ---------------------------------------------------------------- 用户站点（兜底）


def _render_site(site_name: str, rest: str, service: SiteService) -> Response:
    """把 `SiteService` 的解析结果翻成 HTTP 响应。两条站点路由共用这一份。"""
    result = service.resolve(site_name, rest)

    if result.kind == "missing_site":
        return html_response(message_page("404", f'没有找到 "{result.site_name}" 这个页面。'), 404)
    if result.kind == "offline":
        return html_response(message_page("已下线", "这个页面已被管理员下线。"), 451)
    if result.kind == "missing_file":
        return html_response(message_page("404", f"站点里没有这个文件：{result.file_path}"), 404)

    if result.kind == "legacy":
        # 老的单页站：整段 HTML 就是页面内容。
        #
        # ⚠️ **这里必须自己带上沙箱 CSP，不能走 `html_response()`。**
        # 踩过：`_serve_site_file` 里加了沙箱，但这条路径走的是 `html_response`，
        # 于是**用户上传的任意 HTML 裸奔** —— 脚本能读平台 Cookie、冒充任何登录用户。
        # 是 `test_单页站内容会带沙箱CSP` 抓出来的。
        #
        # 头也照原版来：这段用的是 `Cache-Control: no-cache`（不是页面那种 no-store）。
        return HTMLResponse(
            content=result.content.decode("utf-8"),
            status_code=200,
            headers={
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-cache",
                "Content-Security-Policy": SANDBOX_CSP,
            },
        )

    return _serve_site_file(result.file_path, result.content)


# ⚠️ 这两条**必须拆成两个函数**，不能写成一个带默认值 `rest: str = ""` 的函数。
# FastAPI 会把那个带默认值的 `rest` 当成**查询参数**，于是
# `GET /站名?rest=/随便什么路径` 就能改写解析出来的站内路径 ——
# 虽然越不出这个站点自己的文件，但与原版行为不一致，而且是个没必要的口子。
# （这个是靠打印路由的 `dependant.query_params` 发现的，肉眼看签名看不出来。）


@router.get("/{site_name}")
def user_site_root(
    site_name: str,
    service: SiteService = Depends(get_site_service),
) -> Response:
    """`/:站名` —— 用户站点的**入口页**。

    行为（与原版 `handleSite` 一致）：

    | 情况 | 结果 |
    |---|---|
    | 站点不存在 | 404 提示页 |
    | 站点被管理员下线 | **451** 提示页 |
    | 有 `index.html` | 返回内容，**浏览 +1** |
    | 没有 `index.html`，但有老的 `sites.html` 内容 | 回退返回那段 HTML，**浏览 +1** |
    | 两样都没有 | 404 提示页 |

    **浏览计数只在入口页 +1** —— 一个页面里引 10 张图片不该算 10 次浏览。
    没有去重、没有防刷，同一个人刷新也照加（原版就是这么简单）。
    """
    return _render_site(site_name, "", service)


@router.get("/{site_name}/{rest:path}")
def user_site_file(
    site_name: str,
    rest: str,
    service: SiteService = Depends(get_site_service),
) -> Response:
    """`/:站名/站内路径` —— 站内子文件（`css/style.css`、`about.html`、图片…）。

    与入口页的区别：**这条不加浏览量**。

    子路径**不会**回退到老的 `sites.html` 内容 —— 那一段只兜入口页
    （原版注释里明确写了，`/站名/css/style.css` 绝不会去 `sites.html` 里找）。
    """
    return _render_site(site_name, rest, service)


def _serve_site_file(file_path: str, content: bytes) -> Response:
    """下发一个站点文件。

    **文档类型加沙箱 CSP** —— `html` / `htm` / `svg` / `xml` 都能带脚本执行，
    只挡 `.html` 是不够的。
    """
    suffix = Path(file_path).suffix.lower()
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
    }
    if suffix in SANDBOXED_EXTENSIONS:
        headers["Content-Security-Policy"] = SANDBOX_CSP

    return Response(
        content=content,
        media_type=MIME_TYPES.get(suffix, "application/octet-stream"),
        headers=headers,
    )
