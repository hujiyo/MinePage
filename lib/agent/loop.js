// 一轮 agent 的主循环 —— LangGraph 版。
//
// 旧版是手写 for 循环（340 行），这里改成 StateGraph：
// 每走完一个 superstep，checkpointer 自动存一份完整状态，崩溃后能续跑。
//
// 对外契约保持不变（server.js 一行不用改）：
//   runAgent({ cfg, site, userId, history, userText, mode, attachments, summary,
//              signal, onStep, onEvent, onRetry, onDelta, threadId })
//   → { text, reasoning, steps, toolCalls, usage, aborted, abortedByUser }
//
// 图的结构见 graph.js：
//   START → agent ⇄ tools → END

import { ChatOpenAI } from '@langchain/openai';
import { AGENT_MAX_STEPS, AGENT_TIMEOUT_MS } from '../config.js';
import { LlmError } from './errors.js';
import { modeUsesTools, modelApiKey } from './models.js';
import { toolSchemas } from './tools.js';
import { buildAgentGraph } from './graph.js';
import { MySqlSaver } from './checkpoint-mysql.js';
import { buildInitialMessages, makeAgentNode, makeToolsNode } from './nodes.js';

/** 全局共用一个 saver 实例：它无状态，只是把读写转到数据库。 */
let sharedSaver = null;
function saver() {
  if (!sharedSaver) sharedSaver = new MySqlSaver();
  return sharedSaver;
}

/**
 * 把 models.js 的模型配置转成 LangChain 的 ChatOpenAI。
 *
 * 为什么用 ChatOpenAI 而不是 AI SDK：LangGraph 的节点只认 BaseChatModel。
 * 好在绝大多数网关都说 OpenAI 协议，改 configuration.baseURL 就能接。
 */
function makeModel(cfg, useTools) {
  const key = modelApiKey(cfg);
  if (!key) throw new LlmError(`模型「${cfg.label}」缺少 API Key`, 'AUTH');

  const model = new ChatOpenAI({
    model: cfg.model,
    apiKey: key,
    temperature: 0.2,
    maxTokens: Number(cfg.maxOutput) || 8_192,
    configuration: {
      baseURL: String(cfg.baseURL).replace(/\/+$/, ''),
    },
  });

  // 工具清单只在 code 模式下给。不给的话模型物理上就调不了工具。
  if (!useTools) return model;

  const tools = toolSchemas().map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
  return model.bindTools(tools);
}

/**
 * 跑一轮 agent。
 *
 * @param {object} opt 见文件头的契约说明
 * @returns {Promise<object>}
 */
export async function runAgent({
  cfg,
  site,
  userId,
  history = [],
  userText,
  mode = 'code',
  attachments = [],
  summary = '',
  onStep,
  onEvent,
  onRetry,
  onDelta,
  signal,
  threadId,
}) {
  /** 统一事件出口。所有「值得让用户看见的过程」都从这里出去。 */
  const emit = (event) => {
    if (!onEvent) return;
    try { onEvent(event); } catch { /* 回调出错不影响主流程 */ }
  };

  const useTools = modeUsesTools(mode);

  // 整轮超时：用 AbortController，区分「整轮超时」和「单次请求超时」
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  let abortedByUserFlag = false;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      signal.addEventListener('abort', () => {
        abortedByUserFlag = true;
        controller.abort();
      }, { once: true });
    }
  }

  const model = makeModel(cfg, useTools);

  // 初始消息：system + 历史 + 本轮输入。由 nodes.js 拼好。
  const initialMessages = await buildInitialMessages({
    site, cfg, mode, summary, history, userText, attachments,
  });

  const agentNode = makeAgentNode({
    model, cfg, site, mode, summary,
    signal: controller.signal,
    emit,
    onDelta,
    onRetry,
  });

  const toolsNode = makeToolsNode({
    siteId: site.id,
    userId,
    signal: controller.signal,
    emit,
    onStep,
  });

  const app = buildAgentGraph({
    agentNode,
    toolsNode,
    maxSteps: AGENT_MAX_STEPS,
    checkpointer: saver(),
  });

  // LangGraph 的 thread_id：用站点 + 会话拼，保证一个会话一条检查点链
  const graphThread = threadId
    ? `site-${site.id}-thread-${threadId}`
    : `site-${site.id}-adhoc-${Date.now()}`;

  const config = { configurable: { thread_id: graphThread } };

  try {
    const final = await app.invoke({ messages: initialMessages, steps: 0 }, config);

    // 从最终状态里取回复正文：最后一条 assistant 消息的文本
    const msgs = final.messages ?? [];
    let lastAi = null;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?._getType?.() === 'ai') { lastAi = msgs[i]; break; }
    }
    const text = String(lastAi?.content ?? '').trim() || '（模型这次没有输出内容）';

    const aborted = final.finish === 'max-steps' || final.finish === 'aborted';
    const byUser = final.finish === 'aborted' && abortedByUserFlag;

    let replyText = text;
    if (final.finish === 'aborted') {
      replyText = byUser
        ? '好的，停在这儿了。已经改的地方都保留着，想接着改就再说一句。'
        : '这一轮跑太久了，先停一下。要我接着弄吗？';
    } else if (final.finish === 'max-steps') {
      replyText = `改了 ${AGENT_MAX_STEPS} 步还没收尾，先停下。你可以看看预览，告诉我接下来怎么改。`;
    }

    return {
      text: replyText,
      reasoning: final.reasoning ?? '',
      steps: final.steps ?? 0,
      toolCalls: final.toolCalls ?? [],
      usage: final.usage ?? { inputTokens: 0, outputTokens: 0 },
      aborted,
      abortedByUser: byUser,
      checkpointThread: graphThread,
    };
  } catch (err) {
    // 取消导致的异常：给出符合直觉的收尾，不当成失败
    if (controller.signal.aborted) {
      return {
        text: abortedByUserFlag
          ? '好的，停在这儿了。已经改的地方都保留着，想接着改就再说一句。'
          : '这一轮跑太久了，先停一下。要我接着弄吗？',
        reasoning: '',
        steps: 0,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        aborted: true,
        abortedByUser: abortedByUserFlag,
        checkpointThread: graphThread,
      };
    }
    if (err instanceof LlmError) throw err;
    throw new LlmError(
      err?.message ?? '模型调用失败',
      err?.code ?? 'UNKNOWN',
      String(err?.stack ?? '').slice(0, 300),
    );
  } finally {
    clearTimeout(timer);
  }
}

export { AGENT_MAX_STEPS };
