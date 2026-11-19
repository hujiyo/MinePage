// agent 的 LangGraph 图：状态定义 + 节点 + 边。
//
// 为什么用 StateGraph 而不是自己写 for 循环：
//   - 每走完一个 superstep，checkpointer 会自动存一份完整状态
//   - 崩溃后能从最后一个检查点接着跑，不用整轮重来
//   - 这是 LangGraph 的核心价值，也是这次重构的理由
//
// 图的结构（三节点 + 一条条件边）：
//
//   START ──→ agent ──┬─(有 tool_calls)─→ tools ──┐
//                     │                          │
//                     └─(没有)───────→ END        │
//                          ↑                     │
//                          └─────────────────────┘
//
// agent 节点：调模型，产出 assistant 消息（可能带 tool_calls）
// tools 节点：把 assistant 消息里的 tool_calls 逐个执行，产出 tool 消息
//
// 状态字段说明（Annotation.Root 里每一项都是一个 channel）：
//   messages    对话数组。用 messagesStateReducer 增量合并，这是 LangGraph
//               的标准做法：节点只返回新增的消息，reducer 负责拼接。
//   steps       已走步数。普通 reducer（后值覆盖前值）。
//   toolCalls   本轮所有工具调用的摘要，给前端显示「做了什么」。
//   usage       累计 token 用量。
//   reasoning   累计思考内容。
//   finish      收尾原因（done / max-steps / aborted），给调用方判断。

import { Annotation, messagesStateReducer } from '@langchain/langgraph';

/** 工具调用摘要的一条。 */
const toolCallSummary = (prev, next) => [...(prev ?? []), ...(next ?? [])];

/** token 用量累加。 */
const usageReducer = (prev, next) => ({
  inputTokens: (prev?.inputTokens ?? 0) + (next?.inputTokens ?? 0),
  outputTokens: (prev?.outputTokens ?? 0) + (next?.outputTokens ?? 0),
});

/** 追加字符串（思考内容会分很多段流回来）。 */
const appendText = (prev, next) => (prev ?? '') + (next ?? '');

export const AgentState = Annotation.Root({
  // 对话消息：LangChain 的 BaseMessage[]，用标准 reducer 增量合并
  messages: Annotation({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // 步数：每进一次 agent 节点 +1
  steps: Annotation({
    reducer: (prev, next) => next ?? prev ?? 0,
    default: () => 0,
  }),

  // 工具调用摘要（累加）
  toolCalls: Annotation({
    reducer: toolCallSummary,
    default: () => [],
  }),

  // token 用量（累加）
  usage: Annotation({
    reducer: usageReducer,
    default: () => ({ inputTokens: 0, outputTokens: 0 }),
  }),

  // 思考内容（累加）
  reasoning: Annotation({
    reducer: appendText,
    default: () => '',
  }),

  // 收尾原因。空字符串表示还没结束。
  //
  // **必须用「后值覆盖前值」而不是 `next || prev`**：
  // 图在多次 invoke 之间共享同一个检查点，用 `next || prev` 会让上一轮的
  // 'aborted' 粘住 —— 新一轮明明成功返回了，finish 还是 'aborted'，
  // 表现为「继续之后仍然显示被中断，原因未知」（实测踩过这个坑）。
  // 所以这里 always 取 next，由节点显式传 '' 来清空。
  finish: Annotation({
    reducer: (prev, next) => (next === undefined ? (prev ?? '') : next),
    default: () => '',
  }),

  // 工具结果的总字符数（用于折叠判断，每步重算，不是累加）
  toolChars: Annotation({
    reducer: (prev, next) => next ?? prev ?? 0,
    default: () => 0,
  }),
});

/** 图的节点名，避免各处硬编码字符串。 */
export const NODE = {
  agent: 'agent',
  tools: 'tools',
};
