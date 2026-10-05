"""站点文件（多页站）的数据访问。

单独一个文件而不是塞进 `site_repository.py`：站点与站点文件的**查询模式完全不同** ——
站点少而重（含整段 HTML），文件多而轻（BLOB，单站最多 200 个、单个 10 MB）。
混在一起容易写出"为了判存在性把 10 MB BLOB 读出来"这种代码（原版就有，见 N12）。
"""

from __future__ import annotations

from sqlalchemy import delete, func, select

from app.models.base import utcnow_iso
from app.models.site import SiteFile
from app.repositories.base import BaseRepository


class SiteFileRepository(BaseRepository[SiteFile]):
    """`site_files` 表。多页站的文件。"""

    model = SiteFile

    def list_paths(self, site_id: int, *, with_content: bool = False) -> list[SiteFile]:
        """列文件。

        **`with_content=False` 时不要碰 `content` 列** —— 它是 BLOB，
        一个站点最多 200 个文件、单个 10 MB，全读出来会白白吃内存。
        所以这里显式选择列，而不是 `select(SiteFile)`。

        Args:
            site_id: 站点主键。
            with_content: 是否连文件内容（BLOB）一起读出来。
                **默认 False**，只有真要发文件内容时才传 True。
        """
        cols = [SiteFile.id, SiteFile.site_id, SiteFile.path, SiteFile.size, SiteFile.updated_at]
        if with_content:
            cols.append(SiteFile.content)
        stmt = select(*cols).where(SiteFile.site_id == site_id).order_by(SiteFile.path)
        return [SiteFile(**dict(row._mapping)) for row in self._session.execute(stmt)]

    def exists(self, site_id: int, path: str) -> bool:
        """只判存在性 —— 不读 BLOB。"""
        stmt = (
            select(func.count())
            .select_from(SiteFile)
            .where(SiteFile.site_id == site_id, SiteFile.path == path)
        )
        return bool(self._session.scalar(stmt))

    def get_content(self, site_id: int, path: str) -> bytes | None:
        """取单个文件的原始字节。文件不存在返回 None。"""
        stmt = select(SiteFile.content).where(SiteFile.site_id == site_id, SiteFile.path == path)
        return self._session.scalar(stmt)

    def count(self, site_id: int) -> int:  # type: ignore[override]
        """这个站点有几个文件。新增文件前拿它和 `Limits.MAX_FILES_PER_SITE` 比。"""
        stmt = select(func.count()).select_from(SiteFile).where(SiteFile.site_id == site_id)
        return int(self._session.scalar(stmt) or 0)

    def upsert(self, site_id: int, path: str, content: bytes) -> None:
        """新增或覆盖一个文件。

        Args:
            site_id: 站点主键。
            path: 站内路径（如 `index.html`、`css/style.css`）。
                **合法性由调用方校验**（业务层），这里只管存。
            content: 原始字节。
        """
        existing = self._session.scalars(
            select(SiteFile).where(SiteFile.site_id == site_id, SiteFile.path == path)
        ).first()
        if existing is None:
            self.add(
                SiteFile(
                    site_id=site_id,
                    path=path,
                    content=content,
                    size=len(content),
                    updated_at=utcnow_iso(),
                )
            )
        else:
            existing.content = content
            existing.size = len(content)
            existing.updated_at = utcnow_iso()

    def remove(self, site_id: int, path: str) -> int:
        """删一个文件，返回被删条数。"""
        result = self._session.execute(
            delete(SiteFile).where(SiteFile.site_id == site_id, SiteFile.path == path)
        )
        # 同 LikeRepository.remove：DELETE 拿到的是 CursorResult，类型标注需要忽略
        return int(result.rowcount or 0)  # type: ignore[attr-defined]
