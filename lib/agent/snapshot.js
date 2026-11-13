// 版本快照：站点的每一次改动都是一个带编号的「状态点」。
//
// ============ 语义（2026-11 重写）============
//
// 旧设计存的是「改动**之前**的旧内容」，用来回滚；它回答不了「第 3 版长什么样」。
// 现在存的是「改动**之后**的完整状态点」：
//
//   #1  full   整站所有文件的完整内容（基准点）
//   #2  delta  只存和 #1 相比变化/新增/删除的文件
//   #3  delta  只存和 #2 相比变化的
//   ...
//   #11 full   每 10 版补一个全量，避免回放链条太长
//
// 要拿「第 N 版长什么样」：从最近的、seq <= N 的基准点（full）出发，
// 依次叠加 full 之后到 N 的所有 delta，就得到第 N 版的完整文件表。
//
// 对外暴露的界面行为（用户确认过的）：
//   - 顶部「当前版本」栏显示 site_current.seq 指向的那一版
//   - 点列表里的旧版本 = **只切换预览**，不动任何文件
//   - 确认后再点「恢复到此版本」才真正写回
//   - 回滚不改列表，编号永久递增、不重排；回滚后继续改就出 #N+1（分叉不区分）
//
// 体积：全量快照按「整站文件总字节」算，和旧设计一样有 5 MB 上限。
// delta 通常只有几 KB，所以 10 版一个全量的成本是可以接受的。

import { get, all, run } from '../db.js';
import { getSiteFile, listSiteFiles, removeSiteFile, upsertSiteFile } from '../sites.js';

// 单个快照的原始内容上限（全量快照按整站算，delta 按变化文件算）
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
// 每多少个 delta 补一个 full 基准
const FULL_EVERY = 10;
// 每个站点最多保留多少个版本，超出的从最旧开始删（编号不重排）
const MAX_SNAPSHOTS_PER_SITE = 60;

const nowIso = () => new Date().toISOString();

/**
 * 读取站点的「当前版本指针」。
 * 没有记录时返回 { seq: 0, dirty: 0 }——表示还没存过任何版本。
 */
export async function getCurrent(siteId) {
  const row = await get(
    'SELECT site_id, seq, dirty, updated_at FROM site_current WHERE site_id = ?',
    siteId,
  );
  if (!row) return { seq: 0, dirty: 0, updatedAt: null };
  return { seq: Number(row.seq), dirty: Number(row.dirty), updatedAt: row.updated_at };
}

/** 写当前版本指针。 */
async function setCurrent(siteId, seq, dirty = 0) {
  await run(
    `INSERT INTO site_current (site_id, seq, dirty, updated_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE seq = VALUES(seq), dirty = VALUES(dirty), updated_at = VALUES(updated_at)`,
    siteId, seq, dirty ? 1 : 0, nowIso(),
  );
}

/** 标记「当前文件已不等于任何版本」（手动编辑 / 快照超限没存成时调用）。 */
export async function markDirty(siteId) {
  const cur = await getCurrent(siteId);
  if (cur.seq === 0) return;   // 还没有基准，脏不脏没意义
  await setCurrent(siteId, cur.seq, 1);
}

/** 该站下一个可用的版本号（永久递增，删了旧的也不复用）。 */
async function nextSeq(siteId) {
  const row = await get('SELECT MAX(seq) AS m FROM site_snapshots WHERE site_id = ?', siteId);
  return Number(row?.m ?? 0) + 1;
}

/**
 * 把整站文件读成 Map<path, Buffer>。
 * 全量快照、以及回放时对比，都要用它。
 */
async function readAllFiles(siteId) {
  const files = await listSiteFiles(siteId);
  const out = new Map();
  for (const f of files) {
    const buf = await getSiteFile(siteId, f.path);
    if (buf !== null) out.set(f.path, buf);
  }
  return out;
}

