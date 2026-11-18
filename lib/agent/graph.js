// 把 StateGraph 拼起来：agent 节点 + tools 节点 + 条件边。
//
// 这个文件只负责「图的形状」，具体怎么调模型、怎么执行工具、怎么发事件，
// 都通过参数注入 —— graph.js 本身不依赖 prompt.js / tools.js / 模型层，
// 测试时可以塞假实现。

import { StateGraph, START, END } from '@langchain/langgraph';
import { AgentState, NODE } from './graph-state.js';

/**
 * 构建并编译 agent 图。
 *
 * @param {object} opt
 *   agentNode    async (state, config) => 状态增量
 *                调模型，返回 { messages, steps, usage, reasoning, finish }
 *   toolsNode    async (state, config) => 状态增量
 *                执行 tool_calls，返回 { messages, toolCalls, toolChars }
 *   maxSteps     最大步数。到顶后条件边直接结束，不再执行工具。
 *   checkpointer LangGraph 的 saver（MySqlSaver 或 MemorySaver）
 * @returns {CompiledGraph}
 */
export function buildAgentGraph({ agentNode, toolsNode, maxSteps, checkpointer }) {
  const graph = new StateGraph(AgentState)
    .addNode(NODE.agent, agentNode)
    .addNode(NODE.tools, toolsNode)
    .addEdge(START, NODE.agent)
    .addConditionalEdges(NODE.agent, (state) => {
      // 已经收尾了（模型说完了 / 步数用尽 / 被取消）
      if (state.finish) return END;

      const last = state.messages[state.messages.length - 1];
      const calls = last?.tool_calls;
      if (!Array.isArray(calls) || calls.length === 0) return END;

      // 步数用尽：不再执行工具，直接结束（否则会白跑一轮工具）
      if ((state.steps ?? 0) >= maxSteps) return END;
      return NODE.tools;
    })
    // 工具执行完回到 agent，形成循环
    .addEdge(NODE.tools, NODE.agent);

  return graph.compile({ checkpointer });
}

export { AgentState, NODE };
