// 对话压缩（Compaction）：把很长的历史压成结构化摘要。
//
// ============ 为什么需要 ============
//
// 实测模型窗口能吃到 450k+ token，但「能用」不等于「该用」：
//   - 成本：每轮都重发 20 万 token
//   - 延迟：450k token 的请求要 5 秒（有缓存），无缓存 10–20 秒
//   - 精度：长上下文里中段信息容易被稀释
//
// 所以设一条水位线：历史超过 100k token 就把旧的部分压成摘要，
// 只留最近 30k token 原文。压缩比约 7:1。
//
// ============ 摘要长什么样 ============
//
// 自由散文摘要会丢关键信息。用固定骨架，每一节都有明确用途：
//
//   ## 用户目标       <- 丢了这个模型会跑偏
//   ## 已完成         <- 丢了这个模型会重复劳动
//   ## 重要约束       <- 丢了这个模型会违反用户明确说过的规则
//   ## 未完成 / 下一步 <- 丢了这个模型会漏任务
//
// ============ 增量 + 嵌套 ============
//
// agent_threads 里存 summary + summary_upto（覆盖到哪条消息 id）。
// 下次只压 id > summary_upto 的部分，和旧摘要合并 —— 幂等、增量子。
// 摘要本身超过 3000 字符时，把「旧摘要 + 新消息」再压一次（摘要的摘要）。

import {
  CONTEXT_COMPACT_AT_TOKENS,
  CONTEXT_KEEP_RECENT_TOKENS,
  CONTEXT_SUMMARY_MAX_CHARS,
} from '../config.js';
import { get, run } from '../db.js';
import { chat } from './llm.js';
import { COMPACT_MODEL, resolveModel } from './models.js';
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
const COMPACT_SYSTEM = `你是一个对话压缩器。把下面这段「用户与建站 AI 的对话」压成结构化摘要，供另一个 AI 接着干活时当背景参考。

严格按这四节输出，不要加别的标题：

## 用户目标
这个会话到底要做什么。一到三句，具体到页面/功能。

## 已完成
列出已经做过的具体改动，每条一行。要写清楚**改了哪个文件、改成了什么**，例如：
- index.html：h1 从「欢迎」改成「你好」
- 新建 assets/style.css，把内联样式挪了过去
笼统的「优化了界面」没有价值，不要写。

## 重要约束
用户明确提过的要求、偏好、禁止事项。例如「要深色主题」「别动 footer」「用 Tailwind CDN」。
没有就写「无」。

## 未完成 / 下一步
用户提过但还没做的，或者正在做的。没有就写「无」。

要求：
- 全文不超过 800 字
- 只写事实，不要评价、不要客套、不要复述你的思考过程
- 用户说过原话里有关键约束的，尽量保留原话`;

/**
 * 判断一个会话是否需要压缩。
 *
 * @param {Array} rows 数据库消息行（正序）
 * @returns {{needed:boolean, tokens:number, keepFrom:number, compactRows:Array}}
 *   keepFrom 是「保留原文」的起始下标
 */
export function planCompaction(rows) {
  let total = 0;
  const tokens = [];
  for (const r of rows) {
    const t = estimateRowTokens(r);
    tokens.push(t);
    total += t;
  }

  if (total <= CONTEXT_COMPACT_AT_TOKENS) {
    return { needed: false, tokens: total, keepFrom: rows.length, compactRows: [] };
  }

  // 从最新往回数，攒够 KEEP_RECENT_TOKENS 就停
  let kept = 0;
  let keepFrom = rows.length;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (kept + tokens[i] > CONTEXT_KEEP_RECENT_TOKENS) break;
    kept += tokens[i];
    keepFrom = i;
  }

  return {
    needed: keepFrom > 0,
    tokens: total,
    keepFrom,
    compactRows: rows.slice(0, keepFrom),
  };
}

/** 把消息行渲染成给压缩器看的纯文本。 */
function renderForCompact(rows) {
  const lines = [];
  for (const r of rows) {
    const who = r.role === 'agent' ? 'AI' : '用户';
    const text = String(r.content ?? '').trim();
    if (!text) {
      // 纯图片消息：告诉压缩器这里发生过一次「看图」，
      // 否则它会以为这一段对话是空的
      if (String(r.attach_ids ?? '').trim()) lines.push(`${who}：[发了一张图片]`);
      continue;
    }
    lines.push(`${who}：${text}`);
  }
  return lines.join('\n\n');
}

