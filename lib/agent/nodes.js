// 两个图节点的真实实现：agent（调模型）和 tools（执行工具）。
//
// 这里把现有的 prompt.js / tools.js / 模型层接到 LangGraph 上，
// 同时保留原有的对外契约：onEvent / onDelta / 折叠 / 预算。
//
// 关键设计：节点的返回值是「状态增量」，不是完整状态。
// LangGraph 的 reducer 负责把它合并进全局状态 —— 所以这里不需要手写
// messages.push()，也不需要维护 toolMessageIndexes 那种下标数组。

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { AGENT_MAX_STEPS, AGENT_TOOL_BUDGET_CHARS } from '../config.js';
import { runAgentTool, toolCatalog, toolSchemas } from './tools.js';
import { buildHistory, systemPrompt } from './prompt.js';
import { listSiteFiles } from '../sites.js';
import { toImagePart } from './attachments.js';

/** 折叠后的占位内容。和旧 loop.js 保持一致，便于对比。 */
const FOLDED = '{"note":"（这一步的结果已省略以节省上下文，需要的话请重新调用）"}';

/**
 * 把「文字 + 图片」拼成模型能吃的 user content。
 * 逻辑与旧 loop.js 的 buildUserContent 一致，只是返回 LangChain 的消息对象。
 */
function buildUserMessage(userText, attachments, cfg) {
  const imgs = Array.isArray(attachments) ? attachments.filter((a) => a && a.bytes?.length) : [];

  let text = String(userText ?? '').trim();
  if (!text && !imgs.length) text = '（用户没有输入文字）';

  // 没图：纯字符串最简单，老模型也认
  if (!imgs.length) return new HumanMessage(text);

  // 有图但模型看不了：降级成文字说明，不静默丢图
  if (!cfg?.supportsVision) {
    return new HumanMessage(
      `${text}\n\n（这条消息附了 ${imgs.length} 张图片，但当前模型「${cfg?.label ?? ''}」看不了图片。换个能看图的模型再问一次吧。）`,
    );
  }

  // 多模态：LangChain 的 content 数组格式
  const content = [{ type: 'text', text: text || '看看这些图片' }];
  for (const a of imgs) {
    const part = toImagePart(a.mime, a.bytes);
    // LangChain 用 { type:'image_url', image_url:{ url } }，和 OpenAI 一致
    content.push({ type: 'image_url', image_url: { url: part.image_url.url } });
  }
  return new HumanMessage({ content });
}

/**
 * 造 agent 节点。
 *
 * @param {object} opt
 *   model      LangChain 的 BaseChatModel（已 bindTools）
 *   cfg        模型配置（算预算、判断能不能看图）
 *   site       站点行
 *   mode       'code' 带工具 / 'chat' 不带
 *   summary    早期对话摘要
 *   signal     AbortSignal
 *   emit       事件回调（llm_start / retry / step_end）
 *   onDelta    流式回调
 *   onRetry    重试回调
 * @returns {Function} 节点函数
 */
export function makeAgentNode({
  model, cfg, site, mode, summary, signal, emit, onDelta, onRetry,
}) {
  return async (state) => {
    // 消息由调用方用 buildInitialMessages 拼好（system + 历史 + 本轮输入），
    // 这里只负责「折叠 → 调模型 → 产出增量」。
    const messages = foldToolResults(state.messages);

    const step = (state.steps ?? 0) + 1;
    const at = Date.now();
    emit?.({ type: 'llm_start', step, at });

    let reply;
    try {
      reply = await streamModel({ model, messages, signal, onDelta, onRetry });
    } catch (err) {
      // 取消：给出符合直觉的收尾，不当成失败
      if (signal?.aborted) {
        return {
          messages: [],
          finish: 'aborted',
          steps: step - 1,
        };
      }
      throw err;
    }

    emit?.({ type: 'step_end', step, reason: reply.tool_calls?.length ? 'tools' : 'done', ms: Date.now() - at, at: Date.now() });

    // 步数到顶且还有工具要调：不再执行，直接收尾
    const calls = reply.tool_calls ?? [];
    const hitMax = calls.length > 0 && step >= AGENT_MAX_STEPS;

    return {
      messages: [reply],
      steps: step,
      usage: {
        inputTokens: Number(reply.usage_metadata?.input_tokens ?? 0),
        outputTokens: Number(reply.usage_metadata?.output_tokens ?? 0),
      },
      reasoning: reply.additional_kwargs?.reasoning ?? '',
      // finish 一旦置上，条件边就结束循环
      finish: hitMax ? 'max-steps' : '',
    };
  };
}

/**
 * 调模型并把流式增量转出去。
 *
 * LangChain 的 .stream() 产出 AIMessageChunk，要手动拼成完整 AIMessage。
 * 拼装必须用 AIMessageChunk.concat()，不能自己拼字符串 ——
 * 否则 tool_calls 会被拆散（OpenAI 的流式里 tool_calls 是按 index 分片的）。
 */
