import {
  JUNK_SEGMENTS,
  MAX_DRAFTS_PER_USER,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SITE,
  MAX_SITE_TOTAL_BYTES,
  MAX_USER_TOTAL_BYTES,
} from './config.js';
import { all, get, isDuplicateError, run, withTransaction } from './db.js';
import { siteQuota } from './coins.js';

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

export async function siteExists(ownerId, name) {
  if (!isValidStoredName(name)) return false;
  return Boolean(await get('SELECT 1 FROM sites WHERE owner_id = ? AND name = ?', ownerId, name));
}

/** 建站配额检查：基础配额 + 硬币兑换来的额外名额。
 *  q 传 {get, all} 或事务里的 tx —— 单页上传和 ZIP 发布都要过这一关，
 *  否则会有一条入口绕过配额（ZIP 之前就是漏的）。 */
export async function assertSiteQuota(q, ownerId) {
  const quota = await siteQuota(ownerId, q);
  const used = Number((await q.get('SELECT COUNT(*) AS c FROM sites WHERE owner_id = ?', ownerId))?.c ?? 0);
  if (used >= quota) {
    throw Object.assign(new Error(`每人最多 ${quota} 个站点，先删掉一个再建（硬币可换更多名额）`), {
      code: 'QUOTA_EXCEEDED',
    });
  }
}

/**
 * 正式站配额只数「非草稿」：草稿有自己的上限（MAX_DRAFTS_PER_USER），
 * 不占「每人 N 个站」的名额，否则创作页随便试几个模板就把配额吃光了。
 */
async function assertPublishedQuota(ownerId) {
  const quota = await siteQuota(ownerId);
  const used = Number((await get(
    "SELECT COUNT(*) AS c FROM sites WHERE owner_id = ? AND status <> 'draft'",
    ownerId,
  ))?.c ?? 0);
  if (used >= quota) {
    throw Object.assign(new Error(`每人最多 ${quota} 个站点，先删掉一个再建（硬币可换更多名额）`), {
      code: 'QUOTA_EXCEEDED',
    });
  }
}

/**
 * 新建站点。同名（同一作者名下）已存在时抛 code === 'NAME_TAKEN'，绝不覆盖已有内容。
 * status='draft' 建的是草稿：不计入站点配额，另有 MAX_DRAFTS_PER_USER 单独限流。
 * 正式站超出配额时抛 code === 'QUOTA_EXCEEDED'，超出存储预算抛 code === 'STORAGE_EXCEEDED'。
 */
