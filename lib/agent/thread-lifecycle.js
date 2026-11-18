// 会话与 checkpoint 的生命周期绑定。
//
// 为什么需要这个文件：checkpoint 表没有外键到 agent_threads（见 db.js 里的说明），
// 所以「删会话」时必须显式清理 checkpoint，否则检查点会变成孤儿行，一直占空间。
//
// 这个 wrapper 把两件事绑在一起：
//   1. 删 MySQL 里的会话行（原来 lib/sites.js 的 deleteThread）
//   2. 删 LangGraph 的检查点链

import { deleteThread as deleteThreadRow } from '../sites.js';
import { MySqlSaver } from './checkpoint-mysql.js';

let cachedSaver = null;
function saver() {
  if (!cachedSaver) cachedSaver = new MySqlSaver();
  return cachedSaver;
}

/** 和 loop.js 里拼 graphThread 的规则保持完全一致，否则会清错对象。 */
export function checkpointThreadId(siteId, threadId) {
  return `site-${siteId}-thread-${threadId}`;
}
/**
 * 删一个会话：先清检查点，再删数据库行。
 *
 * 顺序有讲究：先清检查点。如果反过来（先删行），中途失败就会留下
 * 「会话没了但检查点还在」的孤儿数据，而且再也没法从会话表反查到该清哪些。
 *
 * @param {number} siteId
 * @param {number} threadId
 * @returns {Promise<number>} 删掉的会话行数（0 表示本来就不存在）
 */
export async function deleteThreadWithCheckpoints(siteId, threadId) {
  // 检查点清理失败不该阻止会话删除（会话删不掉对用户影响更大）
  try {
    await saver().deleteThread(checkpointThreadId(siteId, threadId));
  } catch (err) {
    console.error('[checkpoint] 清理检查点失败:', threadId, err?.message ?? err);
  }
  return deleteThreadRow(threadId);
}

/**
 * 页面（站点）被删时，把它名下所有会话的检查点一起清掉。
 *
 * 站点删除是级联的：site → agent_threads 会被外键删掉，
 * 但 checkpoint 没有外键，所以要在这里显式清理。
 *
 * @param {number} siteId
 * @param {Array<{id:number}>} threads 删站前先查出来的会话列表
 */
export async function deleteSiteCheckpoints(siteId, threads) {
  const s = saver();
  for (const t of threads) {
    try {
      await s.deleteThread(checkpointThreadId(siteId, t.id));
    } catch (err) {
      console.error('[checkpoint] 清理站点检查点失败:', siteId, t.id, err?.message ?? err);
    }
  }
}
