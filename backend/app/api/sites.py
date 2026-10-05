"""站点接口（11 条）。

契约对照 **`docs/rewrite/rewrite-contract.md`**：

| 方法 | 路径 | 鉴权 | 关键点 |
|---|---|---|---|
| GET | `/api/sites` | 登录 | 我的站点列表，带 `kind` / `fileCount` / `totalSize` |
| POST | `/api/upload` | 登录 | 单页站上传（**JSON**），成功回 **201** + 绝对 URL |
| GET | `/api/sites/:名字` | 登录+属主 | 详情，多页站带 `tags` 词表 |
| PUT | `/api/sites/:名字` | 登录+属主 | 保存单页站 HTML |
| PUT | `/api/sites/:名字/meta` | 登录+属主 | 标题 / 简介 / 标签 |
| DELETE | `/api/sites/:名字` | 登录+属主 | 删站（文件级联删） |
| GET | `/api/sites/:名字/files` | 登录 | 文件列表（**`updated_at` 蛇形**） |
| POST | `/api/sites/:名字/files` | 登录 | **裸 body** 上传文件；站点不存在会自动建 |
| GET | `/api/sites/:名字/files/content` | 登录+属主 | 读文件内容（二进制回 base64） |
| DELETE | `/api/sites/:名字/files` | 登录+属主 | 删文件 |
| GET | `/api/sites/:名字/stats` | 公开 | 互动数字 + 站点与作者（**不用登录**） |

## 两个容易写错的地方

**1. `POST /api/sites/:名字/files` 的 body 是裸字节，不是 JSON。**

前端 `site.html` 两处都是直接 `body: <内容>` ——
L411 发字符串（在线编辑器保存），L462 发 `await file.arrayBuffer()`（选文件上传）。
所以这里用 `Body(...)` 收原始字节，**不能用 Pydantic 模型**。

**2. 文件列表的键是蛇形 `updated_at`。**

同一个文件里其它接口都是驼峰。这是原版的不一致，前端 `site.html:320` 读的就是
`file.updated_at`。详见 `schemas/site.py` 开头的说明。
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query, Request, Response

from app.core.config import SiteTags
from app.core.deps import (
    get_optional_user,
    get_site_manage_service,
    get_site_service,
    require_user,
)
from app.core.routing import CommitBeforeResponseRoute
from app.schemas.common import ApiOk
from app.schemas.site import (
    MySitesOut,
    SaveHtmlIn,
    SaveHtmlOut,
    SaveMetaIn,
    SaveMetaOut,
    SiteDetailOut,
    SiteFileContentOut,
    SiteFilesOut,
    SiteFileUploadOut,
    SiteStatsOut2,
    TagOut,
    UploadIn,
    UploadOut,
)
from app.schemas.user import CurrentUser
from app.services.site_manage_service import SiteManageService
from app.services.site_service import SiteService

router = APIRouter(route_class=CommitBeforeResponseRoute, tags=["sites"])


# ---------------------------------------------------------------- 我的站点


@router.get("/api/sites", response_model=MySitesOut)
def my_sites(
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> MySitesOut:
    """当前用户名下的全部站点，新的在前。

    `kind` 由文件数反推：有文件就是 `multi`，否则 `single`。
    `totalSize` = 入口文件大小 + 全部附件大小之和。
    """
    return MySitesOut(sites=service.list_mine(user.id))


@router.post("/api/upload", response_model=UploadOut, status_code=201)
def upload(
    payload: UploadIn,
    request: Request,
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> UploadOut:
    """上传一个单页站。**成功回 201**，并附上可以直接发给用户的绝对地址。

    校验顺序：站名 → 有没有内容 → 体积 → 建站。
    """
    site = service.create_single(owner_id=user.id, name=payload.name, html=payload.html)
    origin = str(request.base_url).rstrip("/")
    return UploadOut(name=site.name, size=site.size, url=f"{origin}/{site.name}")


# ---------------------------------------------------------------- 详情与修改


@router.get("/api/sites/{name}", response_model=SiteDetailOut)
def site_detail(
    name: str,
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> SiteDetailOut:
    """站点详情。

    响应里**带上完整的标签词表**（`tags`）—— 前端用它重建「内容标签」下拉框。
    原版就是因为前后端各存一份词表才漂移出 `oss` / `opensource`，
    所以这里由服务端下发权威版本。
    """
    detail = service.detail(owner_id=user.id, is_admin=user.is_admin, name=name)
    tags = [TagOut(key=key, label=label) for key, label in SiteTags.TAGS]
    return SiteDetailOut(site=detail, tags=tags)


@router.put("/api/sites/{name}", response_model=SaveHtmlOut)
def save_html(
    name: str,
    payload: SaveHtmlIn,
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> SaveHtmlOut:
    """保存单页站的 HTML。

    **多页站会被拒**（400「这是多页站点，请到下方文件列表里编辑单个文件」）——
    否则一次保存会把整个多页站的内容覆盖掉。
    """
    size = service.save_html(owner_id=user.id, is_admin=user.is_admin, name=name, html=payload.html)
    return SaveHtmlOut(size=size)


@router.put("/api/sites/{name}/meta", response_model=SaveMetaOut)
def save_meta(
    name: str,
    payload: SaveMetaIn,
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> SaveMetaOut:
    """保存标题 / 简介 / 内容标签。回显保存后的值，前端拿它更新界面。"""
    title, description, tag = service.save_meta(
        owner_id=user.id,
        is_admin=user.is_admin,
        name=name,
        title=payload.title,
        description=payload.description,
        tag=payload.tag,
    )
    return SaveMetaOut(title=title, description=description, tag=tag, tagLabel=SiteTags.label_of(tag))


@router.delete("/api/sites/{name}", response_model=ApiOk)
def delete_site(
    name: str,
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> ApiOk:
    """删除整个站点。站点下的文件由外键 `ON DELETE CASCADE` 连带清掉。"""
    service.delete(owner_id=user.id, is_admin=user.is_admin, name=name)
    return ApiOk()


# ---------------------------------------------------------------- 文件


@router.get("/api/sites/{name}/files", response_model=SiteFilesOut)
def list_files(
    name: str,
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> SiteFilesOut:
    """列出站点里的文件（不含内容）。

    **`updated_at` 是蛇形键**，与同文件其它接口的驼峰不一致 —— 前端读的就是它。
    """
    total, files = service.list_files(owner_id=user.id, is_admin=user.is_admin, name=name)
    return SiteFilesOut(total=total, files=files)


@router.post("/api/sites/{name}/files", response_model=SiteFileUploadOut)
def upload_file(
    name: str,
    response: Response,
    path: str = Query(..., description="站内路径，如 index.html"),
    content: bytes = Body(..., description="文件原始字节，**不是 JSON**"),
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> SiteFileUploadOut:
    """上传或覆盖一个站点文件。

    **body 是裸字节**（前端的在线编辑器发字符串，选文件上传发 `arrayBuffer`），
    所以这里收 `bytes` 而不是 Pydantic 模型。

    新文件回 **201**、覆盖已有的回 **200** —— 状态码不同是因为前端要靠它
    区分"新建"与"更新"的提示文案。
    装饰器上写死的状态码只能是其中之一，所以这里用 `response.status_code` 动态设。
    """
    saved_path, size, is_new = service.upload_file(
        owner_id=user.id,
        is_admin=user.is_admin,
        name=name,
        path=path,
        content=content,
    )
    response.status_code = 201 if is_new else 200
    return SiteFileUploadOut(path=saved_path, size=size)


@router.get("/api/sites/{name}/files/content", response_model=SiteFileContentOut)
def file_content(
    name: str,
    path: str = Query(..., description="站内路径"),
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> SiteFileContentOut:
    """读一个文件的内容（给在线编辑器用）。

    `binary` 为真时 `content` 是 **base64**，前端只读、不允许编辑。
    判定用的是**内容**（有没有 `0x00`、UTF-8 往返是否相等），不是扩展名。
    """
    file_path, size, binary, content = service.read_file(
        owner_id=user.id, is_admin=user.is_admin, name=name, path=path
    )
    return SiteFileContentOut(path=file_path, size=size, binary=binary, content=content)


@router.delete("/api/sites/{name}/files", response_model=ApiOk)
def delete_file(
    name: str,
    path: str = Query(..., description="站内路径"),
    user: CurrentUser = Depends(require_user),
    service: SiteManageService = Depends(get_site_manage_service),
) -> ApiOk:
    """删掉站点里的一个文件。文件不存在回 404（原版就是这样，不是幂等成功）。"""
    service.delete_file(owner_id=user.id, is_admin=user.is_admin, name=name, path=path)
    return ApiOk()


# ---------------------------------------------------------------- 公开


@router.get("/api/sites/{name}/stats", response_model=SiteStatsOut2)
def site_stats(
    name: str,
    viewer: CurrentUser | None = Depends(get_optional_user),
    service: SiteService = Depends(get_site_service),
) -> SiteStatsOut2:
    """互动数字 + 站点与作者信息（观看包装页一次请求拿全）。

    **公开接口，不用登录** —— 未登录时 `liked` / `favorited` 都是 `false`。

    **不校验站点状态**：已下线的站点仍然能看统计，只有"新增互动"才挡（回 451）。
    """
    stats, site = service.stats(name, viewer.id if viewer else None)
    return SiteStatsOut2(stats=stats, site=site)
