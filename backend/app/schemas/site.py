"""站点相关的 DTO。

## ⚠️ 这个文件里有两套命名风格，是**故意的**

同一个后端的两个接口用了不同的命名，而**前端各自依赖**：

| 接口 | 风格 | 前端在哪读 |
|---|---|---|
| `GET /api/sites`、`GET /api/sites/:名字` | **驼峰**（`updatedAt` `totalSize` `fileCount`） | `sites.html` |
| `GET /api/sites/:名字/files` | **蛇形**（`updated_at`） | `site.html` 的 `file.updated_at` |

这是原版的不一致，**不是我的疏漏**。核对过前端源码：
`site.html:320` 读的是 `new Date(file.updated_at)`，
而 `sites.html:109` 读的是 `new Date(site.updatedAt)`。

**别"顺手统一"** —— 统一哪一边都会让另一边白屏，而且不会报错。
"""

from __future__ import annotations

from pydantic import BaseModel

from app.schemas.common import ApiOk
from app.schemas.social import SiteStatsOut

# ---------------------------------------------------------------- 入参
#
# 与 `schemas/auth.py` 同一个理由：入参字段全可选，**校验在 Service 里做**。
# 用 Pydantic 的必填 + 校验器会回 FastAPI 自己的 422 形状，
# 而前端读的是 `{ok, message}` —— 形状不对就是静默白屏。


class UploadIn(BaseModel):
    """`POST /api/upload` 的入参（老的单 HTML 上传入口）。"""

    name: str | None = None
    html: str | None = None


class SaveMetaIn(BaseModel):
    """`PUT /api/sites/:名字/meta` 的入参。"""

    title: str | None = None
    description: str | None = None
    tag: str | None = None


class SaveHtmlIn(BaseModel):
    """`PUT /api/sites/:名字` 的入参（单页站的「保存」）。"""

    html: str | None = None


# ---------------------------------------------------------------- 出参


class TagOut(BaseModel):
    """一个内容标签。前端用它重建「内容标签」下拉框。"""

    key: str
    label: str


class SiteSummary(BaseModel):
    """`GET /api/sites` 列表里的一项（我的站点）。"""

    id: int
    name: str
    title: str
    description: str
    tag: str
    tagLabel: str
    status: str
    kind: str  # 'single' | 'multi'
    fileCount: int
    totalSize: int
    createdAt: str
    updatedAt: str


class MySitesOut(ApiOk):
    """`GET /api/sites` —— 当前用户名下的站点。"""

    sites: list[SiteSummary] = []


class UploadOut(ApiOk):
    """`POST /api/upload` —— **201**，附带可访问的绝对 URL。"""

    name: str
    size: int
    url: str


class SiteDetail(BaseModel):
    """`GET /api/sites/:名字` 里的 `site` 对象。

    单页站带 `html`；多页站的 `html` 是空占位，真实内容在文件列表里
    （`kind` 字段告诉前端该看哪个）。
    """

    id: int
    name: str
    status: str
    kind: str
    fileCount: int
    size: int
    html: str
    title: str
    description: str
    tag: str
    tagLabel: str
    createdAt: str
    updatedAt: str


class SiteDetailOut(ApiOk):
    """`GET /api/sites/:名字`。

    `tags` 是**权威的标签词表**随详情一起下发 —— 前端不该自己存一份，
    原版就是因为前后端各存一份才漂移出 `oss` / `opensource`。
    """

    site: SiteDetail
    tags: list[TagOut] = []


class SaveMetaOut(ApiOk):
    """`PUT /api/sites/:名字/meta` —— 回显保存后的值，前端拿它更新界面。"""

    title: str
    description: str
    tag: str
    tagLabel: str


class SaveHtmlOut(ApiOk):
    """`PUT /api/sites/:名字` —— 回新的字节数。"""

    size: int


class SiteFileItem(BaseModel):
    """文件列表里的一项。

    **`updated_at` 是蛇形，故意的** —— 见模块开头的说明。
    """

    id: int
    path: str
    size: int
    updated_at: str


class SiteFilesOut(ApiOk):
    """`GET /api/sites/:名字/files`。"""

    total: int
    files: list[SiteFileItem] = []


class SiteFileUploadOut(ApiOk):
    """`POST /api/sites/:名字/files` —— 新文件回 **201**，覆盖回 200。"""

    path: str
    size: int


class SiteFileContentOut(ApiOk):
    """`GET /api/sites/:名字/files/content`。

    `binary` 为真时 `content` 是 **base64**，前端只读、不允许编辑
    （用 `content.includes(0)` 加 UTF-8 往返校验判断的，不是看扩展名）。
    """

    path: str
    size: int
    binary: bool
    content: str


class AuthorOut(BaseModel):
    """站点作者。

    `name` 是**展示名**：用户名，没设用户名就用邮箱 `@` 前面的部分。
    `username` 为 `None` 表示这个人没设用户名 —— 前端据此决定能不能点进创作者主页
    （`/u/:username` 需要一个真用户名）。
    """

    id: int
    name: str
    username: str | None = None


class SiteStatsOuter(BaseModel):
    """`GET /api/sites/:名字/stats` 里的 `site` 对象（含作者，观看页一次拿全）。

    `title` 回落到 `name`（站点没设标题时），这样前端不用自己兜底。
    """

    name: str
    title: str
    description: str
    tag: str
    tagLabel: str
    ownerId: int | None = None
    status: str
    author: AuthorOut | None = None


class SiteStatsOut2(ApiOk):
    """`GET /api/sites/:名字/stats` —— 公开接口，带互动数字与站点信息。"""

    stats: SiteStatsOut
    site: SiteStatsOuter


class DiscoverSite(BaseModel):
    """发现流里的一张卡片。

    对应原版 `discoverSites` 的映射结果。`tagLabel` 是**在 handler 里补上的**
    （原版 `handleDiscover` 里 `.map(s => ({...s, tagLabel: tagLabelOf(s.tag)}))`），
    所以它排在最后 —— 顺序不重要，但存在性重要。
    """

    name: str
    title: str
    description: str
    tag: str
    tagLabel: str
    views: int
    likes: int
    comments: int
    favorites: int
    fileCount: int
    kind: str
    updatedAt: str
    author: AuthorOut


class DiscoverOut(ApiOk):
    """`GET /api/discover` —— **公开，不用登录**。

    `total` 是**本次返回的条数**（不是全库总数）—— 原版是
    `sites.length`，而上限是 100。
    """

    total: int = 0
    sites: list[DiscoverSite] = []