export async function createSite({ name, html, ownerId, status = 'active' }) {
  if (status === 'draft') {
    if ((await countDraftsByOwner(ownerId)) >= MAX_DRAFTS_PER_USER) {
      throw Object.assign(
        new Error(`最多同时保留 ${MAX_DRAFTS_PER_USER} 个草稿，先删掉一些再建`),
        { code: 'DRAFT_QUOTA_EXCEEDED' },
      );
    }
  } else {
    await assertPublishedQuota(ownerId);
  }

  const size = Buffer.byteLength(html, 'utf8');
  // 新站点还没有行，所以按「无 siteId、纯增量」算预算
  await assertStorageBudget({ get }, { ownerId, siteId: null, incomingBytes: size });

  const ts = nowIso();

  try {
    const result = await run(
      `INSERT INTO sites (name, owner_id, html, size, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      name,
      ownerId,
      html,
      size,
      status,
      ts,
      ts,
    );

    return { id: Number(result.lastInsertRowid), name, size, status };
  } catch (err) {
    if (isDuplicateError(err)) {
      throw Object.assign(new Error('这个名字已经被占用了'), { code: 'NAME_TAKEN' });
    }
    throw err;
  }
}

/**
 * 开一个上传草稿（多文件上传的原子化前置步骤）。
 *
 * 多文件上传是「N 个文件各发一个请求」，跨请求没有事务。所以先把站点以 draft 落地：
 * 文件逐个写进来，全部成功后才由 publishDraftSite 一次性切成 active。这样中途断网
 * 只会留下一个**对外不可见**的草稿（status !== 'active' 的站点访问一律 404/451），
 * 不会像以前那样第一个文件到站就上线半个站。
 *
 * 同名草稿直接复用（重试/续传都会再调一次），已上线的同名站点仍按「名字被占用」拒绝。
 */
export async function openSiteDraft({ name, ownerId }) {
  const existing = await get(
    'SELECT id, status FROM sites WHERE owner_id = ? AND name = ?',
    ownerId, name,
  );
  if (existing) {
    if (existing.status !== 'draft') {
      throw Object.assign(new Error('这个名字已经被占用了'), { code: 'NAME_TAKEN' });
    }
    // 续传：把 updated_at 推后，免得 TTL 清理把正在传的草稿删掉
    await run('UPDATE sites SET updated_at = ? WHERE id = ?', nowIso(), existing.id);
    return { id: existing.id, resumed: true };
  }

  await assertSiteQuota({ get }, ownerId);

  const ts = nowIso();
  try {
    const inserted = await run(
      `INSERT INTO sites (name, owner_id, html, size, status, created_at, updated_at)
       VALUES (?, ?, '', 0, 'draft', ?, ?)`,
      name, ownerId, ts, ts,
    );
    return { id: Number(inserted.lastInsertRowid), resumed: false };
  } catch (err) {
    // 并发下两个请求同时开同一个草稿：后来的那个直接复用已建好的
    if (isDuplicateError(err)) {
      const row = await get(
        'SELECT id, status FROM sites WHERE owner_id = ? AND name = ?',
        ownerId, name,
      );
      if (row?.status === 'draft') return { id: row.id, resumed: true };
      throw Object.assign(new Error('这个名字已经被占用了'), { code: 'NAME_TAKEN' });
    }
    throw err;
  }
}

/**
 * 把草稿一次性发布上线：校验入口文件和文件数之后，在一个事务里切 status。
 * 已经不是草稿（重复点发布）时按幂等处理，不报错。
 */
export async function publishDraftSite({ name, ownerId }) {
  return withTransaction(async (tx) => {
    const site = await tx.get(
      'SELECT id, status FROM sites WHERE owner_id = ? AND name = ? FOR UPDATE',
      ownerId, name,
    );
    if (!site) throw Object.assign(new Error('没有这个站点'), { code: 'NOT_FOUND' });
    if (site.status === 'active') return { id: site.id, published: true, already: true };
    if (site.status !== 'draft') {
      // offline（管理员下线）不能被一次上传悄悄改回 active
      throw Object.assign(new Error('站点当前不是草稿状态'), { code: 'BAD_STATUS' });
    }

    const files = await tx.all('SELECT path FROM site_files WHERE site_id = ?', site.id);
    if (files.length === 0) {
      throw Object.assign(new Error('还没有上传任何文件'), { code: 'NO_FILES' });
    }
    if (!files.some((f) => /\.html?$/i.test(f.path))) {
      throw Object.assign(new Error('至少要有一个 HTML 文件作为入口页'), { code: 'NO_ENTRY' });
    }

    await tx.run(
      "UPDATE sites SET status = 'active', updated_at = ? WHERE id = ?",
      nowIso(), site.id,
    );
    return { id: site.id, published: true, files: files.length };
  });
}

/** 清掉过期草稿（没传完就放弃的上传）。site_files 有 ON DELETE CASCADE，文件跟着走。 */
export async function pruneDraftSites(ttlHours) {
  if (!(ttlHours > 0)) return 0;
  const cutoff = new Date(Date.now() - ttlHours * 3600_000).toISOString();
  return (await run("DELETE FROM sites WHERE status = 'draft' AND updated_at < ?", cutoff)).changes;
}

/** 查站点（含 HTML 内容），按作者 id + 站名。返回 null 表示不存在。 */
export async function findSiteByName(ownerId, name) {
  if (!isValidStoredName(name)) return null;

  return (
    (await get(
      `SELECT id, name, owner_id, html, size, status, title, description, tag,
                created_at, updated_at
         FROM sites WHERE owner_id = ? AND name = ?`,
      ownerId,
      name,
    )) ?? null
  );
}

/** 查站点（含 HTML 内容），按作者用户名 + 站名（访问路径用）。 */
export async function findSiteByUsername(username, name) {
  if (!isValidStoredName(name)) return null;

  return (
    (await get(
      `SELECT s.id, s.name, s.owner_id, s.html, s.size, s.status, s.title,
                s.description, s.tag, s.created_at, s.updated_at
         FROM sites s
         JOIN users u ON u.id = s.owner_id
         WHERE u.username = ? AND s.name = ?`,
      String(username ?? ''),
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
              COALESCE(f.total, 0) AS files_size,
              EXISTS(SELECT 1 FROM site_covers cv WHERE cv.site_id = s.id) AS has_cover
       FROM sites s
       LEFT JOIN (
         SELECT site_id, COUNT(*) AS cnt, SUM(size) AS total
         FROM site_files GROUP BY site_id
       ) f ON f.site_id = s.id
       WHERE s.owner_id = ? AND s.status <> 'draft'
       ORDER BY s.updated_at DESC`,
    ownerId,
  );
}

/**
 * 某个作者名下的草稿站（创作页的草稿卡片用）。
 *
 * 为什么要单开一个函数：listSitesByOwner 只给「正式站」，草稿在里面被过滤掉了
 * （对外它们根本不存在，/api/sites 的既有断言也依赖这一点）。但创作页恰恰要展示
 * 草稿，所以草稿单独一条通道返回，字段和正式站保持一致，前端好复用同一套渲染。
 */
export async function listDraftSitesByOwner(ownerId) {
  return all(
    `SELECT s.id, s.name, s.title, s.description, s.tag,
            s.size, s.status, s.created_at, s.updated_at,
            COALESCE(f.cnt, 0)   AS file_count,
            COALESCE(f.total, 0) AS files_size,
            EXISTS(SELECT 1 FROM site_covers cv WHERE cv.site_id = s.id) AS has_cover
       FROM sites s
       LEFT JOIN (
         SELECT site_id, COUNT(*) AS cnt, SUM(size) AS total
         FROM site_files GROUP BY site_id
       ) f ON f.site_id = s.id
       WHERE s.owner_id = ? AND s.status = 'draft'
       ORDER BY s.updated_at DESC`,
    ownerId,
  );
}

export async function listAllSites({ limit = 200, offset = 0 } = {}) {
  // 草稿是「还没传完的上传」，对外不存在，后台也不显示：
  // 否则它会以「已下线」的样子出现，管理员点「恢复」等于替用户点发布
  return all(
    `SELECT s.id, s.name, s.size, s.status, s.created_at, s.updated_at,
              u.id AS owner_id, u.email AS owner_email, u.username AS owner_username
       FROM sites s
       LEFT JOIN users u ON u.id = s.owner_id
       WHERE s.status <> 'draft'
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

/** 站点元信息（不含 html / 文件内容），按作者 id + 站名。 */
export async function findSiteHeaderByName(ownerId, name) {
  if (!isValidStoredName(name)) return null;

  return (
    (await get(
      `SELECT id, name, owner_id, status, title, description, tag, created_at, updated_at
         FROM sites WHERE owner_id = ? AND name = ?`,
      ownerId,
      name,
    )) ?? null
  );
}

/** 站点元信息，按作者用户名 + 站名（公开访问路径用）。 */
export async function findSiteHeaderByUsername(username, name) {
  if (!isValidStoredName(name)) return null;

  return (
    (await get(
      `SELECT s.id, s.name, s.owner_id, s.status, s.title, s.description, s.tag,
              s.created_at, s.updated_at
         FROM sites s
         JOIN users u ON u.id = s.owner_id
         WHERE u.username = ? AND s.name = ?`,
      String(username ?? ''),
      name,
    )) ?? null
  );
}

/** 站点元信息，按站点 id（后台轮播位等按 id 引用的场景用）。 */
export async function findSiteHeaderById(id) {
  return (
    (await get(
      `SELECT id, name, owner_id, status, title, description, tag, created_at, updated_at
         FROM sites WHERE id = ?`,
      id,
    )) ?? null
  );
}

/** 某个用户名下已有多少个站点（配额判断和公开列表用）。含草稿。 */
export async function countSitesByOwner(ownerId) {
  return (await get('SELECT COUNT(*) AS c FROM sites WHERE owner_id = ?', ownerId)).c;
}

/** 只算正式站（active / offline），草稿不占「每人 N 个站」的配额。 */
export async function countPublishedByOwner(ownerId) {
  return (
    await get("SELECT COUNT(*) AS c FROM sites WHERE owner_id = ? AND status <> 'draft'", ownerId)
  ).c;
}

export async function countDraftsByOwner(ownerId) {
  return (
    await get("SELECT COUNT(*) AS c FROM sites WHERE owner_id = ? AND status = 'draft'", ownerId)
  ).c;
}

/** 站点下保留的对话条数（工作区渲染用）。不带会话时取整站，兼容老前端。 */
export async function listSiteMessages(siteId, limit = 200) {
  return all(
    `SELECT id, thread_id, role, content, attach_ids, created_at
       FROM site_messages WHERE site_id = ?
       ORDER BY id DESC LIMIT ?`,
    siteId,
    limit,
  ).then((rows) => rows.reverse());
}

/** 追加一条对话消息，返回入库后的行。threadId 可空（兼容老调用）。 */
export async function addSiteMessage(siteId, role, content, threadId = null, attachIds = []) {
  const ts = nowIso();
  // 只留数字 id，逗号拼接；空数组存空串（不是 NULL），查询时少一种分支
  const ids = (attachIds || [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .join(',');

  // 空内容兜底：只发图不打字时 content 是空串，直接入库会让下一轮拼历史时
  // 网关报 empty_message_content（那个会话之后每条都失败）。
  // 存成 `[图片]` 这类占位，既能表达「这里发生过什么」，又不会让内容为空。
  let safeContent = String(content ?? '').trim();
  if (!safeContent) {
    safeContent = ids ? '[图片]' : '';
  }

  const result = await run(
    'INSERT INTO site_messages (site_id, thread_id, role, content, attach_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    siteId,
    threadId,
    role,
    safeContent,
    ids,
    ts,
  );
  if (threadId) {
    await run('UPDATE agent_threads SET updated_at = ? WHERE id = ?', ts, threadId);
  }
  return {
    id: Number(result.lastInsertRowid),
    threadId,
    role,
    content: safeContent,
    attachIds: ids,
    createdAt: ts,
  };
}

// ---------------------------------------------------------------- 会话（thread）

/** 一个草稿下的会话列表，最近更新的在前；附每个会话的消息条数。 */
export async function listThreads(siteId) {
  return all(
    `SELECT t.id, t.site_id, t.title, t.model, t.mode, t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM site_messages m WHERE m.thread_id = t.id) AS msg_count
       FROM agent_threads t
      WHERE t.site_id = ?
      ORDER BY t.updated_at DESC, t.id DESC`,
    siteId,
  );
}

/** 取一个会话；不属于这个站点时返回 null（防止跨站串会话）。 */
export async function findThread(siteId, threadId) {
  return get(
    'SELECT id, site_id, title, model, mode, created_at, updated_at FROM agent_threads WHERE id = ? AND site_id = ?',
    threadId,
    siteId,
  );
}

/** 新建会话。title 留空时由调用方先算好（比如用第一条消息的前几个字）。 */
export async function createThread(siteId, { title = '', model = '', mode = 'code' } = {}) {
  const ts = nowIso();
  const result = await run(
    'INSERT INTO agent_threads (site_id, title, model, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    siteId,
    title || '新对话',
    model,
    mode,
    ts,
    ts,
  );
  return {
    id: Number(result.lastInsertRowid),
    siteId,
    title: title || '新对话',
    model,
    mode,
    createdAt: ts,
    updatedAt: ts,
    msgCount: 0,
  };
}

/** 改会话标题 / 模型 / 模式。只传要改的字段，null / undefined 表示不动。 */
export async function updateThread(threadId, { title, model, mode } = {}) {
  const sets = [];
  const params = [];
  if (typeof title === 'string') { sets.push('title = ?'); params.push(title); }
  if (typeof model === 'string') { sets.push('model = ?'); params.push(model); }
  if (typeof mode === 'string') { sets.push('mode = ?'); params.push(mode); }
  if (sets.length === 0) return 0;
  sets.push('updated_at = ?');
  params.push(nowIso(), threadId);
  return (await run(`UPDATE agent_threads SET ${sets.join(', ')} WHERE id = ?`, ...params)).changes;
}

/** 删会话：消息靠外键级联一起清掉。 */
export async function deleteThread(threadId) {
  return (await run('DELETE FROM agent_threads WHERE id = ?', threadId)).changes;
}

/** 一个会话的消息（正序）。 */
export async function listThreadMessages(threadId, limit = 200) {
  return all(
    `SELECT id, thread_id, role, content, attach_ids, created_at
       FROM site_messages WHERE thread_id = ?
       ORDER BY id DESC LIMIT ?`,
    threadId,
    limit,
  ).then((rows) => rows.reverse());
}

/**
 * 给站点准备一个「默认会话」：已经有会话就返回最近那个，没有就建一个。
 * 老接口（不带 thread）和新接口都靠它，保证消息永远挂得到一个会话上。
 */
export async function ensureDefaultThread(siteId) {
  const existing = await get(
    'SELECT id, site_id, title, model, mode, created_at, updated_at FROM agent_threads WHERE site_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
    siteId,
  );
  if (existing) return existing;
  return createThread(siteId, { title: '默认会话' });
}

export async function countSiteFiles(siteId) {
  return (await get('SELECT COUNT(*) AS c FROM site_files WHERE site_id = ?', siteId)).c;
}

/** 一个站点的内容总量。两种站各占一半，不能相加：
 *   单页站的内容在 sites.size（html），多页站的内容在 site_files —— 多页站的 sites.size 应该是 0。
 *   但 scripts/import-templates.mjs 曾把「全部文件总和」也写进多页站的 sites.size，
 *   相加会把模板站算成两倍。有文件就只认文件，没文件才认 sites.size。 */
export async function siteContentBytes(siteId, q = { get }) {
  const row = await q.get(
    `SELECT COALESCE((SELECT SUM(size) FROM site_files WHERE site_id = ?), 0) AS files,
            COALESCE((SELECT size FROM sites WHERE id = ?), 0) AS html`,
    siteId, siteId,
  );
  const files = Number(row?.files ?? 0);
  return files > 0 ? files : Number(row?.html ?? 0);
}

/** 一个用户除 excludeSiteId 之外所有站点的内容总量。
 *
 *  **必须逐站决定用哪个数字**：有文件的站只认文件总和，没文件的站认 sites.size。
 *  写成「所有站的 html 总和 vs 所有站的 files 总和取大」是错的 —— 一个用户同时有
 *  单页站和多页站时，单页站的那部分会被整个吞掉，账号用量少算。
 *  （多页站的 sites.size 可能是 import-templates 写进去的文件总和，所以有文件时不认它。）
 */
export async function userContentBytes(ownerId, excludeSiteId = 0, q = { get }) {
  const row = await q.get(
    `SELECT COALESCE(SUM(
              CASE WHEN f.total > 0 THEN f.total ELSE s.size END
            ), 0) AS t
       FROM sites s
       LEFT JOIN (SELECT site_id, SUM(size) AS total FROM site_files GROUP BY site_id) f
              ON f.site_id = s.id
      WHERE s.owner_id = ? AND s.id <> ?`,
    ownerId, excludeSiteId,
  );
  return Number(row?.t ?? 0);
}

/** 这次写入要顶掉的旧内容字节数：覆盖文件看该文件的大小，重存单页 HTML 看 sites.size。 */
async function replacedBytes(q, siteId, { replacePath = '', replaceHtml = false }) {
  if (!siteId) return 0;
  let bytes = 0;
  if (replaceHtml) {
    bytes += Number((await q.get('SELECT size FROM sites WHERE id = ?', siteId))?.size ?? 0);
  }
  if (replacePath) {
    bytes += Number(
      (await q.get('SELECT size FROM site_files WHERE site_id = ? AND path = ?', siteId, replacePath))?.size ?? 0,
    );
  }
  return bytes;
}

/**
 * 存储预算守卫：单站总量（MAX_SITE_TOTAL_BYTES）+ 每人总量（MAX_USER_TOTAL_BYTES）。
 *
 * 入参分三块，**不要混算**：
 *   siteNow    这一站现在的内容量
 *   otherSitesNow  这个用户**除本站以外**其他站点的内容量（null 表示不分用户维度）
 *   oldBytes   这次写入会顶掉的旧内容量
 *
 * 每人总量 = otherSitesNow + siteNow，所以站点在循环里长大时用户总量跟着长大，
 * 不会出现「ZIP 写满一个站却每步都按旧的 userNow 判定」那种漏算。
 *
 * 口径是「这次写入会不会让总量继续变大并越过上限」。已经超限的存量 — 模板导入的
 * TP 站最大 171 MB，而每人上限是 100 MB — 仍然可以把文件换成同样大或更小的版本，
 * 否则那些站连改一个错字都做不了。这个例外是显式的、写在这里的，不是静默放行：
 * 只有「超限后缩小或持平」才被允许，任何增量都拒。
 *
 * 纯判定，不查库：调用方各自把数字算好传进来。通过返回 null，否则返回 { code, message }。
 */
export function storageBudgetViolation({ siteNow, otherSitesNow = null, oldBytes = 0, incomingBytes }) {
  const siteAfter = siteNow - oldBytes + incomingBytes;
  if (siteAfter > MAX_SITE_TOTAL_BYTES && siteAfter > siteNow) {
    return {
      message: `站点总容量超限，单站上限 ${mb(MAX_SITE_TOTAL_BYTES)} MB`,
      code: 'STORAGE_EXCEEDED',
    };
  }
  if (otherSitesNow == null) return null;

  const userNow = Number(otherSitesNow) + siteNow;
  const userAfter = userNow - oldBytes + incomingBytes;
  if (userAfter > MAX_USER_TOTAL_BYTES && userAfter > userNow) {
    return {
      message: `账号总容量超限，每人上限 ${mb(MAX_USER_TOTAL_BYTES)} MB，删掉不用的页面或文件再传`,
      code: 'STORAGE_EXCEEDED',
    };
  }
  return null;
}

/**
 * 单文件写入前的预算检查（HTTP 上传 / MCP write_file / 覆盖单页 HTML 共用）。
 *
 * replacePath：这次写入会顶掉的站内文件路径；replaceHtml：会顶掉 sites.size。
 * ownerId 传 null 表示不计用户维度（目前没有这种调用，留着给将来的无主站）。
 * 超限抛 code === 'STORAGE_EXCEEDED'；q 传 {get} 或事务里的 tx。
 */
export async function assertStorageBudget(q, { ownerId, siteId, replacePath = '', replaceHtml = false, incomingBytes }) {
  // 新建站点还没有行：站点自身占用算 0，用户维度排除 0（= 不排除任何一个站）
  const siteNow = siteId ? await siteContentBytes(siteId, q) : 0;
  const otherSitesNow = ownerId == null ? null : await userContentBytes(ownerId, siteId ?? 0, q);
  const oldBytes = await replacedBytes(q, siteId, { replacePath, replaceHtml });

  const violation = storageBudgetViolation({ siteNow, otherSitesNow, oldBytes, incomingBytes });
  if (violation) throw Object.assign(new Error(violation.message), { code: violation.code });
}

/** 字节数 → 「50 MB」这样的展示用整数。 */
function mb(bytes) {
  return Math.round(bytes / 1024 / 1024);
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
    // 站名只在作者名下唯一，所以按 (owner_id, name) 定位，不能只看 name
    let site = await tx.get(
      'SELECT id, owner_id FROM sites WHERE owner_id = ? AND name = ? FOR UPDATE',
      ownerId, name,
    );
    if (site && site.owner_id !== ownerId && !isAdmin) {
      throw Object.assign(new Error('只能操作自己的站点'), { code: 'FORBIDDEN' });
    }
    if (!site) {
      // 和 createSite 同一道配额关：ZIP 是另一条建站入口，漏掉这里配额就等于没有
      await assertSiteQuota(tx, ownerId);
      const ts = nowIso();
      let inserted;
      try {
        inserted = await tx.run(
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
      site = { id: Number(inserted.lastInsertRowid) };
    }

    const existing = await tx.all('SELECT path, size FROM site_files WHERE site_id = ?', site.id);
    const sizeByPath = new Map(existing.map((file) => [file.path, Number(file.size)]));
    let totalBytes = existing.reduce((sum, file) => sum + Number(file.size), 0);
    // 预算以「整站当前实际内容」为起点（新建的站这时是 0），循环里跟着累加。
    // 口径和 siteContentBytes 一致：有文件就只认文件，没有才认 sites.size。
    let siteBytes = totalBytes > 0
      ? totalBytes
      : Number((await tx.get('SELECT size FROM sites WHERE id = ?', site.id))?.size ?? 0);
    // 用户维度只算「别的站」；本站由 siteBytes 单独累加，两者相加才是账号总量
    const otherSitesNow = await userContentBytes(ownerId, site.id, tx);
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
      const violation = storageBudgetViolation({
        siteNow: siteBytes,
        otherSitesNow,
        oldBytes: oldSize,
        incomingBytes: entry.content.length,
      });
      if (violation) {
        skipped.push({ path: entry.path, reason: violation.message });
        continue;
      }

      await tx.run(
        `INSERT INTO site_files (site_id, path, content, size, updated_at)
         VALUES (?, ?, ?, ?, ?)
         AS new ON DUPLICATE KEY UPDATE content = new.content, size = new.size, updated_at = new.updated_at`,
        site.id, entry.path, entry.content, entry.content.length, nowIso(),
      );
      siteBytes = siteBytes - oldSize + entry.content.length;
      totalBytes = totalBytes - oldSize + entry.content.length;
      sizeByPath.set(entry.path, entry.content.length);
      saved++;
    }

    if (saved === 0) {
      const err = Object.assign(new Error('zip 里没有可发布的文件'), { code: 'NO_FILES', skipped });
      // 一个文件都没进来时，「全是容量上限刷掉的」和「zip 本身有问题」是完全不同的原因，
      // 前者的提示必须点名容量，否则用户会以为是包坏了。只有全部被跳过项都是容量原因才改判。
      const fromArchive = skipped.slice(parsedSkipped.length);
      const storageReasons = fromArchive.filter((it) => it.reason.includes('容量'));
      if (fromArchive.length > 0 && storageReasons.length === fromArchive.length) {
        err.code = 'STORAGE_EXCEEDED';
        err.message = storageReasons[0].reason;
      }
      throw err;
    }
    // ZIP 本身就是「一次完整发布」，所以顺带把草稿（上次多文件上传没传完的站）切成上线；
    // 否则同一个站名先开过草稿再拖 zip，文件写进去了但站点永远对外不可见。
    // 已下线的站不能被这一步悄悄救活，所以只翻转 draft。
    await tx.run(
      `UPDATE sites SET status = CASE WHEN status = 'draft' THEN 'active' ELSE status END,
                        updated_at = ?
        WHERE id = ?`,
      nowIso(), site.id,
    );
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

/** 重存单页站 HTML。超出存储预算抛 code === 'STORAGE_EXCEEDED'（ownerId 用于每人总量）。 */
export async function updateSiteHtml(siteId, html, ownerId) {
  const size = Buffer.byteLength(html, 'utf8');
  await assertStorageBudget({ get }, {
    ownerId, siteId, replaceHtml: true, incomingBytes: size,
  });
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

/**
 * 把草稿发布成一个全新的正式站（active），草稿本身原样保留。
 * 每个正式站都是独立的，后续只在个人主页「作品」里管理；
 * 同一个草稿可以反复发布，每次产出一张新站。整个动作在一个事务里完成。
 */
export async function publishDraft({ draftSiteId, ownerId, name, title, description, tag }) {
  return withTransaction(async (tx) => {
    const draft = await tx.get(
      'SELECT id, owner_id, html, status FROM sites WHERE id = ? FOR UPDATE',
      draftSiteId,
    );
    if (!draft) throw Object.assign(new Error('没有这个草稿'), { code: 'NOT_FOUND' });
    if (draft.owner_id !== ownerId) {
      throw Object.assign(new Error('只能发布自己的草稿'), { code: 'FORBIDDEN' });
    }
    if (draft.status !== 'draft') {
      throw Object.assign(new Error('这个站点不是草稿'), { code: 'NOT_DRAFT' });
    }

    const published = (
      await tx.get("SELECT COUNT(*) AS c FROM sites WHERE owner_id = ? AND status <> 'draft'", ownerId)
    ).c;
    const quota = await siteQuota(ownerId, tx);
    if (published >= quota) {
      throw Object.assign(
        new Error(`每人最多 ${quota} 个站点，先删掉一个再发布（硬币可换更多名额）`),
        { code: 'QUOTA_EXCEEDED' },
      );
    }

    const ts = nowIso();
    let created;
    try {
      created = await tx.run(
        `INSERT INTO sites (name, owner_id, html, size, status, title, description, tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        name,
        ownerId,
        draft.html ?? '',
        Buffer.byteLength(draft.html ?? '', 'utf8'),
        title,
        description,
        tag,
        ts,
        ts,
      );
    } catch (error) {
      if (isDuplicateError(error)) {
        throw Object.assign(new Error('这个地址已经被占用了，换一个'), { code: 'NAME_TAKEN' });
      }
      throw error;
    }

    const newId = Number(created.lastInsertRowid);
    const files = await tx.all(
      'SELECT path, content, size FROM site_files WHERE site_id = ?',
      draft.id,
    );
    for (const file of files) {
      await tx.run(
        `INSERT INTO site_files (site_id, path, content, size, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        newId,
        file.path,
        file.content,
        file.size,
        ts,
      );
    }

    // 草稿自己也记住这次的标题 / 标签，下次打开弹窗是填好的
    await tx.run(
      'UPDATE sites SET title = ?, description = ?, tag = ?, updated_at = ? WHERE id = ?',
      title,
      description,
      tag,
      ts,
      draft.id,
    );

    return { id: newId, name, fileCount: files.length };
  });
}
