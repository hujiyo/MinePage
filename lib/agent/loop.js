// Agent 循环 —— 这就是「agent」的全部秘密。
//
// 普通聊天 = 问一次、答一次。Agent 多了一个环：
//
//   用户消息
//      ↓
//   ┌─→ 调模型（带上工具清单）
//   │      ↓
//   │   有 tool_calls？
//   │   ├─ 没有 → 返回最终文本，结束
//   │   └─ 有  → 逐个执行工具
//   │             ↓
//   │           把结果 append 成 role='tool' 的消息
//   │             ↓
//   └─────────────┘（再转一圈）
//
// 五个必须处理的细节（每一个都是踩过的坑）：
//   1. assistant 消息（含 tool_calls）要原样塞回消息数组，否则模型会重复调同一个工具
//   2. 每条 tool 结果必须带 tool_call_id，否则 400
//   3. 工具参数 JSON 解析失败时**回灌错误**让模型自己改，别抛异常中断整轮
//   4. 硬上限：步数 + 整轮超时，防死循环
//   5. 工具结果累计体积要有预算，超了折叠旧结果，否则上下文爆
//
// 流式：模型「说话」的部分是流式的（onDelta 逐字回调），
// 工具执行部分天然是阻塞的。两者在同一轮里交替出现 —— 比如模型先说
// 「我看看现在的样式」，然后调 read_file，再流式说「找到了，我把字号调大」。

import { AGENT_MAX_STEPS, AGENT_TIMEOUT_MS, AGENT_TOOL_BUDGET_CHARS } from '../config.js';
import { listSiteFiles } from '../sites.js';
import { toImagePart } from './attachments.js';
import { chatStreamWithRetry, LlmError } from './llm.js';
import { modeUsesTools } from './models.js';
import { buildHistory, systemPrompt } from './prompt.js';
import { AgentToolError, runAgentTool, toolSchemas } from './tools.js';

/** 折叠后的工具结果占位。 */
const FOLDED = '{"note":"（这一步的结果已省略以节省上下文，需要的话请重新调用）"}';

