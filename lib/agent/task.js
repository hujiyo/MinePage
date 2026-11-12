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

/** 记录进度：第几步 + 已执行的工具摘要（JSON 数组）。 */
export async function updateProgress(taskId, step, steps) {
  await run(
    'UPDATE agent_tasks SET step = ?, steps = ?, updated_at = ? WHERE id = ?',
    step,
    JSON.stringify(steps ?? []).slice(0, 60_000),
    nowIso(),
    taskId,
  );
}

/** 跑完了：写最终回复 + 用量。 */
export async function finishTask(taskId, { text, steps, usage }) {
  await run(
    `UPDATE agent_tasks SET status = ?, result = ?, steps = ?, token_usage = ?, updated_at = ?
      WHERE id = ?`,
    TASK_STATUS.DONE,
    String(text ?? ''),
    JSON.stringify(steps ?? []).slice(0, 60_000),
    usage ? `${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}` : '',
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
    `SELECT id, site_id, thread_id, user_id, model, status, step, steps, result, error, token_usage,
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

/** 清掉过期任务记录（消息本身不会删，任务只是进度日志）。 */
export async function pruneTasks() {
  const cutoff = new Date(Date.now() - AGENT_TASK_TTL_HOURS * 3600_000).toISOString();
  const result = await run('DELETE FROM agent_tasks WHERE created_at < ?', cutoff);
  return result.changes;
}

/** 给前端渲染用的形状：steps 是 JSON 字符串，转回数组。 */
export function publicTask(row) {
  if (!row) return null;
  let steps = [];
  try { steps = JSON.parse(row.steps || '[]'); } catch { steps = []; }
  return {
    id: row.id,
    status: row.status,
    step: row.step,
    steps,
    text: row.result,
    error: row.error,
    model: row.model,
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { AGENT_DAILY_TURNS, AGENT_TASK_TTL_HOURS };
