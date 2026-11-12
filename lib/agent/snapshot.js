// 改动快照：agent 每次动文件之前，把「即将被改动的文件」的旧内容存一份。
//
// 为什么只存被改的文件，而不是整站：
//   - 整站快照在 50 MB 上限的站上存两次就把库撑爆了，实际不可用；
//   - agent 一轮通常只动 1–5 个文件，「改前这 5 个文件是什么样」已经足够回滚。
// 代价说清楚：跨多轮的「整体状态」回滚不到精确时刻，只能逐轮回退。
//
// 存储结构（site_snapshots.files 里的 JSON）：
//   {
//     "written": [{ path, content(base64) }],   // 写之前就已存在的文件（回滚 = 写回旧内容）
//     "created": [{ path }],                    // 写之前不存在的文件（回滚 = 删掉它）
//     "removed": [{ path, content(base64) }]    // 删掉之前的内容（回滚 = 重新写回去）
//   }

import { get, all, run } from '../db.js';
import { getSiteFile, listSiteFiles, removeSiteFile, upsertSiteFile } from '../sites.js';

// 单个快照的体积上限：超过就不存（大二进制文件不值得为回滚吃掉库空间）
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
// 每个站点保留多少个快照，超出的按时间从旧到新淘汰
const MAX_SNAPSHOTS_PER_SITE = 50;

const nowIso = () => new Date().toISOString();

/**
 * 快照收集器：一轮 agent 里可能有多次写/删，但只应该在**第一次动某个文件之前**
 * 记下它的原样。所以这里用一张 map 去重，最后一次性落库。
 */
export function createSnapshotCollector({ siteId, threadId = null }) {
  /** path -> { kind: 'written'|'created'|'removed', content?: Buffer } */
  const touched = new Map();
  let closed = false;

  /** 记录「即将写入 path」。同一个文件本轮只记第一次。 */
  async function beforeWrite(path) {
    if (closed || touched.has(path)) return;
    const old = await getSiteFile(siteId, path);
    if (old === null) {
      touched.set(path, { kind: 'created' });
    } else {
      touched.set(path, { kind: 'written', content: old });
    }
  }

  /** 记录「即将删除 path」。 */
  async function beforeDelete(path) {
    if (closed || touched.has(path)) return;
    const old = await getSiteFile(siteId, path);
    if (old === null) return; // 本来就不存在，没什么可回滚的
    touched.set(path, { kind: 'removed', content: old });
  }

  /** 有改动才落库；返回快照 id（没有改动返回 null）。 */
  async function commit(label) {
    if (closed) return null;
    closed = true;
    if (touched.size === 0) return null;

    const written = [];
    const created = [];
    const removed = [];
    let total = 0;

    for (const [path, rec] of touched) {
      if (rec.kind === 'created') {
        created.push({ path });
      } else {
        total += rec.content?.length ?? 0;
        const item = { path, content: rec.content.toString('base64') };
        if (rec.kind === 'written') written.push(item);
        else removed.push(item);
      }
    }

    if (total > MAX_SNAPSHOT_BYTES) {
      // 太大就不存了，但不能悄悄失败——调用方要在界面上告诉用户「这次改动不可回滚」
      return { skipped: true, reason: `改动涉及 ${Math.round(total / 1024 / 1024)} MB，超过快照上限` };
    }

    const payload = Buffer.from(JSON.stringify({ written, created, removed }), 'utf8');
    const ts = nowIso();
    const result = await run(
      `INSERT INTO site_snapshots (site_id, thread_id, label, files, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      siteId,
      threadId,
      String(label ?? '').slice(0, 200),
      payload,
      payload.length,
      ts,
    );

    await pruneSnapshots(siteId);

    return {
      id: Number(result.lastInsertRowid),
      label: String(label ?? '').slice(0, 200),
      size: payload.length,
      createdAt: ts,
      files: written.length + created.length + removed.length,
      skipped: false,
    };
  }

  return { beforeWrite, beforeDelete, commit };
}

/** 只留最近 MAX_SNAPSHOTS_PER_SITE 个，多余的删掉。 */
async function pruneSnapshots(siteId) {
  const rows = await all(
    'SELECT id FROM site_snapshots WHERE site_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
    siteId,
    MAX_SNAPSHOTS_PER_SITE,
  );
  if (rows.length === 0) return;
  // 比这个 id 更早的全部删掉
  await run('DELETE FROM site_snapshots WHERE site_id = ? AND id <= ?', siteId, rows[0].id);
}

/** 列出一个站点的快照（新的在前），不带文件内容。 */
export async function listSnapshots(siteId, limit = 50) {
  return all(
    `SELECT id, thread_id, label, size, created_at
       FROM site_snapshots WHERE site_id = ?
       ORDER BY id DESC LIMIT ?`,
    siteId,
    limit,
  );
}

/** 取一个快照的完整内容（含 base64 文件），回滚时用。 */
export async function getSnapshot(siteId, snapshotId) {
  const row = await get(
    'SELECT id, site_id, thread_id, label, files, size, created_at FROM site_snapshots WHERE id = ? AND site_id = ?',
    snapshotId,
    siteId,
  );
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    label: row.label,
    size: row.size,
    createdAt: row.created_at,
    data: JSON.parse(Buffer.from(row.files).toString('utf8')),
  };
}

/**
 * 回滚到一个快照。
 *
 * 语义是「把这个快照记录的那几个文件恢复到改动前」：
 *   - written → 写回旧内容
 *   - created → 删掉（它本来是 agent 新建的）
 *   - removed → 重新写回
 * 其它没被这个快照碰过的文件保持现状，不会被误删。
 */
export async function restoreSnapshot(siteId, snapshotId) {
  const snap = await getSnapshot(siteId, snapshotId);
  if (!snap) throw Object.assign(new Error('没有这个快照'), { code: 'NOT_FOUND' });

  const { written = [], created = [], removed = [] } = snap.data;

  for (const item of written) {
    await upsertSiteFile(siteId, item.path, Buffer.from(item.content, 'base64'));
  }
  for (const item of removed) {
    await upsertSiteFile(siteId, item.path, Buffer.from(item.content, 'base64'));
  }
  for (const item of created) {
    await removeSiteFile(siteId, item.path);
  }

  return {
    restored: written.length + removed.length,
    deleted: created.length,
  };
}

/**
 * 回滚前的安全快照：把「即将被回滚覆盖的文件」当前状态也存一份，
 * 这样用户点错了还能再退回来。
 */
export async function snapshotBeforeRestore(siteId, threadId, snapshot) {
  const collector = createSnapshotCollector({ siteId, threadId });
  for (const item of snapshot.data.written ?? []) await collector.beforeWrite(item.path);
  for (const item of snapshot.data.removed ?? []) await collector.beforeWrite(item.path);
  return collector.commit(`回滚前的自动快照（还原到 #${snapshot.id}）`);
}

export { MAX_SNAPSHOT_BYTES, MAX_SNAPSHOTS_PER_SITE };