/**
 * 跑一轮 agent。
 *
 * @param {object} opt
 *   cfg       模型配置（models.js 里的一条）
 *   site      站点行
 *   userId    当前用户 id（工具权限校验用）
 *   history   历史消息行（数据库里这个会话的）
 *   userText  这一轮用户说的话
 *   mode      'code' 给工具（能读写文件） / 'chat' 不给工具（只回答）
 *   attachments 这一轮的图片附件 [{ mime, bytes }]；有图时 user 消息走多模态格式
 *   summary   早期对话的压缩摘要（有就作为背景注入，让模型知道不是从零开始）
 *   onStep    每执行一个工具回调一次（前端用来显示进度）
 *   onRetry   重试回调
 *   onDelta   模型每吐一段文字回调一次（流式输出）
 *   signal    外部取消信号（用户点「停止」时由 server 触发）
 * @returns {Promise<{text:string, steps:number, toolCalls:Array, usage:object, aborted:boolean}>}
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
  onRetry,
  onDelta,
  signal,
}) {
  // 对话模式不给工具：模型物理上就没有 write_file 可调，
  // 不是靠提示词劝它「别改文件」—— 那样不可靠。
  const useTools = modeUsesTools(mode);
  const tools = useTools ? toolSchemas() : [];

  const files = useTools ? await listSiteFiles(site.id) : [];

  // 有图时 user 消息要换成多模态格式：content 数组里 text + 若干 image_url。
  // 没图仍用纯字符串 —— 老模型对数组格式不一定兼容，能简单就简单。
  const userContent = buildUserContent(userText, attachments, cfg);

  const messages = [
    {
      role: 'system',
      content: systemPrompt(site, files, { mode, summary, maxSteps: AGENT_MAX_STEPS }),
    },
    ...buildHistory(history, cfg, undefined, summary),
    { role: 'user', content: userContent },
  ];

  // 整轮超时：用 AbortController 而不是 AbortSignal.timeout，
  // 这样能区分「整轮超时」和「单次请求超时」。
  // 外部传进来的 signal（用户点停止）跟这个超时信号合并，任一触发都算取消。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  const names = { user: false };
  if (signal) {
    names.user = true;
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  /** 取消是用户点的还是超时自动断的 —— 两者的回复文案不一样 */
  const abortedByUser = () => names.user && Boolean(signal?.aborted);

  /** 本轮所有工具调用的摘要（给前端显示「做了什么」） */
  const executed = [];
  /** 工具结果在消息数组里的下标，用于折叠旧结果 */
  let toolMessageIndexes = [];
  const usageTotal = { inputTokens: 0, outputTokens: 0 };

  try {
    for (let step = 1; step <= AGENT_MAX_STEPS; step += 1) {
      let reply;
      try {
        reply = await chatStreamWithRetry({
          cfg,
          messages,
          tools,
          signal: controller.signal,
          onRetry,
          // 流式回调只往外转：具体怎么显示（打字机 / 追加到气泡）由前端决定
          onDelta,
        });
      } catch (err) {
        // 用户点了停止 / 整轮超时：返回已有信息，不当成「失败」——
        // 用户主动中断不是错误，得给一句符合直觉的话。
        if (controller.signal.aborted) {
          return {
            text: abortedByUser()
              ? '好的，停在这儿了。已经改的地方都保留着，想接着改就再说一句。'
              : '这一轮跑太久了，先停一下。要我接着弄吗？',
            steps: step - 1,
            toolCalls: executed,
            usage: usageTotal,
            aborted: true,
            abortedByUser: abortedByUser(),
          };
        }
        if (err instanceof LlmError) throw err;
        throw new LlmError(err?.message ?? '模型调用失败');
      }

      usageTotal.inputTokens += Number(reply.usage?.prompt_tokens ?? 0);
      usageTotal.outputTokens += Number(reply.usage?.completion_tokens ?? 0);

      // 关键 1：assistant 消息必须原样塞回去（含 tool_calls）
      messages.push(reply.raw);

      // 没有工具调用 = 模型认为说完了，收工
      if (reply.toolCalls.length === 0) {
        return {
          text: reply.content.trim() || '（模型这次没有输出内容）',
          steps: step,
          toolCalls: executed,
          usage: usageTotal,
          aborted: false,
        };
      }

      // 有工具调用：逐个执行
      for (const call of reply.toolCalls) {
        const name = call.function?.name ?? '';
        const callId = call.id ?? `call_${step}_${executed.length}`;
        let args = {};
        let parseError = null;

        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          // 关键 3：参数不是合法 JSON 时回灌错误，让模型自己修正。
          // 直接抛异常会把整轮对话打断，前面做的事全白费。
          parseError = '参数不是合法 JSON。请重新给出一个完整、闭合的 JSON 对象。';
        }

        if (parseError) {
          messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: parseError }) });
          toolMessageIndexes.push(messages.length - 1);
          executed.push({ name, ok: false, error: parseError });
          continue;
        }

        let payload;
        let ok = true;
        try {
          payload = await runAgentTool(name, args, { siteId: site.id, userId });
        } catch (err) {
          ok = false;
          // 业务错误（文件不存在、路径不合法）要原样告诉模型，它才知道怎么改
          payload = { error: err instanceof AgentToolError ? err.message : `工具执行失败：${err.message}` };
        }

        executed.push({
          name,
          ok,
          path: typeof args?.path === 'string' ? args.path : null,
          error: ok ? null : payload.error,
        });
        if (onStep) {
          try { onStep({ step, name, args, ok, error: ok ? null : payload.error }); } catch { /* 回调出错不影响主流程 */ }
        }

        // 关键 2：tool 结果必须带 tool_call_id
        messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(payload) });
        toolMessageIndexes.push(messages.length - 1);
      }

      // 关键 5：工具结果累计体积超预算，就折叠更早的结果（保留最近两步）
      foldOldToolResults(messages, toolMessageIndexes);
    }

    // 步数耗尽：不假装成功，如实告诉用户
    return {
      text: `改了 ${AGENT_MAX_STEPS} 步还没收尾，先停下。你可以看看预览，告诉我接下来怎么改。`,
      steps: AGENT_MAX_STEPS,
      toolCalls: executed,
      usage: usageTotal,
      aborted: true,
      abortedByUser: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把「文字 + 图片」拼成模型能吃的 user content。
 *
 * 三种情况：
 *   - 没有图 → 纯字符串（最简单，老模型也认）
 *   - 有图，但模型不支持看图 → **降级成纯文字**，并在文字里说明
 *     "（这条消息附了 N 张图，但当前模型看不了图片）"。
 *     不静默丢图，否则用户会以为模型看过却装没看见。
 *   - 有图且模型支持 → 多模态数组
 */
function buildUserContent(userText, attachments, cfg) {
  const imgs = Array.isArray(attachments) ? attachments.filter((a) => a && a.bytes?.length) : [];

  // 最后一道兜底：文字为空且没有图 → 网关会报 empty_message_content，
  // 直接给个占位，别让整轮请求白跑。
  let text = String(userText ?? '').trim();
  if (!text && !imgs.length) text = '（用户没有输入文字）';

  if (!imgs.length) return text;

  if (!cfg?.supportsVision) {
    return `${text}\n\n（这条消息附了 ${imgs.length} 张图片，但当前模型「${cfg?.label ?? ''}」看不了图片。换个能看图的模型再问一次吧。）`;
  }

  // 多模态：text 部分必须非空，否则网关也会 400
  const parts = [{ type: 'text', text: text || '看看这些图片' }];
  for (const a of imgs) parts.push(toImagePart(a.mime, a.bytes));
  return parts;
}

/**
 * 折叠旧工具结果，只保留最近两个。
 * 在消息数组上原地改，这样下一轮请求的体积就被压下来了。
 */
function foldOldToolResults(messages, indexes) {
  const toolMsgs = indexes.filter((i) => messages[i]?.role === 'tool');
  if (toolMsgs.length <= 2) return;

  let total = 0;
  for (const i of toolMsgs) total += String(messages[i].content ?? '').length;
  if (total <= AGENT_TOOL_BUDGET_CHARS) return;

  // 从旧到新折叠，直到回到预算内
  for (const i of toolMsgs.slice(0, -2)) {
    if (total <= AGENT_TOOL_BUDGET_CHARS) break;
    const old = String(messages[i].content ?? '');
    if (old === FOLDED) continue;
    total -= old.length - FOLDED.length;
    messages[i] = { ...messages[i], content: FOLDED };
  }
}

export { AGENT_MAX_STEPS, AGENT_TIMEOUT_MS, AGENT_TOOL_BUDGET_CHARS };