/**
 * 把某一版还原成完整的 Map<path, Buffer>。
 *
 * @param {number} siteId
 * @param {number} seq 目标版本号
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function resolveVersion(siteId, seq) {
  // 找最近的、seq <= 目标 的全量基准
  const base = await get(
    `SELECT id, seq, files FROM site_snapshots
      WHERE site_id = ? AND seq <= ? AND kind = 'full'
      ORDER BY seq DESC LIMIT 1`,
    siteId, seq,
  );
  if (!base) {
    throw Object.assign(new Error(`第 ${seq} 版没有可用的基准快照`), { code: 'NO_BASE' });
  }

  const files = new Map();
  const baseData = JSON.parse(Buffer.from(base.files).toString('utf8'));
  for (const item of baseData.files || []) {
    files.set(item.path, Buffer.from(item.content, 'base64'));
  }

  // 依次叠加 base 之后到目标为止的所有 delta
  const deltas = await all(
    `SELECT seq, files FROM site_snapshots
      WHERE site_id = ? AND seq > ? AND seq <= ? AND kind = 'delta'
      ORDER BY seq ASC`,
    siteId, Number(base.seq), seq,
  );

  for (const d of deltas) {
    const data = JSON.parse(Buffer.from(d.files).toString('utf8'));
    for (const item of data.changed || []) {
      files.set(item.path, Buffer.from(item.content, 'base64'));
    }
    for (const path of data.removed || []) {
      files.delete(path);
    }
  }

  return files;
}

/**
 * 存一个新版本（状态点）。
 *
 * 调用时机：agent 干完一轮 / 手动保存之后，**文件已经写进库**了，
 * 这里只是把「当前状态」记成一个版本。
 *
 * @param {object} opt
 *   siteId   站点
 *   threadId 哪个会话改的（可空）
 *   label    界面显示的说明
 *   files    可选的 Map<path, Buffer>；不传就现读
 * @returns {Promise<{seq:number, kind:string, changed:number, skipped?:boolean, reason?:string}>}
 */
