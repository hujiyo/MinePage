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
import { deriveTrace } from './trace.js';

const nowIso = () => new Date().toISOString();

/**
 * 把一个数组序列化成「保证合法」的 JSON，超长时**从头部丢元素**而不是切字符串。
 *
 * 为什么必须这样：以前的写法是
 *   JSON.stringify(events).slice(0, 400_000)
 * 对 JSON **字符串**做 slice 会把它切成半截（末尾 `}]` 被削掉），
 * 前端 publicTask() 里 JSON.parse 失败 → catch 兜成 [] →
 * **整个「执行过程」面板凭空消失**，而且不可恢复（数据已经烂在库里了）。
 *
 * 这里改成：序列化**整个数组**，超限就从最老的开始丢，直到装得下。
 * 丢掉的是最老的几步，保留最近的过程 —— 用户关心的是「刚才发生了什么」。
 *
 * @param {Array} list
 * @param {number} limit 字符上限
 * @returns {string} 一定能被 JSON.parse 的字符串
 */
function stringifyCapped(list, limit) {
  const arr = Array.isArray(list) ? list : [];
  let json = JSON.stringify(arr);
  if (json.length <= limit) return json;

  // 从头部丢，二分找「能装下的最小后缀」比逐个丢快得多
  let lo = 0;
  let hi = arr.length;
  let best = JSON.stringify([]);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = JSON.stringify(arr.slice(mid));
    if (candidate.length <= limit) {
      best = candidate;
      hi = mid - 1;      // 还能再多留一点
    } else {
      lo = mid + 1;      // 丢得不够，继续丢
    }
  }
  return best;
}

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

/**
 * 建一条排队中的任务。
 *
 * **userText / attachIds 是必须要存的**（不是可选装饰）：
 * 一个任务行现在要独立画出「用户气泡 + 过程面板 + 回复气泡」这一整组 UI，
 * 少存用户输入就画不出用户气泡 —— 以前这块数据只存在检查点里，
 * 导致刷新后得靠「回复正文内容」去猜哪个任务配哪个气泡，一猜错面板就消失。
 *
 * @param {object} opt
 *   siteId / threadId / userId / model
 *   userText   用户这一轮说的话（只发图不打字时是空串）
 *   attachIds  这一轮带的图片 id 数组
 */
