"""站点的属主侧操作（增删改查自己的站点）。

和 `site_service.py` 的分工：

| 服务 | 面向谁 | 干什么 |
|---|---|---|
| `SiteService` | **公开访客** | 解析 `/:站名` 要发什么、算互动数字 |
| `SiteManageService`（本文件） | **站点属主** | 我的站点列表、建站、改内容、改元信息、删站、文件管理 |

对应原版 `server.js` L763~L1086 那一批 `handleMySites` / `handleUpload` /
`handleSite*`（本站点域的管理部分）。

## 三处必须照抄的细节

**1. 报错文案各不相同，且都是给用户看的。**

「没有拿到文件内容」「文件太大了，单个文件上限 2 MB」「这是多页站点，请到下方文件列表里编辑单个文件」
—— 这些直接显示在页面上，改一个字就是改界面。

**2. 多文件上传会"顺带建站"。**

`POST /api/sites/:名字/files` 在站点不存在时**自动创建**一个空站点（入口页待补）。
这是原版行为，前端的多页站上传流程依赖它。

**3. 二进制判定不是看扩展名。**

`content.includes(0) || UTF-8 往返不相等` —— 用内容判断。
所以一个叫 `.txt` 的文件里塞了字节 `0x00` 也会被标成 `binary`。
"""

from __future__ import annotations

from app.core.config import (
    NAME_PATTERN,
    PATH_SEGMENT_PATTERN,
    RESERVED,
    Limits,
    SiteTags,
)
from app.core.exceptions import Conflict, Forbidden, NotFound, PayloadTooLarge, ValidationError
from app.models.site import Site
from app.repositories.site_file_repository import SiteFileRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.site import SiteDetail, SiteFileItem, SiteSummary


def check_name(raw: str | None) -> str:
    """校验站名，返回规范化后的结果（去空格 + 转小写）。

    对应原版 `lib/names.js` 的 `checkName`。**调用方必须用返回值**，
    而不是原始的 `raw` —— 用户可能敲了大写或带空格。

    Args:
        raw: 用户输入的站名。

    Returns:
        规范化后的站名。

    Raises:
        ValidationError: 各种不合法情况。**文案可以直接展示给用户**，
            所以四种情况的措辞各不相同（原版就是这样，别统一成"站名不合法"）。
    """
    if raw is None or str(raw).strip() == "":
        raise ValidationError("请填写名字")

    name = str(raw).strip().lower()

    if len(name) < Limits.NAME_MIN:
        raise ValidationError(f"名字至少 {Limits.NAME_MIN} 个字符")
    if len(name) > Limits.NAME_MAX:
        raise ValidationError(f"名字最多 {Limits.NAME_MAX} 个字符")
    if not NAME_PATTERN.match(name):
        raise ValidationError("只能用英文小写字母、数字和连字符，且不能以连字符开头或结尾")
    if name in RESERVED:
        raise ValidationError(f'"{name}" 是平台保留的名字，换一个吧')

    return name


def is_valid_site_path(path: str | None) -> bool:
    """站内路径是否合法。

    规则（与原版 `lib/sites.js` 的 `isValidSitePath` 一致）：

    * 非空、长度 ≤ 200
    * 不能以 `/` 开头、不能含反斜杠（挡住绝对路径与 Windows 分隔符）
    * 每一段都要过 `PATH_SEGMENT_PATTERN`，且不能是 `.` 或 `..`

    Args:
        path: 站内路径，如 `css/style.css`。
    """
    if not isinstance(path, str):
        return False
    if not path or len(path) > 200:
        return False
    if path.startswith("/") or "\\" in path:
        return False
    return all(
        segment not in (".", "..") and PATH_SEGMENT_PATTERN.match(segment) for segment in path.split("/")
    )


