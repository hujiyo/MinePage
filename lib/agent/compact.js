// 会话压缩：把很长的历史压成结构化摘要，只留最近的原文。
//
// 为什么需要：上下文窗口有限（哪怕 480k），几百轮对话迟早塞满。
// 压成摘要后，模型仍然「记得」之前做过什么，但只花几百 token。
//
// 与 checkpoint 的关系（重要）：
//   - checkpoint 存的是「图状态」（消息数组的完整快照），用于崩溃恢复
//   - 摘要存的是「语义压缩」（用户目标 / 已改了什么 / 下一步），用于长期记忆
//   两者不是一回事，都在 agent_threads 表上（summary / summary_upto 两列）。
//
// 水位线设计：summary_upto 记录「压到哪条消息 id」，保证增量幂等 ——
// 重复调用不会重复压同一段。

import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import {
  CONTEXT_COMPACT_AT_TOKENS,
  CONTEXT_KEEP_RECENT_TOKENS,
  CONTEXT_SUMMARY_MAX_CHARS,
} from '../config.js';
import { get, run } from '../db.js';
import { compactModelId, resolveModel } from './models.js';
import { modelApiKey } from './models.js';
import { estimateRowTokens, estimateTokens } from './tokens.js';

const nowIso = () => new Date().toISOString();

/**
 * 压缩用的 system prompt。
 *
 * 要点：
 *   - 明确说「这是给另一个 AI 看的背景」，不是给用户看的总结
 *   - 固定四节骨架，缺哪节就写「无」
 *   - 强调「具体到文件名和改动」，笼统的「优化了样式」没用
 *   - 限制长度，否则摘要会越压越长
 */
const COMPACT_SYSTEM = `你是一个对话压缩器。把下面这段「用户与建站 AI 的对话」压成结构化摘要，供另一个 AI 接手干活时当背景参考。

严格按这四节输出，不要加别的标题：

## 用户目标
这个会话到底要做什么。一到三句，具体到页面/功能。

## 已完成
列出已经做过的具体改动，每条一行。要写清楚**改了哪个文件、改成了什么**，例如：
- index.html：h1 从「欢迎」改成「你好」
- 新建 assets/style.css，把内联样式搬了过去

## 重要约束
用户明确要求过的限制、偏好、不能动的东西。没有就写「无」。

## 未完成 / 下一步
还没做完的事、已知的问题、用户提过但还没处理的需求。没有就写「无」。

要求：
- 只写事实，不要评价，不要写「我建议」
- 不要编造没发生过的事
- 总长度控制在 800 字以内`;

/**
 * 判断这个会话要不要压缩，返回要压哪些行。
 *
 * 判定用的是 token 而不是行数：同样 50 条，短对话可能才 2k token，
 * 长对话可能有 8 万 —— 按行数判断会误伤。
 *
 * 保留策略：从末尾往回数，攒够 CONTEXT_KEEP_RECENT_TOKENS 就停，
 * 那之前的一律拿去压。这样「最近聊的」永远是原文。
 *
 * @param {Array} rows 这个会话的全部消息行（正序，含 role/content/id）
 * @returns {{shouldCompact: boolean, toCompact: Array, keepFrom: number}}
 */
export function planCompaction(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return { shouldCompact: false, toCompact: [], keepFrom: 0 };
  }

  const totalTokens = rows.reduce((n, r) => n + estimateRowTokens(r), 0);
  if (totalTokens < CONTEXT_COMPACT_AT_TOKENS) {
    return { shouldCompact: false, toCompact: [], keepFrom: rows.length };
  }

  // 从末尾往回攒，直到够 CONTEXT_KEEP_RECENT_TOKENS
  let kept = 0;
  let cut = rows.length;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const t = estimateRowTokens(rows[i]);
    if (kept + t > CONTEXT_KEEP_RECENT_TOKENS) break;
    kept += t;
    cut = i;
  }

  // 一条都留不住（单条就超预算）时，至少留最后一条
  if (cut >= rows.length) cut = Math.max(0, rows.length - 1);

  return {
    shouldCompact: cut > 0,
    toCompact: rows.slice(0, cut),
    keepFrom: cut,
  };
}

