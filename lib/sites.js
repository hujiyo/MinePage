import { getDb } from './db.js';

const nowIso = () => new Date().toISOString();

// 站名在 checkName 里已经被限制成 [a-z0-9-]，这里再兜一层，
// 保证任何绕过校验直接调这一层的地方也不会拿到奇怪的查询。
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function isValidStoredName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export function siteExists(name) {
  if (!isValidStoredName(name)) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM sites WHERE name = ?').get(name));
}

/** 新建站点。同名已存在时抛 code === 'NAME_TAKEN'，绝不覆盖已有内容。 */
export function createSite({ name, html, ownerId }) {
  const db = getDb();
  const size = Buffer.byteLength(html, 'utf8');
  const ts = nowIso();

  try {
    const result = db
      .prepare(
        `INSERT INTO sites (name, owner_id, html, size, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(name, ownerId, html, size, ts, ts);

    return { id: Number(result.lastInsertRowid), name, size };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw Object.assign(new Error('这个名字已经被占用了'), { code: 'NAME_TAKEN' });
    }
    throw err;
  }
}

/** 查站点（含 HTML 内容）。返回 null 表示不存在。 */
export function findSiteByName(name) {
  if (!isValidStoredName(name)) return null;

  return (
    getDb()
      .prepare(
        `SELECT id, name, owner_id, html, size, status, created_at, updated_at
         FROM sites WHERE name = ?`,
      )
      .get(name) ?? null
  );
}

/** 列表查询一律不带 html 字段，避免把几 MB 的内容拉进内存。 */
export function listSitesByOwner(ownerId) {
  return getDb()
    .prepare(
      `SELECT id, name, size, status, created_at, updated_at
       FROM sites WHERE owner_id = ? ORDER BY updated_at DESC`,
    )
    .all(ownerId);
}

export function listAllSites({ limit = 200, offset = 0 } = {}) {
  return getDb()
    .prepare(
      `SELECT s.id, s.name, s.size, s.status, s.created_at, s.updated_at,
              u.id AS owner_id, u.email AS owner_email, u.username AS owner_username
       FROM sites s
       LEFT JOIN users u ON u.id = s.owner_id
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
}

export function setSiteStatus(id, status) {
  return getDb().prepare('UPDATE sites SET status = ? WHERE id = ?').run(status, id).changes;
}

export function deleteSite(id) {
  return getDb().prepare('DELETE FROM sites WHERE id = ?').run(id).changes;
}

export function countSites() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM sites').get().c;
}
