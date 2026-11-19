// 从 LangGraph 检查点里读对话历史。
//
// 背景：2026-11 把「历史存储」从 site_messages 迁到 LangGraph checkpoint。
// 以前的流程是 server.js 自己拼 [system + 历史 + user] 再 invoke，
// 和检查点里的历史叠加，导致每轮多一份 SystemMessage、旧 tool_calls 混进
// 新请求（网关直接 400）。现在检查点是唯一历史来源，这个模块负责把它
// 转成前端要的 { id, role, content, created_at } 形状。
//
// 为什么要「反着读」：checkpoint 每次存的是**当时的完整快照**，
// 要想展示整段对话，只读最新那一份就够（它包含全部历史）。
// 但如果最新一份正好卡在工具调用中间，也仍然包含之前所有轮次，所以依旧可用。

import { MySqlSaver } from './checkpoint-mysql.js';

let cachedSaver = null;
function saver() {
  if (!cachedSaver) cachedSaver = new MySqlSaver();
  return cachedSaver;
}

/** 和 loop.js 拼 graphThread 的规则一致。 */
export function threadKey(siteId, threadId) {
  return `site-${siteId}-thread-${threadId}`;
}

/**
 * 把 LangChain 消息对象转成前端认识的形状。
 *
 * 只保留「对用户有意义」的消息：
 *   - SystemMessage → 丢掉（内部提示词，不该给用户看）
 *   - HumanMessage  → role: 'user'
 *   - AIMessage     → role: 'agent'，content 为空但有工具调用的丢弃
 *   - ToolMessage   → 丢掉（工具结果是内部细节，前端有单独的 events 面板）
 */
function toClientMessage(msg, index) {
  const type = msg?._getType?.() ?? msg?.type ?? '';
  if (type === 'system') return null;
  if (type === 'tool') return null;

  const content = extractText(msg?.content);
  if (!content) return null;

  return {
    // 检查点里没有自增 id，用序号代替（前端只用它做 key，不依赖持久性）
    id: `ck-${index}`,
    role: type === 'human' ? 'user' : 'agent',
    content,
    // 检查点没存时间戳，用 created_at 让前端能排序就够了；真实时间在 agent_tasks
    created_at: '',
  };
}

/** LangChain 的 content 可能是字符串或 content-part 数组。 */
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => p.text ?? '')
      .join('')
      .trim();
  }
  return '';
}

/**
 * 读一个会话的完整对话历史（正序）。
 *
 * @param {number} siteId
 * @param {number} threadId
 * @returns {Promise<Array<{id:string, role:'user'|'agent', content:string, created_at:string}>>}
 */
export async function readThreadHistory(siteId, threadId) {
  try {
    const tuple = await saver().getTuple({
      configurable: { thread_id: threadKey(siteId, threadId) },
    });
    const raw = tuple?.checkpoint?.channel_values?.messages ?? [];
    return raw
      .map((m, i) => toClientMessage(m, i))
      .filter(Boolean);
  } catch {
    // 检查点读不出来不该让整页挂掉
    return [];
  }
}

/**
 * 读整站最近的历史（跨会话，给「不带 threadId」的老接口兜底）。
 *
 * 注意：这会把每个会话的历史串起来，语义上只适合「这个站最近聊了什么」的概览。
 * 新代码应该优先用 readThreadHistory。
 */
export async function readSiteHistory(siteId, threadIds = []) {
  const out = [];
  for (const tid of threadIds) {
    const list = await readThreadHistory(siteId, tid);
    out.push(...list);
  }
  return out;
}