/** 把消息行渲染成给压缩器看的纯文本。 */
function renderForCompact(rows) {
  return rows
    .map((r) => {
      const who = r.role === 'agent' ? 'AI' : '用户';
      const text = String(r.content ?? '').trim();
      if (!text) return '';
      return `${who}：${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 调模型压一段。
 *
 * 用 ChatOpenAI 而不是旧 llm.js 的 chat()：整个项目现在统一走 LangChain 的
 * 模型层（LangGraph 的节点也只认 BaseChatModel）。这样只有一套模型配置逻辑。
 *
 * @returns {Promise<string>} 摘要正文
 */
async function summarize({ previousSummary, rows }) {
  const modelId = compactModelId();
  const cfg = modelId ? resolveModel(modelId) : null;
  if (!cfg) throw Object.assign(new Error('压缩模型不可用'), { code: 'NO_COMPACT_MODEL' });

  const key = modelApiKey(cfg);
  if (!key) throw Object.assign(new Error(`压缩模型「${cfg.label}」缺少 API Key`), { code: 'NO_KEY' });

  const parts = [];
  if (previousSummary) {
    parts.push(`【已有摘要】（这是更早之前的对话压出来的，请合并进新摘要）\n${previousSummary}`);
  }
  const body = renderForCompact(rows);
  if (body) parts.push(`【新的对话】\n${body}`);
  if (!parts.length) return previousSummary || '';

  const historyText = parts.join('\n\n---\n\n');

  const model = new ChatOpenAI({
    model: cfg.model,
    apiKey: key,
    temperature: 0.1,
    // 压缩模型是思考型的（deepseek-v4.1-flash），它要先烧几百 token 推理。
    // 给 1200 会紧巴巴的 —— 实测摘要本身就要 150-300 token，
    // 加上思考 400-800，留 3000 才稳。
    maxTokens: 3000,
    configuration: { baseURL: String(cfg.baseURL).replace(/\/+$/, '') },
  });

  const reply = await model.invoke([
    new SystemMessage(COMPACT_SYSTEM),
    new HumanMessage(historyText),
  ]);

  const text = String(reply.content ?? '').trim();
  if (!text) throw Object.assign(new Error('压缩器返回了空摘要'), { code: 'EMPTY_SUMMARY' });

  // 兜底截断：模型偶尔会写超，硬切会把「未完成」那节切掉。
  // 所以先试按小节切，实在不行才硬截。
  if (text.length <= CONTEXT_SUMMARY_MAX_CHARS) return text;
  return trimSummary(text, CONTEXT_SUMMARY_MAX_CHARS);
}

/** 超长摘要的降级截断：优先保住「用户目标」和「未完成」。 */
function trimSummary(text, maxChars) {
  const sections = {};
  let current = 'head';
  for (const line of text.split('\n')) {
    const m = /^##\s*(.+)$/.exec(line);
    if (m) { current = m[1].trim(); sections[current] = []; continue; }
    if (sections[current]) sections[current].push(line);
  }

  const WANT = ['用户目标', '已完成', '重要约束', '未完成 / 下一步'];
  const out = [];
  let used = 0;
  for (const name of WANT) {
    const body = (sections[name] || []).join('\n').trim();
    if (!body) continue;
    const block = `## ${name}\n${body}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used - 20;
      if (room > 50) out.push(block.slice(0, room) + '\n…');
      break;
    }
    out.push(block);
    used += block.length + 2;
  }
  return out.length ? out.join('\n\n') : text.slice(0, maxChars);
}

/**
 * 压一个会话。
 *
 * @param {object} opt
 *   threadId  会话 id
 *   rows      这个会话的消息行（正序）
 * @returns {Promise<{compacted:boolean, summary:string, compactedCount:number,
 *                    beforeTokens:number, summaryTokens:number}>}
 */
export async function compactThread({ threadId, rows }) {
  const plan = planCompaction(rows);
  if (!plan.shouldCompact) {
    const existing = await getThreadSummary(threadId);
    return {
      compacted: false,
      summary: existing.summary,
      compactedCount: 0,
      beforeTokens: 0,
      summaryTokens: existing.summaryTokens,
    };
  }

  // 增量：只压水位线之后的行
  const existing = await getThreadSummary(threadId);
  const upto = existing.summaryUpto;
  const fresh = plan.toCompact.filter((r) => Number(r.id) > Number(upto));
  if (!fresh.length) {
    return {
      compacted: false,
      summary: existing.summary,
      compactedCount: 0,
      beforeTokens: 0,
      summaryTokens: existing.summaryTokens,
    };
  }

  const beforeTokens = fresh.reduce((n, r) => n + estimateRowTokens(r), 0);
  const summary = await summarize({ previousSummary: existing.summary, rows: fresh });
  const summaryTokens = estimateTokens(summary);
  const newUpto = Number(fresh[fresh.length - 1].id);

  await run(
    'UPDATE agent_threads SET summary = ?, summary_upto = ?, updated_at = ? WHERE id = ?',
    summary, newUpto, nowIso(), threadId,
  );

  return {
    compacted: true,
    summary,
    compactedCount: fresh.length,
    beforeTokens,
    summaryTokens,
  };
}

/** 读一个会话当前的摘要和水位线。 */
export async function getThreadSummary(threadId) {
  const row = await get(
    'SELECT summary, summary_upto FROM agent_threads WHERE id = ?',
    threadId,
  );
  const summary = String(row?.summary ?? '');
  return {
    summary,
    summaryUpto: Number(row?.summary_upto ?? 0),
    summaryTokens: estimateTokens(summary),
  };
}

/** 清掉摘要（用户点「重新整理」或者摘要坏了时用）。 */
export async function clearThreadSummary(threadId) {
  await run(
    'UPDATE agent_threads SET summary = NULL, summary_upto = 0, updated_at = ? WHERE id = ?',
    nowIso(), threadId,
  );
}

export { COMPACT_SYSTEM };