export async function createTask({ siteId, threadId, userId, model, userText = '', attachIds = [] }) {
  const id = newTaskId();
  const ts = nowIso();

  // 附件 id 只留正整数，逗号拼接（沿用 site_messages 的老约定，查询时少一种分支）
  const ids = (Array.isArray(attachIds) ? attachIds : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .join(',');

  await run(
    `INSERT INTO agent_tasks
       (id, site_id, thread_id, user_id, model, user_text, attach_ids, status, step, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    id, siteId, threadId, userId, String(model ?? ''),
    String(userText ?? ''), ids,
    TASK_STATUS.QUEUED, ts, ts,
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
      stringifyCapped(steps, 60_000),
      stringifyCapped(events, 400_000),
      nowIso(),
      taskId,
    );
    return;
  }
  await run(
    'UPDATE agent_tasks SET step = ?, steps = ?, updated_at = ? WHERE id = ?',
    step,
    stringifyCapped(steps, 60_000),
    nowIso(),
    taskId,
  );
}

/* ------------------------------------------------------------------
   事件流（v2，append-only）

   和上面的 updateProgress 并行存在，不是替代关系：
     - updateProgress 写 agent_tasks.events 的「整包快照」，历史任务靠它（v1 回退）
     - 这里的 appendEvents 写 agent_task_events 的「一行一个事件」，新任务靠它

   为什么要两套一起写：老数据必须还能读（用户的历史对话里有 v1 事件），
   但新数据不能再受「整包重写 + 截断」的害。等确认所有活跃会话都是 v2 之后，
   可以把 updateProgress 的 events 参数停掉。
   ------------------------------------------------------------------ */

/** 单个事件 data 的序列化上限：超了说明事件本身异常，宁可丢也不写坏行。 */
const EVENT_DATA_LIMIT = 60_000;

/** 一个任务最多记多少条事件。到顶后只保留关键事件（工具/轮次），丢 delta。 */
const EVENT_COUNT_LIMIT = 20_000;

/** 关键事件：即使到顶也要记。 */
const UI_KEY_EVENTS = new Set(['turn_start', 'turn_end', 'tool_start', 'tool_end', 'retry', 'step_end', 'llm_start']);

/**
 * 追加若干事件（只 INSERT）。
 *
 * @param {string} taskId
 * @param {Array} list 事件数组
 * @param {number} [startSeq] 这批事件的起始 seq（调用方维护游标，保证不撞主键）
 * @returns {Promise<number>} 写入后应该用的下一个 seq
 */
export async function appendEvents(taskId, list, startSeq = 1) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return startSeq;

  let seq = Number(startSeq) || 1;
  const rows = [];

  for (const ev of arr) {
    if (!ev || typeof ev !== 'object') continue;

    const type = String(ev.type ?? 'event').slice(0, 32);
    // 到顶保护：非关键事件直接跳过（不报错，主流程不能因为日志满了中断）
    if (seq > EVENT_COUNT_LIMIT && !UI_KEY_EVENTS.has(type)) continue;

    let data = JSON.stringify(ev);
    if (data.length > EVENT_DATA_LIMIT) continue;   // 异常大的事件直接丢，别写坏行

    rows.push([taskId, seq, type, Number(ev.at ?? ev.t) || Date.now(), data]);
    seq += 1;
  }

  if (!rows.length) return seq;

  // 一条 INSERT 写多行：比逐条 await 快一个数量级
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const flat = rows.flat();
  await run(
    `INSERT IGNORE INTO agent_task_events (task_id, seq, type, t, data) VALUES ${placeholders}`,
    ...flat,
  );

  return seq;
}

/**
 * 读一个任务的全部事件（按 seq 正序）。
 *
 * 兼容策略：新表没有数据就回退读 agent_tasks.events（v1 JSON 数组）。
 * 这样**老对话的执行过程不会因为这次改造而消失**。
 *
 * @param {object} taskRow agent_tasks 的行（要它来读 v1 的 events 列）
 * @returns {Promise<Array>} 事件数组（v2 或 v1 原样，交给 trace.js 归一化）
 */
export async function loadTaskEvents(taskRow) {
  if (!taskRow?.id) return [];

  const rows = await all(
    'SELECT seq, type, t, data FROM agent_task_events WHERE task_id = ? ORDER BY seq ASC',
    taskRow.id,
  );

  const v2 = parseEventRows(rows);
  return mergeWithV1(v2, taskRow);
}

/**
 * 把 agent_task_events 的行解析成事件数组。坏行跳过，不让一行烂数据毁掉整个面板。
 */
function parseEventRows(rows) {
  const out = [];
  for (const r of rows ?? []) {
    try {
      const ev = JSON.parse(r.data);
      if (!Number(ev.at) && !Number(ev.t)) ev.at = Number(r.t) || 0;
      out.push(ev);
    } catch {
      // 跳过坏行
    }
  }
  return out;
}

/**
 * 解析 v1 的整包 JSON（agent_tasks.events 列）。
 * 解析失败返回 null —— 老代码用字符串 slice 截断过，确实可能有坏数据。
 */
function parseV1Events(taskRow) {
  if (!taskRow?.events) return null;
  try {
    const parsed = JSON.parse(taskRow.events);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * v2 表有数据，但**可能比我实际发出的事件少** —— 用 v1 补齐。
 *
 * 为什么需要这一步：
 *   2026-11 修复过一个 seq 竞态 bug —— pushEvents 是同步连续调用的，
 *   而 eventSeq 原来在 Promise 的 then 里才更新，导致两批事件用了重叠的 seq，
 *   agent_task_events 的主键 (task_id, seq) 上有 INSERT IGNORE，**后写的那批
 *   整行被静默丢弃**。现场症状：tool_start 有 5 条、tool_end 只剩 2 条，
 *   界面上工具行有「开始」没「结果」，看着像过程丢了。
 *
 *   那个 bug 已经修了，但**已经写坏的历史数据不会自己恢复**。
 *   好在那段时间 v1 列（agent_tasks.events）是完整的，因为它是整包覆盖写。
 *
 * 补齐策略：只补「v1 有、v2 缺」的那几类事件，不动已有的 v2 事件。
 *   - tool_end：按 (name, path) 计数差补
 *   - step_end / turn_end：计数差补（收尾标记丢了会让整轮显示成「还在跑」）
 * 只在这些「结构性」事件上补，thinking 增量不补 ——
 * 补思考内容容易补出重复，而思考丢失只是少看一段，不会让界面错乱。
 *
 * @param {Array} v2 新表里的事件
 * @param {object} taskRow 任务行（含 v1 的 events 列）
 * @returns {Array}
 */
function mergeWithV1(v2, taskRow) {
  const v1 = parseV1Events(taskRow);
  if (!v1 || !v1.length) return v2;
  // 新表完全没数据：整份用 v1（保留原有语义，也兼容从未写过新表的旧任务）
  if (!v2.length) return v1;

  // 按类型 + 关键字段计数
  const keyOf = (e) => {
    if (!e) return '';
    switch (e.type) {
      case 'tool_start':
      case 'tool_end':
        return `${e.type}|${e.name ?? ''}|${e.path ?? ''}`;
      case 'step_end':
        return `${e.type}|${e.step ?? ''}`;
      case 'turn_end':
        return `${e.type}|${e.turn ?? ''}`;
      case 'retry':
        return `${e.type}|${e.attempt ?? ''}`;
      default:
        return e.type ?? '';
    }
  };

  const count = (list) => {
    const m = new Map();
    for (const e of list) {
      const k = keyOf(e);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };

  const v2Count = count(v2);
  const v1Count = count(v1);

  // 找出 v1 里有富余的结构性事件
  const STRUCTURAL = new Set(['tool_end', 'step_end', 'turn_end', 'retry']);
  const missing = [];
  for (const e of v1) {
    const k = keyOf(e);
    if (!STRUCTURAL.has(e?.type)) continue;
    const have = v2Count.get(k) ?? 0;
    const want = v1Count.get(k) ?? 0;
    if (want > have) {
      missing.push(e);
      v1Count.set(k, want - 1);   // 同一个 key 只补差量
    }
  }

  if (!missing.length) return v2;

  // 合并后按时间排序；没有时间的排在最后
  const merged = [...v2, ...missing];
  merged.sort((a, b) => {
    const ta = Number(a?.at ?? a?.t) || 0;
    const tb = Number(b?.at ?? b?.t) || 0;
    if (ta && tb) return ta - tb;
    return 0;
  });
  return merged;
}

/**
 * 批量读多个任务的事件（历史接口用）。
 *
 * 一次查完，避免 N+1：一个会话 50 条任务就是 50 次查询，翻页会明显变慢。
 *
 * @param {Array<object>} taskRows
 * @returns {Promise<Map<string, Array>>} taskId → 事件数组
 */
export async function loadEventsForTasks(taskRows) {
  const rows = Array.isArray(taskRows) ? taskRows.filter((r) => r?.id) : [];
  const map = new Map();
  if (!rows.length) return map;

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(', ');
  const dbRows = await all(
    `SELECT task_id, seq, type, t, data FROM agent_task_events
      WHERE task_id IN (${placeholders}) ORDER BY task_id, seq ASC`,
    ...ids,
  );

  for (const r of dbRows ?? []) {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    try {
      const ev = JSON.parse(r.data);
      if (!Number(ev.at) && !Number(ev.t)) ev.at = Number(r.t) || 0;
      map.get(r.task_id).push(ev);
    } catch { /* 坏行跳过 */ }
  }

  // 每个任务都过一遍 mergeWithV1：
  // 新表没数据 → 整份用 v1；新表残缺（seq 竞态那批旧数据）→ 补上缺的结构性事件。
  for (const row of rows) {
    map.set(row.id, mergeWithV1(map.get(row.id) ?? [], row));
  }

  return map;
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
    stringifyCapped(steps, 60_000),
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
    stringifyCapped(steps, 60_000),
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
      TASK_STATUS.FAILED, text, stringifyCapped(steps, 60_000), ts, taskId,
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
    `SELECT id, site_id, thread_id, user_id, model, user_text, attach_ids,
            status, step, steps, events, result, error, token_usage,
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
    `SELECT id, site_id, thread_id, user_id, model, user_text, attach_ids,
            status, step, steps, events, result, error, token_usage,
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

/**
 * 给前端渲染用的形状：steps / events 都是 JSON 字符串，转回数组。
 *
 * @param {object} row agent_tasks 的行
 * @param {Array} [eventsOverride] 已经单独读好的事件（v2 表）。传了就用它，
 *        不再解析 row.events —— 历史接口批量读时走这条路，避免 N+1。
 */
export function publicTask(row, eventsOverride = null) {
  if (!row) return null;
  let steps = [];
  try { steps = JSON.parse(row.steps || '[]'); } catch { steps = []; }

  let events = [];
  if (Array.isArray(eventsOverride)) {
    events = eventsOverride;
  } else {
    // v1 回退：老数据只有 row.events 这一份
    try { events = JSON.parse(row.events || '[]'); } catch { events = []; }
  }

  // 附件 id：逗号拼接存，前端要数组。空串 → []
  const attachIds = String(row.attach_ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  return {
    id: row.id,
    status: row.status,
    step: row.step,
    steps,
    // 细粒度事件流（v1/v2 混合，前端统一走 trace.js 归一化）
    events,
    /**
     * 用户这一轮的输入 —— **渲染用户气泡就靠它**。
     *
     * 以前这块只在 LangGraph 检查点里，前端必须从检查点拿气泡、再从本表拿面板，
     * 两套数据靠「回复正文内容」硬匹配；一旦对不上（比如中断轮），面板就消失。
     * 现在任务自带用户输入，一个任务行 = 一整组 UI，不需要任何跨表配对。
     *
     * 老任务是 null：前端据此**跳过用户气泡**（而不是画一个空的）。
     */
    userText: row.user_text ?? null,
    attachIds,
    /**
     * 已经算好的视图模型（步骤卡片 / family 分类 / 已读已改文件 / 统计）。
     *
     * 为什么在后端算：**归一化逻辑必须只有一份**。
     * 以前实时渲染和历史重建各写一套「怎么分组、怎么去重」，
     * 两边理解不一致，用户就报「刷新后轮次和图标全对不上」。
     * 现在 deriveTrace 是纯函数，后端算完直接给前端画，
     * 实时（轮询）和历史（刷新）拿到的必然是同一种结构。
     */
    view: deriveTrace(events, { status: row.status, text: row.result }),
    text: row.result,
    error: row.error,
    model: row.model,
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { AGENT_DAILY_TURNS, AGENT_TASK_TTL_HOURS };
