// Agent 任务的落库与调度。
//
// 为什么要有任务表：一轮 agent 要跑 5–60 秒，同步等会把 HTTP 挂住，
// nginx 的 proxy_read_timeout 一过就是 504，前端还完全不知道结果。
// 改成「立刻返回 taskId，后台跑，前端轮询」之后：
//   - HTTP 不再长挂，网关超时问题消失
//   - 前端能显示「正在读 index.html…」这种进度
//   - 用户刷新页面回来，任务还在跑，结果还拿得到
//
// 这个文件只管「任务的状态」；真正跑循环在 loop.js，串起来在 server.js。

import { randomUUID } from 'node:crypto';
import {
  AGENT_DAILY_TURNS,
  AGENT_TASK_TTL_HOURS,
} from '../config.js';
import { all, get, run } from '../db.js';

const nowIso = () => new Date().toISOString();

export const TASK_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** 活着的任务状态（用于「同一会话不许并发」的判断）。 */
const LIVE = [TASK_STATUS.QUEUED, TASK_STATUS.RUNNING];

export function newTaskId() {
  return randomUUID().replace(/-/g, '');
}

/** 建一条排队中的任务。 */
export async function createTask({ siteId, threadId, userId, model }) {
  const id = newTaskId();
  const ts = nowIso();
  await run(
    `INSERT INTO agent_tasks (id, site_id, thread_id, user_id, model, status, step, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    id, siteId, threadId, userId, String(model ?? ''), TASK_STATUS.QUEUED, ts, ts,
  );
  return id;
}

/** 把任务标记成「开始跑」。 */
export async function markRunning(taskId) {
  await run(
    'UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?',
    TASK_STATUS.RUNNING, nowIso(), taskId,
  );
}

/**
 * 记录进度：第几步 + 已执行的工具摘要（JSON 数组）。
 *
 * @param {string} taskId
 * @param {number} step   第几步（模型往返次数）
 * @param {Array}  steps  扁平的工具摘要（老的 summary 数组，兼容用）
 * @param {Array}  [events] 细粒度事件流（text/reasoning/llm_start/tool_end/retry/step_end）
 */
export async function updateProgress(taskId, step, steps, events) {
  // 事件流比老的 steps 大得多，单独一列存，两者互不影响。
  // 老前端读 steps，新前端读 events —— 都拿到自己那套。
  if (Array.isArray(events)) {
    await run(
      'UPDATE agent_tasks SET step = ?, steps = ?, events = ?, updated_at = ? WHERE id = ?',
      step,
      JSON.stringify(steps ?? []).slice(0, 60_000),
      JSON.stringify(events).slice(0, 400_000),
      nowIso(),
      taskId,
    );
    return;
  }
  await run(
    'UPDATE agent_tasks SET step = ?, steps = ?, updated_at = ? WHERE id = ?',
    step,
    JSON.stringify(steps ?? []).slice(0, 60_000),
    nowIso(),
    taskId,
  );
}

/**
 * 记录流式输出到一半的文本。
 *
 * 为什么要写库：用户刷新页面后还能看到「正在生成到哪儿」。
 * 但每来一个字都写库会把表写热，所以由调用方做节流（server 里 600ms 一次）。
 */
export async function updatePartial(taskId, partialText) {
  await run(
    'UPDATE agent_tasks SET result = ?, updated_at = ? WHERE id = ?',
    String(partialText ?? '').slice(0, 200_000),
    nowIso(),
    taskId,
  );
}

/** 跑完了：写最终回复 + 用量。 */
export async function finishTask(taskId, { text, steps, usage, cancelled = false }) {
  await run(
    `UPDATE agent_tasks SET status = ?, result = ?, steps = ?, token_usage = ?, updated_at = ?
      WHERE id = ?`,
    cancelled ? TASK_STATUS.CANCELLED : TASK_STATUS.DONE,
    String(text ?? ''),
    JSON.stringify(steps ?? []).slice(0, 60_000),
    usage ? `${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}` : '',
    nowIso(),
    taskId,
  );
}

/**
 * 用户点了停止：把任务标成 cancelled。
 * 和 done 分开是因为语义不同 —— 前端要显示「已停止」而不是「跑完了」。
 */
export async function cancelTask(taskId, { text, steps } = {}) {
  await run(
    'UPDATE agent_tasks SET status = ?, result = ?, steps = ?, updated_at = ? WHERE id = ?',
    TASK_STATUS.CANCELLED,
    String(text ?? ''),
    JSON.stringify(steps ?? []).slice(0, 60_000),
    nowIso(),
    taskId,
  );
}

/** 失败了：写错误信息（可选带上已经跑过的步骤，方便前端显示「卡在哪一步」）。 */
export async function failTask(taskId, message, steps = null) {
  const ts = nowIso();
  const text = String(message ?? '').slice(0, 2000);
  if (Array.isArray(steps) && steps.length) {
    await run(
      'UPDATE agent_tasks SET status = ?, error = ?, steps = ?, updated_at = ? WHERE id = ?',
      TASK_STATUS.FAILED, text, JSON.stringify(steps).slice(0, 60_000), ts, taskId,
    );
    return;
  }
  await run(
    'UPDATE agent_tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    TASK_STATUS.FAILED, text, ts, taskId,
  );
}

/** 取任务（给前端轮询）。 */
export async function findTask(taskId) {
  return get(
    `SELECT id, site_id, thread_id, user_id, model, status, step, steps, events, result, error, token_usage,
            created_at, updated_at
       FROM agent_tasks WHERE id = ?`,
    taskId,
  );
}

/**
 * 这个会话还有没有在跑的任务。
 * 用于「同一会话串行」——否则用户连发两条消息会同时跑两轮 agent，
 * 两轮都在改同一批文件，互相踩。
 */
export async function findLiveTaskByThread(threadId) {
  return get(
    `SELECT id, status FROM agent_tasks
      WHERE thread_id = ? AND status IN (?, ?)
      ORDER BY created_at DESC LIMIT 1`,
    threadId, LIVE[0], LIVE[1],
  );
}

/**
 * 列出某个会话的历史任务（用于刷新页面后恢复「执行过程」面板）。
 *
 * 为什么需要：events 存在 agent_tasks 表里，但历史接口以前只回消息，
 * 不回任务 —— 于是刷新一次，右边/上面的「已完成 · N 步操作」过程和
 * 思考内容全没了。这里按时间正序返回，前端能把过程和回复对应起来。
 *
 * @param {number} threadId
 * @param {number} limit 最多返回多少条
 */
export async function listTasksByThread(threadId, limit = 100) {
  return all(
    `SELECT id, site_id, thread_id, user_id, model, status, step, steps, events, result, error, token_usage,
            created_at, updated_at
       FROM agent_tasks
      WHERE thread_id = ?
      ORDER BY created_at ASC
      LIMIT ?`,
    threadId, limit,
  );
}

/** 有没有排队/在跑的任务（站点维度，用于提示「这个站正在改」）。 */
export async function countLiveTasksBySite(siteId) {
  const row = await get(
    `SELECT COUNT(*) AS c FROM agent_tasks
      WHERE site_id = ? AND status IN (?, ?)`,
    siteId, LIVE[0], LIVE[1],
  );
  return Number(row?.c ?? 0);
}

/**
 * 今天这个用户已经跑了多少轮（含失败）。
 * 按 UTC 日算——服务器时区可能和用户不一致，用 UTC 最不容易出歧义。
 */
export async function countTodayTurns(userId) {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const row = await get(
    'SELECT COUNT(*) AS c FROM agent_tasks WHERE user_id = ? AND created_at >= ?',
    userId, dayStart.toISOString(),
  );
  return Number(row?.c ?? 0);
}

/** 每日配额检查；超了抛带 code 的错误，调用方转成 429。 */
export async function assertDailyQuota(userId) {
  const used = await countTodayTurns(userId);
  if (used >= AGENT_DAILY_TURNS) {
    throw Object.assign(
      new Error(`今天的对话次数用完了（每天 ${AGENT_DAILY_TURNS} 轮），明天再来`),
      { code: 'AGENT_QUOTA_EXCEEDED', used, limit: AGENT_DAILY_TURNS },
    );
  }
  return { used, limit: AGENT_DAILY_TURNS };
}

/** 把超时的「排队中 / 跑着」任务标成失败（进程重启后残留的那些）。 */
export async function reapStaleTasks() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const result = await run(
    `UPDATE agent_tasks SET status = ?, error = ?, updated_at = ?
      WHERE status IN (?, ?) AND updated_at < ?`,
    TASK_STATUS.FAILED, '任务中断了（服务重启或超时），可以重新发一次',
    nowIso(), LIVE[0], LIVE[1], cutoff,
  );
  return result.changes;
}

/**
 * 清掉孤儿任务记录。
 *
 * **不再按时间删除**（2026-11 改）。原因：agent_tasks.events 里存着
 * 「执行过程」面板的数据（思考内容 / 工具调用 / 耗时），前端刷新页面后
 * 靠它重建面板。以前按 AGENT_TASK_TTL_HOURS 一刀切删掉，导致老对话的
 * 过程记录凭空消失（消息还在、过程没了，用户以为是 bug）。
 *
 * 现在的策略：**任务随对话一起保留，直到对话被删除**。
 * 会话删除时由 thread-lifecycle.js 显式清理；站点删除走级联。
 * 这里只兜底清理「会话已经不在了」的孤儿行，避免极端情况下留垃圾。
 */
export async function pruneTasks() {
  const result = await run(
    `DELETE t FROM agent_tasks t
      LEFT JOIN agent_threads th ON th.id = t.thread_id
      WHERE th.id IS NULL`,
  );
  return result.changes;
}

/**
 * 删掉某个会话的全部任务记录。
 *
 * 会话被删除时调用（见 thread-lifecycle.js）。agent_tasks 到 agent_threads
 * 虽然有外键级联，但显式删更直观，也避免依赖 FOREIGN_KEY_CHECKS 设置。
 */
export async function deleteTasksByThread(threadId) {
  const result = await run('DELETE FROM agent_tasks WHERE thread_id = ?', threadId);
  return result.changes;
}

/** 删掉某个站点全部会话的任务记录（站点删除时用）。 */
export async function deleteTasksBySite(siteId) {
  const result = await run('DELETE FROM agent_tasks WHERE site_id = ?', siteId);
  return result.changes;
}

/** 给前端渲染用的形状：steps / events 都是 JSON 字符串，转回数组。 */
export function publicTask(row) {
  if (!row) return null;
  let steps = [];
  try { steps = JSON.parse(row.steps || '[]'); } catch { steps = []; }
  let events = [];
  try { events = JSON.parse(row.events || '[]'); } catch { events = []; }
  return {
    id: row.id,
    status: row.status,
    step: row.step,
    steps,
    // 细粒度事件流：text / reasoning / llm_start / tool_end / retry / step_end
    events,
    text: row.result,
    error: row.error,
    model: row.model,
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { AGENT_DAILY_TURNS, AGENT_TASK_TTL_HOURS };