/**
 * 调模型压一段。
 *
 * @returns {Promise<string>} 摘要正文
 */
async function summarize({ previousSummary, rows }) {
  const cfg = resolveModel(COMPACT_MODEL);
  if (!cfg) throw Object.assign(new Error('压缩模型不可用'), { code: 'NO_COMPACT_MODEL' });

  const parts = [];
  if (previousSummary) {
    parts.push(`【已有摘要】（这是更早之前的对话压出来的，请合并进新摘要）\n${previousSummary}`);
  }
  const body = renderForCompact(rows);
  if (body) parts.push(`【新的对话】\n${body}`);
  if (!parts.length) return previousSummary || '';

  const historyText = parts.join('\n\n---\n\n');

  const reply = await chat({
    cfg,
    messages: [
      { role: 'system', content: COMPACT_SYSTEM },
      { role: 'user', content: historyText },
    ],
    tools: [],
    temperature: 0.1,
    maxTokens: 1200,
  });

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
    // 「已完成」最长，优先砍它；目标和未完成各留 400 字符
    const cap = name === '已完成' ? Math.floor(maxChars * 0.45) : Math.floor(maxChars * 0.25);
    const piece = body.length > cap ? `${body.slice(0, cap)}…` : body;
    out.push(`## ${name}\n${piece}`);
    used += piece.length;
    if (used >= maxChars) break;
  }
  const result = out.join('\n\n');
  return result.length <= maxChars ? result : result.slice(0, maxChars);
}

/**
 * 对一个会话执行压缩（幂等：已经压过的部分不会重复处理）。
 *
 * @param {object} opt
 *   threadId  会话 id
 *   rows      这个会话的全部消息（正序），由调用方查好传进来
 * @returns {Promise<{compacted:boolean, summary?:string, upto?:number, reason?:string}>}
 */
export async function compactThread({ threadId, rows }) {
  const thread = await get('SELECT id, summary, summary_upto FROM agent_threads WHERE id = ?', threadId);
  if (!thread) return { compacted: false, reason: 'NO_THREAD' };

  const previousSummary = String(thread.summary ?? '');
  const upto = Number(thread.summary_upto ?? 0);

  // 只处理摘要还没覆盖到的部分
  const fresh = rows.filter((r) => Number(r.id) > upto);
  if (!fresh.length) return { compacted: false, reason: 'NOTHING_NEW' };

  const plan = planCompaction(fresh);
  if (!plan.needed) {
    return { compacted: false, reason: 'UNDER_THRESHOLD', tokens: plan.tokens };
  }

  try {
    const summary = await summarize({
      previousSummary,
      rows: plan.compactRows,
    });

    // 水位线：压到哪条消息为止
    const lastCompacted = plan.compactRows[plan.compactRows.length - 1];
    const newUpto = Number(lastCompacted.id);

    await run(
      'UPDATE agent_threads SET summary = ?, summary_upto = ?, updated_at = ? WHERE id = ?',
      summary, newUpto, nowIso(), threadId,
    );

    return {
      compacted: true,
      summary,
      upto: newUpto,
      compactedCount: plan.compactRows.length,
      beforeTokens: plan.tokens,
      summaryTokens: estimateTokens(summary),
    };
  } catch (err) {
    // 压缩失败**不能影响这一轮对话**：降级成「用原始历史，让 buildHistory 去裁」
    console.error('[compact]', threadId, err?.code ?? '', err?.message ?? err);
    return { compacted: false, reason: 'SUMMARY_FAILED', error: err?.message };
  }
}

/**
 * 读出会话的摘要状态，给 buildHistory 用。
 *
 * @returns {Promise<{summary:string, upto:number}>}
 */
export async function getThreadSummary(threadId) {
  const row = await get(
    'SELECT summary, summary_upto FROM agent_threads WHERE id = ?',
    threadId,
  );
  if (!row) return { summary: '', upto: 0 };
  return {
    summary: String(row.summary ?? ''),
    upto: Number(row.summary_upto ?? 0),
  };
}

/** 清掉摘要（用户在界面上点「重新开始」时用）。 */
export async function clearThreadSummary(threadId) {
  await run(
    "UPDATE agent_threads SET summary = '', summary_upto = 0, updated_at = ? WHERE id = ?",
    nowIso(), threadId,
  );
}

export { CONTEXT_COMPACT_AT_TOKENS, CONTEXT_KEEP_RECENT_TOKENS, CONTEXT_SUMMARY_MAX_CHARS };
