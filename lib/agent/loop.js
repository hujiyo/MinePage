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
import { AGENT_IDLE_TIMEOUT_MS, AGENT_MAX_STEPS, AGENT_TOOL_TIMEOUT_MS } from '../config.js';
import { LlmError } from './errors.js';
import { modeUsesTools, modelApiKey } from './models.js';
import { toolSchemas } from './tools.js';
import { buildAgentGraph } from './graph.js';
import { MySqlSaver } from './checkpoint-mysql.js';
import { buildTurnMessages, isAbortError, makeAgentNode, makeToolsNode } from './nodes.js';
import { makeReasoningFetch } from './reasoning-fetch.js';

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
      // 网关返回的思考内容字段名是 `reasoning`，而 @langchain/openai 只认
      // `reasoning_content`，不补这一手的话思考内容会被静默丢弃（实测全空）。
      // 详见 reasoning-fetch.js 的注释。
      fetch: makeReasoningFetch(),
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
 * 模型返回空正文时，根据 finish_reason 给出能指导用户下一步的说明。
 *
 * 这个函数存在的意义：以前不管什么原因都显示「（模型这次没有输出内容）」，
 * 用户完全不知道是自己要调配置、还是模型坏了、还是网络问题。
 *
 * finish_reason 的常见值（OpenAI 兼容协议）：
 *   length  —— 输出 token 用完了（思考型模型最常见的坑：思考烧光预算，正文没写）
 *   stop    —— 正常结束但正文确实为空（少见，通常是模型抽风）
 *   content_filter —— 被安全策略拦了
 */
