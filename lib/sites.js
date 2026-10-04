import { getDb } from './db.js';

/** 当前时间的 ISO 8601 字符串。sites / site_files 的时间列都是 TEXT 存这个格式，比较靠字符串序。 */
const nowIso = () => new Date().toISOString();

// 站名在 checkName 里已经被限制成 [a-z0-9-]，这里再兜一层，
// 保证任何绕过校验直接调这一层的地方也不会拿到奇怪的查询。
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

// 站点内容标签：key 存库，label 给人看。空串表示未设置。
// 这份数组是唯一事实来源：校验（isValidSiteTag）、展示（siteTagLabel）、接口返回的 tags 列表都读它。
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

/** 校验站点内容标签：只接受空串（未设置）或 SITE_TAGS 里登记过的 key，其他一律 false。
 *  接口层用它拦 PUT /meta 和 ?tag= 筛选；库里没有 CHECK 约束，绕过这里就能写进任意字符串。 */
export function isValidSiteTag(tag) {
  return typeof tag === 'string' && (tag === '' || SITE_TAGS.some((t) => t.key === tag));
}

/** tag key → 中文标签。未登记或空串返回空字符串，不抛错，调用方直接拿去展示即可。 */
export function siteTagLabel(tag) {
  return SITE_TAGS.find((t) => t.key === tag)?.label ?? '';
}

/** 判断「库里的站名」是否合形（^[a-z0-9][a-z0-9-]*[a-z0-9]$）。
 *  比 names.js 的 checkName 宽松：不查长度、不查保留字。它是数据层的兜底，
 *  保证任何绕过 checkName 直接调这一层的地方也只会拿到干净的查询参数（不合形直接当不存在，不查库）。 */
export function isValidStoredName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

/** 站名是否已被占用。名字不合形直接返回 false，不查库。
 *  只看名字在不在，不看 status——被管理员下线的站点同样返回 true。 */
export function siteExists(name) {
  if (!isValidStoredName(name)) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM sites WHERE name = ?').get(name));
}

/** 新建站点。同名已存在时抛 code === 'NAME_TAKEN'，绝不覆盖已有内容。
 *  只 INSERT 不 UPSERT：撞上 sites.name 的 UNIQUE 才翻译成 NAME_TAKEN，其他 SQL 错误原样抛出。
 *  size 按 UTF-8 字节算（Buffer.byteLength），不是字符数。多文件站建站时传 html: '' 占位，入口页稍后由 site_files 补。
 *  返回 { id, name, size }，不是整行。 */
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

/** 查站点（含 HTML 内容）。返回 null 表示不存在。
 *  会把 html 整列读出来，只想看元信息时用 findSiteHeaderByName，别把几 MB 拉进内存。 */
export function findSiteByName(name) {
  if (!isValidStoredName(name)) return null;

  return (
    getDb()
      .prepare(
        `SELECT id, name, owner_id, html, size, status, title, description, tag,
                created_at, updated_at
         FROM sites WHERE name = ?`,
      )
      .get(name) ?? null
  );
}

/** 列表查询一律不带 html 字段，避免把几 MB 的内容拉进内存。
 *  额外算出两个聚合列：file_count（文件数，>0 即多页站）与 files_size（文件总字节数）。
 *  返回原始行（snake_case 列名），按 updated_at 倒序，不分页。 */
export function listSitesByOwner(ownerId) {
  return getDb()
    .prepare(
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
    )
    .all(ownerId);
}

/** 管理后台的站点总表，带站点主人的 id / 邮箱 / 用户名，按 updated_at 倒序。
 *  只有一个 OFFSET 分页、没有游标；默认 limit 200，后台调用时不传参，所以 200 条之后的站点看不到也操作不了。
 *  同样不返回 html 与文件内容。 */
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

/** 改站点状态（'active' 上线 / 'offline' 下线），返回受影响行数，0 表示没有这个 id。
 *  值不做白名单校验，调用方（后台）负责只传这两个；下线只改状态，内容仍留在库里，访问时被拦成 451。 */
export function setSiteStatus(id, status) {
  return getDb().prepare('UPDATE sites SET status = ? WHERE id = ?').run(status, id).changes;
}

/** 删站点，返回受影响行数，0 表示没有这个 id。
 *  副作用：靠外键级联连带删掉该站点的 site_files / likes / comments / favorites / view_history
 *  （前提是连接上 PRAGMA foreign_keys = ON，见 db.js 的 getDb）。
 *  不可恢复，没有回收站，也没有二次确认之外的兜底。 */
export function deleteSite(id) {
  return getDb().prepare('DELETE FROM sites WHERE id = ?').run(id).changes;
}

/** 站点总数（后台统计用），不区分 online / offline。 */
export function countSites() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM sites').get().c;
}

// ---------------------------------------------------------------- 多文件站点

// 站点内相对路径规则：
//   - 段与段之间用 /，不以 / 开头
//   - 每段只允许字母数字 . _ -，且不能是 . 或 ..
//   - 隐藏文件（. 开头）直接不合法，省得和「点开头的怪路径」纠缠
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 校验站点内相对路径：非空、≤200 字符、不以 / 开头、不含反斜杠。
 *  再按 / 拆段，每段必须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]*$ 且不能是 . 或 ..（隐藏文件因此天然不合法）。
 *  只校验格式，不查库；上传 / 读取接口在写库前必调。 */