async function streamModel({ model, messages, signal, onDelta, onRetry }) {
  let lastErr = null;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let started = false;
    try {
      const stream = await model.stream(messages, { signal });
      let acc = null;

      for await (const chunk of stream) {
        // 正文增量：只有非空才对用户可见
        const textDelta = extractText(chunk);
        if (textDelta) {
          started = true;
          onDelta?.(textDelta, 'text');
        }
        // 思考增量（reasoning 模型才有）
        const reasoningDelta = chunk.additional_kwargs?.reasoning_content
          ?? chunk.additional_kwargs?.reasoning
          ?? '';
        if (reasoningDelta) onDelta?.(String(reasoningDelta), 'reasoning');

        // 拼装完整消息
        acc = acc === null ? chunk : acc.concat(chunk);
      }

      if (!acc) throw new Error('模型没有返回任何内容');
      return acc;
    } catch (err) {
      lastErr = err;
      const retryable = !started && !signal?.aborted && isRetryableErr(err) && attempt < maxRetries;
      if (!retryable) throw err;
      const wait = 500 * 2 ** attempt + Math.random() * 200;
      onRetry?.(err, attempt + 1, maxRetries, Math.round(wait));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/** 从 chunk 里取文本增量。LangChain 的 content 可能是字符串或数组。 */
function extractText(chunk) {
  const c = chunk?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
  }
  return '';
}

/** 哪些错误值得重试。和旧 llm.js 的 isRetryable 口径一致。 */
function isRetryableErr(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (status >= 500) return true;
  const name = String(err?.name ?? '');
  if (name.includes('Timeout') || name.includes('Abort')) return false;  // 取消不重试
  const msg = String(err?.message ?? '');
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return true;
  return false;
}

/**
 * 造 tools 节点：把上一条 assistant 消息里的 tool_calls 逐个执行。
 *
 * 注意：这里必须为每个 tool_call 产出对应的 ToolMessage，
 * 且 tool_call_id 要一一对上，否则下一轮模型会报错。
 */
export function makeToolsNode({ siteId, userId, signal, emit, onStep }) {
  return async (state) => {
    const last = state.messages[state.messages.length - 1];
    const calls = last?.tool_calls ?? [];

    const outMessages = [];
    const summaries = [];
    let chars = 0;

    for (const call of calls) {
      if (signal?.aborted) break;

      const name = call.name ?? '';
      const args = call.args ?? {};
      const callId = call.id ?? `call_${Date.now()}_${summaries.length}`;

      let payload;
      let ok = true;
      const start = Date.now();

      try {
        payload = await runAgentTool(name, args, { siteId, userId });
      } catch (err) {
        ok = false;
        // 业务错误原样告诉模型，它才知道怎么改
        payload = { error: err?.message ?? String(err) };
      }

      const ms = Date.now() - start;
      const body = JSON.stringify(payload);
      chars += body.length;

      const summary = {
        name,
        ok,
        path: typeof args?.path === 'string' ? args.path : null,
        error: ok ? null : payload.error,
        ms,
      };
      summaries.push(summary);

      onStep?.({ name, args, ok, error: summary.error, path: summary.path });
      emit?.({
        type: 'tool_end',
        name,
        ok,
        path: summary.path,
        error: summary.error,
        bytes: typeof payload?.size === 'number' ? payload.size : null,
        ms,
        at: Date.now(),
      });

      outMessages.push(new ToolMessage({ content: body, tool_call_id: callId }));
    }

    return {
      messages: outMessages,
      toolCalls: summaries,
      toolChars: chars,
    };
  };
}

/**
 * 折叠旧工具结果：只保留最近两条，更早的换成占位。
 *
 * 与旧 loop.js 的差异：LangChain 的 ToolMessage.content 可能是数组，
 * 所以这里统一转成 JSON 字符串再判断长度。
 */
export function foldToolResults(messages) {
  const idx = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?._getType?.() === 'tool') idx.push(i);
  }
  if (idx.length <= 2) return messages;

  let total = 0;
  for (const i of idx) total += String(messages[i].content ?? '').length;
  if (total <= AGENT_TOOL_BUDGET_CHARS) return messages;

  const out = messages.slice();
  for (const i of idx.slice(0, -2)) {
    if (total <= AGENT_TOOL_BUDGET_CHARS) break;
    const old = String(out[i].content ?? '');
    if (old === FOLDED) continue;
    total -= old.length - FOLDED.length;
    out[i] = new ToolMessage({ content: FOLDED, tool_call_id: out[i].tool_call_id });
  }
  return out;
}

/** 把初始输入拼成 LangChain 消息（system + 历史 + 本轮用户消息）。 */
export async function buildInitialMessages({ site, cfg, mode, summary, history, userText, attachments }) {
  const files = mode === 'code' ? await listSiteFiles(site.id) : [];
  const out = [new SystemMessage(systemPrompt(site, files, { mode, summary, maxSteps: AGENT_MAX_STEPS }))];

  for (const h of buildHistory(history, cfg, undefined, summary)) {
    out.push(h.role === 'assistant' ? new AIMessage(h.content) : new HumanMessage(h.content));
  }

  out.push(buildUserMessage(userText, attachments, cfg));
  return out;
}

export { buildUserMessage, toolSchemas, toolCatalog };