export async function commitVersion({ siteId, threadId = null, label = '', files = null }) {
  const now = files ?? await readAllFiles(siteId);

  const seq = await nextSeq(siteId);

  // 判断这次要不要存全量：第一次、或者距离上个全量满 FULL_EVERY 版
  const lastFull = await get(
    `SELECT seq FROM site_snapshots WHERE site_id = ? AND kind = 'full' ORDER BY seq DESC LIMIT 1`,
    siteId,
  );
  const needFull = !lastFull || (seq - Number(lastFull.seq)) >= FULL_EVERY;

  // 上一版的状态，用来算 delta
  const prevFiles = needFull ? null : await resolveVersion(siteId, seq - 1).catch(() => null);

  let payload;
  let kind;

  if (needFull || !prevFiles) {
    kind = 'full';
    const items = [];
    let total = 0;
    for (const [path, buf] of now) {
      total += buf.length;
      items.push({ path, content: buf.toString('base64') });
    }
    if (total > MAX_SNAPSHOT_BYTES) {
      return {
        skipped: true,
        reason: `整站 ${Math.round(total / 1024 / 1024)} MB，超过单版本上限`,
        seq: 0,
      };
    }
    payload = Buffer.from(JSON.stringify({ files: items }), 'utf8');
  } else {
    kind = 'delta';
    const changed = [];
    const removed = [];
    let total = 0;

    for (const [path, buf] of now) {
      const old = prevFiles.get(path);
      if (!old || !old.equals(buf)) {
        total += buf.length;
        changed.push({ path, content: buf.toString('base64') });
      }
    }
    for (const path of prevFiles.keys()) {
      if (!now.has(path)) removed.push(path);
    }

    if (!changed.length && !removed.length) {
      // 一个字节都没变：不占一个新编号，只把当前指针指回去
      await setCurrent(siteId, seq - 1, 0);
      return { seq: seq - 1, kind: 'noop', changed: 0 };
    }

    if (total > MAX_SNAPSHOT_BYTES) {
      return {
        skipped: true,
        reason: `改动涉及 ${Math.round(total / 1024 / 1024)} MB，超过单版本上限`,
        seq: 0,
      };
    }
    payload = Buffer.from(JSON.stringify({ changed, removed }), 'utf8');
  }

  // 父版本：当前指针指向的那一版（回滚后继续改就会和 MAX(seq) 不同，形成分叉）
  const cur = await getCurrent(siteId);
  const parentSeq = cur.seq || 0;

  await run(
    `INSERT INTO site_snapshots (site_id, thread_id, seq, parent_seq, kind, label, files, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    siteId, threadId, seq, parentSeq, kind, String(label ?? '').slice(0, 200), payload, payload.length, nowIso(),
  );

  await setCurrent(siteId, seq, 0);
  await pruneVersions(siteId);

  const data = JSON.parse(payload.toString('utf8'));
  return {
    seq,
    kind,
    changed: (data.files?.length ?? 0) + (data.changed?.length ?? 0) + (data.removed?.length ?? 0),
    skipped: false,
  };
}

/** 只留最近 N 个版本，多的从最旧删；**编号不重排**。 */
async function pruneVersions(siteId) {
  const rows = await all(
    'SELECT seq FROM site_snapshots WHERE site_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?',
    siteId, MAX_SNAPSHOTS_PER_SITE,
  );
  if (!rows.length) return;
  const cut = Number(rows[0].seq);
  await run('DELETE FROM site_snapshots WHERE site_id = ? AND seq <= ?', siteId, cut);

  // 删掉的那个边界如果是全量基准，剩下最旧的 delta 就无法回放了 ——
  // 直接把它的内容补成一个新的 full 基准（用当时的状态重建）。
  const oldest = await get(
    'SELECT seq, kind FROM site_snapshots WHERE site_id = ? ORDER BY seq ASC LIMIT 1',
    siteId,
  );
  if (oldest && oldest.kind !== 'full') {
    const snap = await resolveVersion(siteId, oldest.seq).catch(() => null);
    if (snap) {
      const items = [];
      for (const [path, buf] of snap) items.push({ path, content: buf.toString('base64') });
      const payload = Buffer.from(JSON.stringify({ files: items }), 'utf8');
      await run(
        "UPDATE site_snapshots SET kind = 'full', files = ?, size = ? WHERE site_id = ? AND seq = ?",
        payload, payload.length, siteId, oldest.seq,
      );
    }
  }
}

/**
 * 列出版本（新的在前），不带文件内容。
 * 额外返回 current：{ seq, dirty } 给前端渲染顶部的「当前版本」栏。
 */
export async function listVersions(siteId, limit = MAX_SNAPSHOTS_PER_SITE) {
  const rows = await all(
    `SELECT seq, parent_seq, kind, label, size, created_at, thread_id
       FROM site_snapshots WHERE site_id = ?
       ORDER BY seq DESC LIMIT ?`,
    siteId, limit,
  );
  return {
    current: await getCurrent(siteId),
    versions: rows.map((r) => ({
      seq: Number(r.seq),
      parentSeq: Number(r.parent_seq),
      kind: r.kind,
      label: r.label,
      size: Number(r.size),
      createdAt: r.created_at,
      threadId: r.thread_id,
    })),
  };
}

/**
 * 恢复到某一版：把文件整体覆盖成那一版的样子。
 *
 * 注意这里**不会**产生新编号（用户确认过的语义：
 * 「回滚到 2，当前版本栏变成 2，其余 1/2/3/4 不变」），
 * 只是把当前指针指回目标版本。
 */
export async function restoreVersion(siteId, seq) {
  const exists = await get(
    'SELECT seq FROM site_snapshots WHERE site_id = ? AND seq = ?',
    siteId, seq,
  );
  if (!exists) throw Object.assign(new Error('没有这个版本'), { code: 'NOT_FOUND' });

  const target = await resolveVersion(siteId, seq);

  // 先删掉当前有、而目标版本没有的文件（只删不写会把废文件留下）
  const current = await listSiteFiles(siteId);
  for (const f of current) {
    if (!target.has(f.path)) await removeSiteFile(siteId, f.path);
  }
  for (const [path, buf] of target) {
    await upsertSiteFile(siteId, path, buf);
  }

  await setCurrent(siteId, seq, 0);
  return { seq, files: target.size };
}

/** 给前端预览用：某一版的某个文件内容。 */
export async function readVersionFile(siteId, seq, path) {
  const files = await resolveVersion(siteId, seq);
  return files.get(path) ?? null;
}

export { MAX_SNAPSHOT_BYTES, MAX_SNAPSHOTS_PER_SITE, FULL_EVERY };
