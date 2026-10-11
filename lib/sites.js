import { all, get, isDuplicateError, run, withTransaction } from './db.js';
import { JUNK_SEGMENTS, MAX_FILE_BYTES, MAX_FILES_PER_SITE, MAX_SITE_TOTAL_BYTES } from './config.js';

const nowIso = () => new Date().toISOString();

// 站名在 checkName 里已经被限制成 [a-z0-9-]，这里再兜一层，
// 保证任何绕过校验直接调这一层的地方也不会拿到奇怪的查询。
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

// 站点内容标签：key 存库，label 给人看。空串表示未设置。
export const SITE_TAGS = [
  { key: 'resume', label: '求职简历' },
  { key: 'portfolio', label: '作品集' },
  { key: 'social', label: '社交聚合页' },
  { key: 'blog', label: '技术博客' },
  { key: 'event', label: '活动落地页' },
  { key: 'opensource', label: '开源项目' },
  { key: 'docs', label: '学习笔记' },
  { key: 'other', label: '其他' },
];

export function isValidSiteTag(tag) {
  return typeof tag === 'string' && (tag === '' || SITE_TAGS.some((t) => t.key === tag));
}

export function siteTagLabel(tag) {
  return SITE_TAGS.find((t) => t.key === tag)?.label ?? '';
}

export function isValidStoredName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export async function siteExists(name) {
  if (!isValidStoredName(name)) return false;
  return Boolean(await get('SELECT 1 FROM sites WHERE name = ?', name));
}

/** 新建站点。同名已存在时抛 code === 'NAME_TAKEN'，绝不覆盖已有内容。 */
export async function createSite({ name, html, ownerId }) {
  const size = Buffer.byteLength(html, 'utf8');
  const ts = nowIso();

  try {
    const result = await run(
      `INSERT INTO sites (name, owner_id, html, size, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      name,
      ownerId,
      html,
      size,
      ts,
      ts,
    );

    return { id: Number(result.lastInsertRowid), name, size };
  } catch (err) {
    if (isDuplicateError(err)) {
      throw Object.assign(new Error('这个名字已经被占用了'), { code: 'NAME_TAKEN' });
    }
    throw err;
  }
}

/** 查站点（含 HTML 内容）。返回 null 表示不存在。 */
export async function findSiteByName(name) {
  if (!isValidStoredName(name)) return null;

  return (
    (await get(
      `SELECT id, name, owner_id, html, size, status, title, description, tag,
                created_at, updated_at
         FROM sites WHERE name = ?`,
      name,
    )) ?? null
  );
}

/** 列表查询一律不带 html 字段，避免把几 MB 的内容拉进内存。 */
export async function listSitesByOwner(ownerId) {
  return all(
    `SELECT s.id, s.name, s.title, s.description, s.tag,
              s.size, s.status, s.created_at, s.updated_at,
              COALESCE(f.cnt, 0)   AS file_count,
              COALESCE(f.total, 0) AS files_size
       FROM sites s
       LEFT JOIN (
         SELECT site_id, COUNT(*) AS cnt, SUM(size) AS total
         FROM site_files GROUP BY site_id
       ) f ON f.site_id = s.id
       WHERE s.owner_id = ?
       ORDER BY s.updated_at DESC`,
    ownerId,
  );
}

export async function listAllSites({ limit = 200, offset = 0 } = {}) {
  return all(
    `SELECT s.id, s.name, s.size, s.status, s.created_at, s.updated_at,
              u.id AS owner_id, u.email AS owner_email, u.username AS owner_username
       FROM sites s
       LEFT JOIN users u ON u.id = s.owner_id
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
    limit,
    offset,
  );
}

export async function setSiteStatus(id, status) {
  return (await run('UPDATE sites SET status = ? WHERE id = ?', status, id)).changes;
}

export async function deleteSite(id) {
  return (await run('DELETE FROM sites WHERE id = ?', id)).changes;
}

export async function countSites() {
  return (await get('SELECT COUNT(*) AS c FROM sites')).c;
}

// ---------------------------------------------------------------- 多文件站点

// 站点内相对路径规则：
//   - 段与段之间用 /，不以 / 开头
//   - 每段只允许字母数字 . _ -，且不能是 . 或 ..
//   - 隐藏文件（. 开头）直接不合法，省得和「点开头的怪路径」纠缠
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSitePath(p) {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > 200) return false;
  if (p.startsWith('/') || p.includes('\\')) return false;

  const segments = p.split('/');
  return segments.every(
    (s) =>
      PATH_SEGMENT.test(s) &&
      s !== '.' &&
      s !== '..' &&
      !JUNK_SEGMENTS.has(s.toLowerCase()),
  );
}

/** 站点元信息（不含 html / 文件内容），文件流程判断归属和状态用。 */
export async function findSiteHeaderByName(name) {
  if (!isValidStoredName(name)) return null;

  return (
    (await get(
      `SELECT id, name, owner_id, status, title, description, tag, created_at, updated_at
         FROM sites WHERE name = ?`,
      name,
    )) ?? null
  );
}

export async function countSiteFiles(siteId) {
  return (await get('SELECT COUNT(*) AS c FROM site_files WHERE site_id = ?', siteId)).c;
}

/** 站内已用总字节数（不含 excludePath）。上传前与 MAX_SITE_TOTAL_BYTES 比对；
 *  excludePath 用于覆盖场景——把被覆盖文件的旧体积扣掉，只算增量。 */