function emptyReplyMessage(finishReason, cfg) {
  const budget = Number(cfg?.maxOutput) || 8192;

  if (finishReason === 'length') {
    if (cfg?.reasoning) {
      return `模型把 ${budget} token 的输出预算全用在「思考」上了，没来得及写正文。\n\n`
        + `建议：把「输出上限」调大（当前 ${budget}），或者换一个非思考型模型。`;
    }
    return `模型输出被截断了（用完 ${budget} token 上限），正文没写完。\n\n`
      + `建议：把「输出上限」调大（当前 ${budget}），或者让它分几次写。`;
  }

  if (finishReason === 'content_filter') {
    return '模型输出的内容被安全策略拦下了（finish_reason=content_filter），换个说法再试试。';
  }

  if (finishReason === 'stop') {
    return '模型正常结束了，但这一轮没有产生任何正文（可能只调了工具）。可以再发一条让它总结一下。';
  }

  return `模型没有返回正文（finish_reason=${finishReason ?? '未知'}）。可以再试一次，或换个模型。`;
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

  /**
   * 重试事件的唯一出口。
   *
   * 这里以前是个断掉的链：nodes.js 老老实实调 `onRetry?.(...)`，
   * 但 server.js 调 runAgent 时**根本没传 onRetry**，所以重试永远无声无息 ——
   * 前端 studio.js 里那套 `is-retry` 渲染、style.css 的重试样式全是死代码。
   *
   * 现在改成：不管调用方有没有传 onRetry，都**先发一条事件**（事件流是主渠道），
   * 再调 onRetry（旧回调，保留兼容）。这样「重试记录」不再依赖调用方记不记得传参。
   */
  let retrySeq = 0;
  const onRetryEvent = (err, attempt, maxRetries, waitMs) => {
    retrySeq += 1;
    emit({
      type: 'retry',
      attempt,
      maxRetries,
      waitMs,
      retryId: `retry-${retrySeq}`,
      failure: {
        code: err?.code ?? err?.status ?? 'UNKNOWN',
        message: String(err?.message ?? '').slice(0, 200),
      },
      at: Date.now(),
    });
    onRetry?.(err, attempt, maxRetries, waitMs);
  };

  const useTools = modeUsesTools(mode);

  // 取消信号：由三种情况触发
  //   1. 用户点「停止」          → abortedByUserFlag = true
  //   2. 空闲超时（模型没输出了）  → abortReason = 'idle'
  //   3. 工具执行超时            → abortReason = 'tool-timeout'
  //
  // **没有整轮总时长上限**：用户给的任务越详细、跑得越久都正常，
  // 只要还在持续出 token 就一直等。防跑飞靠 AGENT_MAX_STEPS。
  const controller = new AbortController();
  let abortReason = '';

  // 空闲看门狗：每收到一个 chunk 就续一次命，超过 AGENT_IDLE_TIMEOUT_MS 没动静才断。
  // 这个计时器跨「模型请求」和「工具执行」两类活动共用一个时间戳，
  // 因为两者都算「这一轮还活着」。
  let lastActivity = Date.now();
  const bump = () => { lastActivity = Date.now(); };
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > AGENT_IDLE_TIMEOUT_MS) {
      abortReason = 'idle';
      controller.abort();
    }
  }, 2_000);

  let abortedByUserFlag = false;
  if (signal) {
    if (signal.aborted) { abortedByUserFlag = true; controller.abort(); }
    else {
      signal.addEventListener('abort', () => {
        abortedByUserFlag = true;
        controller.abort();
      }, { once: true });
    }
  }

  const model = makeModel(cfg, useTools);

  // LangGraph 的 thread_id：用站点 + 会话拼，保证一个会话一条检查点链
  const graphThread = threadId
    ? `site-${site.id}-thread-${threadId}`
    : `site-${site.id}-adhoc-${Date.now()}`;

  const config = { configurable: { thread_id: graphThread } };

  // **本轮只传新增的用户消息**，历史由 checkpoint 自动追加。
  // 以前这里传的是 [system + 全部历史 + user]，和检查点里的历史叠加，
  // 导致每轮多一份 SystemMessage、旧 tool_calls 被带进新请求而 400。
  const turnMessages = await buildTurnMessages({ userText, attachments, cfg });

  // 是不是全新会话：检查点里还没有任何消息 → 需要注入 system prompt
  let needsSystemPrompt = true;
  try {
    const prev = await saver().getTuple(config);
    const prevCount = prev?.checkpoint?.channel_values?.messages?.length ?? 0;
    needsSystemPrompt = prevCount === 0;
  } catch {
    // 读不到就当作全新会话（安全兜底）
    needsSystemPrompt = true;
  }

  const agentNode = makeAgentNode({
    model, cfg, site, mode, summary,
    signal: controller.signal,
    emit,
    onDelta,
    // 注意：这里传的是 onRetryEvent，不是外部的 onRetry。
    // 它内部会「先发事件、再调外部回调」，保证重试一定能进事件流。
    onRetry: onRetryEvent,
    // 每收到一个 token 就续命，让空闲看门狗知道模型还活着
    bump,
    // 只在首轮注入 system prompt
    needsSystemPrompt,
  });

  const toolsNode = makeToolsNode({
    siteId: site.id,
    userId,
    signal: controller.signal,
    emit,
    onStep,
    // 工具开始和结束都要续命：执行中的工具也算「这一轮还活着」
    bump,
  });

  const app = buildAgentGraph({
    agentNode,
    toolsNode,
    maxSteps: AGENT_MAX_STEPS,
    checkpointer: saver(),
  });

  try {
    // 一轮的开始。前端靠它把「第 N 轮」和「轮内的第 K 步」分开 ——
    // 以前只有 step，两个概念混在一起，工具行和思考内容常常配错轮。
    emit({ type: 'turn_start', turn: 1, at: Date.now() });

    // steps 不再重置为 0：跨轮累积会让「第二轮就撞步数上限」，
    // 这里每轮重新计数（一次用户请求 = 一轮 agent）。
    const final = await app.invoke({ messages: turnMessages, steps: 0 }, config);

    const stepsDone = final.steps ?? 0;
    const changed = (final.toolCalls ?? []).filter((t) => t.ok).length;

    // 从最终状态里取回复正文：最后一条 assistant 消息的文本
    const msgs = final.messages ?? [];
    let lastAi = null;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?._getType?.() === 'ai') { lastAi = msgs[i]; break; }
    }
    const rawText = String(lastAi?.content ?? '').trim();
    const finishReason = lastAi?.response_metadata?.finish_reason;

    const aborted = final.finish === 'max-steps' || final.finish === 'aborted';
    const byUser = final.finish === 'aborted' && abortedByUserFlag;

    let replyText = rawText || emptyReplyMessage(finishReason, cfg);

    if (final.finish === 'aborted') {
      // 按真实原因给不同文案，别让用户以为是「模型罢工」
      if (byUser) {
        replyText = `好的，停在这儿了（已完成 ${stepsDone} 步${changed ? `，改了 ${changed} 处` : ''}）。`
          + '已经改的地方都保留着，想接着改就再说一句。';
      } else if (abortReason === 'idle') {
        replyText = `模型已经连续 ${Math.round(AGENT_IDLE_TIMEOUT_MS / 1000)} 秒没有输出任何内容，`
          + `判定连接已断开（已完成 ${stepsDone} 步${changed ? `，改了 ${changed} 处` : ''}）。`
          + '改动都保留着，可以再发一条接着说。';
      } else {
        replyText = `这一轮被中断了（已完成 ${stepsDone} 步）。原因未知，可以再试一次。`;
      }
    } else if (final.finish === 'max-steps') {
      replyText = `改了 ${AGENT_MAX_STEPS} 步还没收尾，先停下（这一轮改了 ${changed} 处）。`
        + '你可以看看预览，告诉我接下来怎么改。';
    }

    // 一轮的正常收尾。kind 让前端区分「说完了」和「撞步数上限」。
    emit({
      type: 'turn_end',
      turn: 1,
      reason: {
        kind: byUser ? 'aborted' : final.finish === 'max-steps' ? 'max-steps' : 'done',
        steps: stepsDone,
      },
      at: Date.now(),
    });

    return {
      text: replyText,
      reasoning: final.reasoning ?? '',
      steps: stepsDone,
      toolCalls: final.toolCalls ?? [],
      usage: final.usage ?? { inputTokens: 0, outputTokens: 0 },
      aborted,
      abortedByUser: byUser,
      checkpointThread: graphThread,
    };
  } catch (err) {
    // 取消导致的异常：给出符合直觉的收尾，不当成失败。
    //
    // 三个判断条件缺一不可（都踩过坑）：
    //   controller.signal.aborted —— 我们自己 abort 过的
    //   abortReason                —— 看门狗标记的原因（idle / tool-timeout）
    //   isAbortError(err)          —— undici 抛 terminated 时 signal 可能还没翻成 true
    if (controller.signal.aborted || abortReason || isAbortError(err)) {
      // 留一条日志：中断原因对排查很关键（用户报「原因未知」时能看到真相）
      console.warn(
        `[agent] 本轮中断: aborted=${controller.signal.aborted} `
        + `reason=${abortReason || '(空)'} byUser=${abortedByUserFlag} `
        + `err=${err?.name ?? '-'}:${String(err?.message ?? '').slice(0, 80)}`,
      );
      let text;
      if (abortedByUserFlag) {
        text = '好的，停在这儿了。已经改的地方都保留着，想接着改就再说一句。';
      } else if (abortReason === 'idle') {
        text = `模型连续 ${Math.round(AGENT_IDLE_TIMEOUT_MS / 1000)} 秒没有输出任何内容，`
          + '判断是连接断了（不是任务太大跑不完，正常出字的话会一直等下去）。\n\n'
          + '改动都保留着，可以再发一条接着说。';
      } else if (abortReason === 'tool-timeout') {
        text = `某个工具执行超过 ${Math.round(AGENT_TOOL_TIMEOUT_MS / 1000)} 秒，已中止这一轮。`
          + '改动都保留着，可以再发一条接着做。';
      } else {
        text = '这一轮被中断了，可以再试一次。';
      }
      // 中断也要收尾：否则前端永远停在「正在思考…」，刷新后看不出这轮是停的。
      emit({
        type: 'turn_end',
        turn: 1,
        reason: {
          kind: abortedByUserFlag ? 'aborted' : 'error',
          abortReason: abortReason || 'unknown',
        },
        at: Date.now(),
      });
      return {
        text,
        reasoning: '',
        steps: 0,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        aborted: true,
        abortedByUser: abortedByUserFlag,
        checkpointThread: graphThread,
      };
    }
    // 真失败：也留一条 turn_end，前端才能显示「卡在哪一步」。
    emit({
      type: 'turn_end',
      turn: 1,
      reason: {
        kind: 'error',
        error: {
          code: err?.code ?? 'UNKNOWN',
          message: String(err?.message ?? '').slice(0, 200),
        },
      },
      at: Date.now(),
    });
    if (err instanceof LlmError) throw err;
    throw new LlmError(
      err?.message ?? '模型调用失败',
      err?.code ?? 'UNKNOWN',
      String(err?.stack ?? '').slice(0, 300),
    );
  } finally {
    clearInterval(idleTimer);
  }
}

export { AGENT_MAX_STEPS };