class SiteManageService:
    """属主侧的站点操作。"""

    def __init__(self, sites: SiteRepository, files: SiteFileRepository) -> None:
        """组装站点管理服务。

        Args:
            sites: 站点仓储。
            files: 站点文件仓储。
        """
        self._sites = sites
        self._files = files

    # ---------------------------------------------------------------- 我的站点

    def list_mine(self, owner_id: int) -> list[SiteSummary]:
        """当前用户名下的全部站点。

        Args:
            owner_id: 属主主键。

        Returns:
            新的在前。`kind` 由文件数反推（`multi` / `single`），
            `totalSize` = 入口文件大小 + 全部附件大小之和。
        """
        rows = self._sites.list_owned_with_stats(owner_id)
        return [
            SiteSummary(
                id=site.id,
                name=site.name,
                title=site.title,
                description=site.description,
                tag=site.tag,
                tagLabel=SiteTags.label_of(site.tag),
                status=site.status,
                kind="multi" if file_count > 0 else "single",
                fileCount=file_count,
                totalSize=(site.size or 0) + file_size,
                createdAt=site.created_at,
                updatedAt=site.updated_at,
            )
            for site, file_count, file_size in rows
        ]

    # ---------------------------------------------------------------- 建站（单页）

    def create_single(self, *, owner_id: int, name: str | None, html: str | None) -> Site:
        """建一个单页站（老的上传入口）。

        Args:
            owner_id: 属主主键。
            name: 站名，会过 `check_name`。
            html: 整段 HTML。

        Returns:
            新建的站点实体。

        Raises:
            ValidationError: 站名不合法，或 HTML 不是非空字符串（400）。
            PayloadTooLarge: 超过 `Limits.MAX_HTML_BYTES`（413）。
            Conflict: 站名已被占用（409）。

        **注意校验顺序**：先站名 → 再"有没有内容" → 再体积 → 最后才建站。
        顺序反了会在用户还没填名字时就报"文件太大"。
        """
        checked = check_name(name)

        if not isinstance(html, str) or html.strip() == "":
            raise ValidationError("没有拿到文件内容")
        if len(html.encode("utf-8")) > Limits.MAX_HTML_BYTES:
            raise PayloadTooLarge("文件太大了，单个文件上限 2 MB")

        if self._sites.find_by_name(checked) is not None:
            raise Conflict("这个站点名字已经被使用了")

        return self._sites.create(owner_id=owner_id, name=checked, html=html)

    # ---------------------------------------------------------------- 详情 / 改

    def detail(self, *, owner_id: int, is_admin: bool, name: str) -> SiteDetail:
        """取站点详情（单页站带 `html`，多页站带文件数）。

        Raises:
            NotFound: 没有这个站点（404）。
            Forbidden: 不是属主也不是管理员（403）。
        """
        site, file_count = self._owned_site(owner_id=owner_id, is_admin=is_admin, name=name)
        return SiteDetail(
            id=site.id,
            name=site.name,
            status=site.status,
            kind="multi" if file_count > 0 else "single",
            fileCount=file_count,
            size=site.size,
            html=site.html,
            title=site.title,
            description=site.description,
            tag=site.tag,
            tagLabel=SiteTags.label_of(site.tag),
            createdAt=site.created_at,
            updatedAt=site.updated_at,
        )

    def save_html(self, *, owner_id: int, is_admin: bool, name: str, html: str | None) -> int:
        """保存单页站的 HTML，返回新的字节数。

        Raises:
            ValidationError: 这是多页站（400，文案指引用户去文件列表），
                或者内容是空的。
            PayloadTooLarge: 超过 2 MB（413）。
        """
        site, file_count = self._owned_site(owner_id=owner_id, is_admin=is_admin, name=name)

        if file_count > 0:
            raise ValidationError("这是多页站点，请到下方文件列表里编辑单个文件")

        value = str(html or "")
        if value.strip() == "":
            raise ValidationError("内容是空的")
        if len(value.encode("utf-8")) > Limits.MAX_HTML_BYTES:
            raise PayloadTooLarge("文件太大了，单个文件上限 2 MB")

        self._sites.set_html(site, value)
        return len(value.encode("utf-8"))

    def save_meta(
        self,
        *,
        owner_id: int,
        is_admin: bool,
        name: str,
        title: str | None,
        description: str | None,
        tag: str | None,
    ) -> tuple[str, str, str]:
        """保存标题 / 简介 / 内容标签，返回 trim 后的三元组。

        Raises:
            ValidationError: 标题超长 / 简介超长 / 标签不在词表里（400）。
        """
        site, _ = self._owned_site(owner_id=owner_id, is_admin=is_admin, name=name)

        title_value = str(title or "").strip()
        desc_value = str(description or "").strip()
        tag_value = str(tag or "").strip()

        if len(title_value) > Limits.SITE_TITLE_MAX:
            raise ValidationError(f"站点标题最多 {Limits.SITE_TITLE_MAX} 字")
        if len(desc_value) > Limits.SITE_DESC_MAX:
            raise ValidationError(f"站点简介最多 {Limits.SITE_DESC_MAX} 字")
        if not SiteTags.is_valid(tag_value):
            raise ValidationError("内容标签不对")

        self._sites.set_meta(site, title=title_value, description=desc_value, tag=tag_value)
        return title_value, desc_value, tag_value

    def delete(self, *, owner_id: int, is_admin: bool, name: str) -> None:
        """删除整个站点。文件由外键 `ON DELETE CASCADE` 连带清掉。

        Raises:
            NotFound / Forbidden: 同 `detail`。
        """
        site, _ = self._owned_site(owner_id=owner_id, is_admin=is_admin, name=name)
        self._sites.delete(site)

    # ---------------------------------------------------------------- 文件

    def list_files(self, *, owner_id: int, is_admin: bool, name: str) -> tuple[int, list[SiteFileItem]]:
        """列出一个站点的文件（不含内容）。

        Returns:
            `(总数, 文件项列表)`。**`updated_at` 是蛇形键** —— 前端 `site.html`
            读的就是它（见 `schemas/site.py` 开头的说明）。

        Raises:
            NotFound: 没有这个站点（404）。
            Forbidden: 不是属主也不是管理员（403）。
                **注意这里与 `detail` 的文案不同**：「只能查看自己的站点」。
        """
        site = self._sites.find_by_name(name)
        if site is None:
            raise NotFound("没有这个站点")
        if site.owner_id != owner_id and not is_admin:
            raise Forbidden("只能查看自己的站点")

        rows = self._files.list_paths(site.id)
        items = [
            SiteFileItem(id=row.id, path=row.path, size=row.size, updated_at=row.updated_at) for row in rows
        ]
        return len(items), items

    def upload_file(
        self,
        *,
        owner_id: int,
        is_admin: bool,
        name: str,
        path: str | None,
        content: bytes,
    ) -> tuple[str, int, bool]:
        """上传或覆盖一个站点文件。

        **站点不存在时会自动创建一个空站点** —— 这是原版行为，多页站的上传流程依赖它
        （先传 `index.html`，站点随之出现）。

        Args:
            owner_id: 属主主键。
            is_admin: 是否管理员（管理员可以改别人的站点）。
            name: 站名。
            path: 站内路径（来自 `?path=`）。
            content: 文件原始字节。

        Returns:
            `(path, size, is_new_file)` —— `is_new_file` 决定回 201 还是 200。

        Raises:
            ValidationError: 站名不合法 / 缺 `?path=` / 路径不合法 / 内容是空的（400）。
            PayloadTooLarge: 超过 `Limits.MAX_FILE_BYTES`（413）。
            Forbidden: 站名已被别人占用（403）。
            Conflict: 文件数到上限（409）。**只在新文件时判**，覆盖已有路径不受影响。
        """
        checked = check_name(name)

        if not path:
            raise ValidationError("缺少 ?path= 参数")
        if not is_valid_site_path(path):
            raise ValidationError("文件路径不合法")

        site = self._sites.find_by_name(checked)
        if site is None:
            # 站名可能被别人的站点占用（find_by_name 已经查过，这里是并发下的兜底）
            site = self._create_or_conflict(checked, owner_id)

        if site.owner_id != owner_id and not is_admin:
            raise Forbidden("只能操作自己的站点")

        if len(content) == 0:
            raise ValidationError("文件内容是空的")
        if len(content) > Limits.MAX_FILE_BYTES:
            raise PayloadTooLarge("文件太大了，单个文件上限 10 MB")

        is_new = not self._files.exists(site.id, path)
        if is_new and self._files.count(site.id) >= Limits.MAX_FILES_PER_SITE:
            raise Conflict(f"站点文件太多啦，上限 {Limits.MAX_FILES_PER_SITE} 个")

        self._files.upsert(site.id, path, content)
        # 写文件也要刷新站点的 updated_at，让它在「最近更新」里冒头
        # （原版这点是对称的：写文件会刷，但删文件和改元信息不刷 —— 见 N9）
        self._sites.touch(site)
        return path, len(content), is_new

    def _create_or_conflict(self, name: str, owner_id: int) -> Site:
        """建一个空站点（多页站的占位）。名字被占用时抛 409。"""
        existing = self._sites.find_by_name(name)
        if existing is not None:
            return existing
        return self._sites.create(owner_id=owner_id, name=name, html="")

    def read_file(
        self, *, owner_id: int, is_admin: bool, name: str, path: str | None
    ) -> tuple[str, int, bool, str]:
        """读一个站点文件的内容（给编辑页用）。

        Returns:
            `(path, size, binary, content)` —— `binary` 为真时 `content` 是 base64。

        Raises:
            ValidationError: 路径不合法（400）。
            NotFound: 站点或文件不存在（404）。
            Forbidden: 不是属主也不是管理员（403）。
        """
        site, _ = self._owned_site(owner_id=owner_id, is_admin=is_admin, name=name)

        if not path or not is_valid_site_path(path):
            raise ValidationError("文件路径不合法")

        raw = self._files.get_content(site.id, path)
        if raw is None:
            raise NotFound("站点里没有这个文件")

        binary = _looks_binary(raw)
        content = base64_encode(raw) if binary else raw.decode("utf-8", errors="replace")
        return path, len(raw), binary, content

    def delete_file(self, *, owner_id: int, is_admin: bool, name: str, path: str | None) -> None:
        """删掉站点里的一个文件。

        Raises:
            ValidationError: 路径不合法（400）。
            NotFound: 站点或文件不存在（404）。
            Forbidden: 不是属主也不是管理员（403）。
        """
        site, _ = self._owned_site(owner_id=owner_id, is_admin=is_admin, name=name)

        if not path or not is_valid_site_path(path):
            raise ValidationError("文件路径不合法")

        if self._files.remove(site.id, path) == 0:
            raise NotFound("站点里没有这个文件")

    # ---------------------------------------------------------------- 内部

    def _owned_site(self, *, owner_id: int, is_admin: bool, name: str) -> tuple[Site, int]:
        """取站点并校验归属。返回 `(站点, 文件数)`。

        这段判断在 7 个方法里都要做，抽出来是为了**只有一份实现** ——
        原版对应的是 `ownSiteOrRespond()`，那也是因为它重复了 7 遍。

        Raises:
            NotFound: 没有这个站点（404）。
            Forbidden: 不是属主也不是管理员（403，文案「只能操作自己的站点」）。
        """
        site = self._sites.find_by_name(name)
        if site is None:
            raise NotFound("没有这个站点")
        if site.owner_id != owner_id and not is_admin:
            raise Forbidden("只能操作自己的站点")
        return site, self._sites.file_count(site.id)


def _looks_binary(content: bytes) -> bool:
    """判断文件内容是不是二进制。

    口径与原版一致：**含字节 `0x00`，或者 UTF-8 往返转换后不相等**。

    **不是看扩展名** —— 一个叫 `.txt` 的文件里塞了 `0x00` 也会被标成二进制。
    反过来，一个叫 `.png` 的纯文本文件会被当成文本（前端能编辑它）。
    """
    if b"\x00" in content:
        return True
    try:
        return content.decode("utf-8").encode("utf-8") != content
    except UnicodeDecodeError:
        return True


def base64_encode(content: bytes) -> str:
    """二进制内容转 base64（前端只读、不允许编辑）。

    对应原版的 `content.toString('base64')` —— 之所以不直接返回字节，
    是因为响应体是 JSON。
    """
    import base64

    return base64.b64encode(content).decode("ascii")