export function isValidSitePath(p) {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > 200) return false;
  if (p.startsWith('/') || p.includes('\\')) return false;

  const segments = p.split('/');
  return segments.every((s) => PATH_SEGMENT.test(s) && s !== '.' && s !== '..');
}

/** 站点元信息（不含 html / 文件内容），文件流程判断归属和状态用。
 *  名字不合形直接返回 null，不查库；多文件上传 / 文件列表 / 站点访问都走它而不是 findSiteByName。 */
export function findSiteHeaderByName(name) {
  if (!isValidStoredName(name)) return null;

  return (
    getDb()
      .prepare(
        `SELECT id, name, owner_id, status, title, description, tag, created_at, updated_at
         FROM sites WHERE name = ?`,
      )
      .get(name) ?? null
  );
}

/** 站点当前文件数。上传新文件前用它比对 MAX_FILES_PER_SITE（只对新路径校验上限）。 */
export function countSiteFiles(siteId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM site_files WHERE site_id = ?').get(siteId).c;
}

/** 新增或覆盖一个站点文件。路径合法性由调用方（isValidSitePath）保证。
 *  按 UNIQUE (site_id, path) 冲突即整段覆盖 content / size / updated_at，不保留历史版本。
 *  content 必须是 Buffer；size 取 content.length（字节数），不是字符串长度。
 *  副作用：写库成功后调 touchSite，把所属站点的 updated_at 一起推到当前时间（发现流排序看它）。
 *  返回 { path, size }，可以直接回给前端。 */
export function upsertSiteFile(siteId, filePath, content) {
  const db = getDb();
  const ts = nowIso();

  db.prepare(
    `INSERT INTO site_files (site_id, path, content, size, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site_id, path) DO UPDATE
     SET content = excluded.content, size = excluded.size, updated_at = excluded.updated_at`,
  ).run(siteId, filePath, content, content.length, ts);

  touchSite(siteId);
  return { path: filePath, size: content.length };
}

/** 取一个站点文件（含内容），返回 Buffer 或 null。
 *  每次都把 BLOB 整个读出来；调用方若只为判断「文件在不在」（上传流程就是这么用的），
 *  这次读取纯属浪费——覆盖 10 MB 的文件要先读 10 MB。 */
export function getSiteFile(siteId, filePath) {
  const row = getDb()
    .prepare('SELECT content FROM site_files WHERE site_id = ? AND path = ?')
    .get(siteId, filePath);
  return row ? Buffer.from(row.content) : null;
}

/** 列表查询不带内容。
 *  按 path 升序返回 id / path / size / updated_at；前端要靠它区分单页站与多页站。 */
export function listSiteFiles(siteId) {
  return getDb()
    .prepare(
      `SELECT id, path, size, updated_at
       FROM site_files WHERE site_id = ? ORDER BY path ASC`,
    )
    .all(siteId);
}

/** 按 (site_id, path) 删一个站点文件，返回受影响行数，0 表示本来就没有。
 *  不刷新 sites.updated_at：删文件不会让站点在「最近更新」里冒头（与 upsertSiteFile 不对称）。 */
export function removeSiteFile(siteId, filePath) {
  return getDb()
    .prepare('DELETE FROM site_files WHERE site_id = ? AND path = ?')
    .run(siteId, filePath).changes;
}

/** 覆盖单页站的 HTML 内容，并同步 size / updated_at。
 *  返回写入后的字节数（按 UTF-8 算，和 createSite 一致）。
 *  只对老的单页站有意义：多页站的内容在 site_files 里，调它只会改到那个空占位。 */
export function updateSiteHtml(siteId, html) {
  const size = Buffer.byteLength(html, 'utf8');
  getDb()
    .prepare('UPDATE sites SET html = ?, size = ?, updated_at = ? WHERE id = ?')
    .run(html, size, nowIso(), siteId);
  return size;
}

/** 更新站点元信息（标题 / 简介 / 内容标签）。
 *  三个字段一次性覆盖写，缺一个会以 undefined 绑定参数并让 node:sqlite 抛错；
 *  server.js 的调用方总会把缺省值补成空串，直接调这一层要自己保证都是字符串。
 *  不刷新 updated_at（与 updateSiteHtml / upsertSiteFile 不对称），改标题简介不会让站点在发现流里冒头。 */
export function updateSiteMeta(siteId, { title, description, tag }) {
  getDb()
    .prepare('UPDATE sites SET title = ?, description = ?, tag = ? WHERE id = ?')
    .run(title, description, tag, siteId);
}

/** 把站点的 updated_at 刷成当前时间。文件增改后由 upsertSiteFile 内部调用（未导出）。
 *  sites 列表、发现流、创作者主页的排序都看这一列，所以它同时承担「内容更新时间」的语义。 */
function touchSite(siteId) {
  getDb().prepare('UPDATE sites SET updated_at = ? WHERE id = ?').run(nowIso(), siteId);
}