export async function totalSiteFileSize(siteId, excludePath = '') {
  return (
    await get(
      'SELECT COALESCE(SUM(size), 0) AS t FROM site_files WHERE site_id = ? AND path <> ?',
      siteId,
      excludePath,
    )
  ).t;
}

/** 新增或覆盖一个站点文件。路径合法性由调用方（isValidSitePath）保证。 */
export async function upsertSiteFile(siteId, filePath, content) {
  const ts = nowIso();

  await run(
    `INSERT INTO site_files (site_id, path, content, size, updated_at)
     VALUES (?, ?, ?, ?, ?)
     AS new ON DUPLICATE KEY UPDATE content = new.content, size = new.size, updated_at = new.updated_at`,
    siteId,
    filePath,
    content,
    content.length,
    ts,
  );

  await touchSite(siteId);
  return { path: filePath, size: content.length };
}

/** ZIP 发布：建站和所有文件写入一同提交，任何失败均回滚。 */
export async function publishSiteZip({ name, ownerId, isAdmin, entries, skipped: parsedSkipped }) {
  return withTransaction(async (tx) => {
    let site = await tx.get('SELECT id, owner_id FROM sites WHERE name = ? FOR UPDATE', name);
    if (site && site.owner_id !== ownerId && !isAdmin) {
      throw Object.assign(new Error('只能操作自己的站点'), { code: 'FORBIDDEN' });
    }
    if (!site) {
      const ts = nowIso();
      let created;
      try {
        created = await tx.run(
          `INSERT INTO sites (name, owner_id, html, size, status, created_at, updated_at)
           VALUES (?, ?, '', 0, 'active', ?, ?)`,
          name, ownerId, ts, ts,
        );
      } catch (error) {
        if (isDuplicateError(error)) {
          throw Object.assign(new Error('这个名字已经被占用了'), { code: 'NAME_TAKEN' });
        }
        throw error;
      }
      site = { id: Number(created.lastInsertRowid) };
    }

    const existing = await tx.all('SELECT path, size FROM site_files WHERE site_id = ?', site.id);
    const sizeByPath = new Map(existing.map((file) => [file.path, Number(file.size)]));
    let totalBytes = existing.reduce((sum, file) => sum + Number(file.size), 0);
    const skipped = [...parsedSkipped];
    let saved = 0;

    for (const entry of entries) {
      if (!isValidSitePath(entry.path)) {
        skipped.push({ path: entry.path, reason: '路径不合法或含垃圾文件' });
        continue;
      }
      if (entry.content.length === 0) {
        skipped.push({ path: entry.path, reason: '空文件' });
        continue;
      }
      if (entry.content.length > MAX_FILE_BYTES) {
        skipped.push({ path: entry.path, reason: '超过单文件上限' });
        continue;
      }
      const isNew = !sizeByPath.has(entry.path);
      if (isNew && sizeByPath.size >= MAX_FILES_PER_SITE) {
        skipped.push({ path: entry.path, reason: '文件数超上限' });
        continue;
      }
      const oldSize = sizeByPath.get(entry.path) ?? 0;
      if (totalBytes - oldSize + entry.content.length > MAX_SITE_TOTAL_BYTES) {
        skipped.push({ path: entry.path, reason: '站点总容量超限' });
        continue;
      }

      await tx.run(
        `INSERT INTO site_files (site_id, path, content, size, updated_at)
         VALUES (?, ?, ?, ?, ?)
         AS new ON DUPLICATE KEY UPDATE content = new.content, size = new.size, updated_at = new.updated_at`,
        site.id, entry.path, entry.content, entry.content.length, nowIso(),
      );
      totalBytes = totalBytes - oldSize + entry.content.length;
      sizeByPath.set(entry.path, entry.content.length);
      saved++;
    }

    if (saved === 0) {
      throw Object.assign(new Error('zip 里没有可发布的文件'), { code: 'NO_FILES', skipped });
    }
    await tx.run('UPDATE sites SET updated_at = ? WHERE id = ?', nowIso(), site.id);
    return { saved, skipped, totalBytes };
  });
}

/** 取一个站点文件（含内容），返回 Buffer 或 null。 */
export async function getSiteFile(siteId, filePath) {
  const row = await get('SELECT content FROM site_files WHERE site_id = ? AND path = ?', siteId, filePath);
  return row ? Buffer.from(row.content) : null;
}

/** 列表查询不带内容。 */
export async function listSiteFiles(siteId) {
  return all(
    `SELECT id, path, size, updated_at
       FROM site_files WHERE site_id = ? ORDER BY path ASC`,
    siteId,
  );
}

export async function removeSiteFile(siteId, filePath) {
  return (await run('DELETE FROM site_files WHERE site_id = ? AND path = ?', siteId, filePath)).changes;
}

/** 覆盖单页站的 HTML 内容，并同步 size / updated_at。 */
export async function updateSiteHtml(siteId, html) {
  const size = Buffer.byteLength(html, 'utf8');
  await run('UPDATE sites SET html = ?, size = ?, updated_at = ? WHERE id = ?', html, size, nowIso(), siteId);
  return size;
}

/** 更新站点元信息（标题 / 简介 / 内容标签）。 */
export async function updateSiteMeta(siteId, { title, description, tag }) {
  await run('UPDATE sites SET title = ?, description = ?, tag = ? WHERE id = ?', title, description, tag, siteId);
}

async function touchSite(siteId) {
  await run('UPDATE sites SET updated_at = ? WHERE id = ?', nowIso(), siteId);
}
