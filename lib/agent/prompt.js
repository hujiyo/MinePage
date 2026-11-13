// System prompt 构建 + 历史裁剪。
//
// 提示词分三层，缺一不可：
//   1. 身份与约束（你是谁、能干什么、不能干什么）
//   2. 当前上下文（哪个草稿、有哪些文件）—— 让模型不用先探一遍路
//   3. 工作方式（先读后写、一次做一件、别乱猜）
//
// 工具描述本身也是提示词的一部分，已经写在 tools.js 里，这里不重复。

import {
  CONTEXT_TOOL_RESERVE_CHARS,
  CONTEXT_USABLE_RATIO,
} from '../config.js';
import { estimateRowTokens } from './tokens.js';

const TAG_HINTS = {
  resume: '求职简历',
  portfolio: '作品集',
  social: '社交聚合页',
  blog: '技术博客',
  event: '活动落地页',
  opensource: '开源项目',
  docs: '学习笔记',
  other: '其他',
};

/** 文件清单太长会把 prompt 撑爆，只列前 N 个，剩下的说清楚还有多少。 */
const MAX_FILES_IN_PROMPT = 40;

function fileList(files) {
  if (!files.length) return '（这个草稿还没有文件）';

  const shown = files.slice(0, MAX_FILES_IN_PROMPT);
  const lines = shown.map((f) => {
    const kb = f.size >= 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`;
    return `  - ${f.path}（${kb}）`;
  });

  if (files.length > shown.length) {
    lines.push(`  …还有 ${files.length - shown.length} 个文件（用 list_files 看全部）`);
  }
  return lines.join('\n');
}

/**
 * 构建 system prompt。
 *
 * @param {object} site 站点行（至少要 name / title / status）
 * @param {Array}  files listSiteFiles 的结果（对话模式传空数组）
 * @param {{mode?: 'chat'|'code', maxSteps?: number, summary?: string}} [opt]
 *   summary 是压缩摘要；有就作为「背景」插在 prompt 里
 * @returns {string}
 */
export function systemPrompt(site, files, opt = {}) {
  const mode = opt.mode === 'chat' ? 'chat' : 'code';
  const title = site.title ? `「${site.title}」` : '（还没起标题）';
  const tag = site.tag ? `，分类是「${TAG_HINTS[site.tag] ?? site.tag}」` : '';
  const totalFiles = files.length;

  const context = `## 当前草稿
名字：${site.name}
标题：${title}${tag}
状态：${site.status === 'draft' ? '草稿（还没发布）' : '已发布'}`;

  // 压缩摘要作为「之前的进展」注入，让模型知道自己不是从零开始
  const summary = String(opt.summary ?? '').trim();
  const background = summary
    ? `\n\n## 之前的进展（这段对话已经聊过很久，下面是早期内容的摘要）\n${summary}`
    : '';

  // 对话模式：不给工具，提示词也不能提「读写文件」，
  // 否则模型会一直说「我来帮你改」然后什么也做不了。
  if (mode === 'chat') {
    return `你是 MinePage 的建站顾问，回答用户关于他的草稿网页的问题。

${context}${background}

## 你的角色
**你只能对话，不能改文件。** 你手里没有任何读写文件的工具，这是刻意的设计。
- 用户想让你动手改，就告诉他切到「编码」模式；
- 你可以帮他看需求、讲思路、解释原理、给代码片段；
- 可以给具体建议（「把这个 div 的 display 换成 flex」），但别假装已经改好了。

## 给代码片段时
- **控制在 20 行以内**，只留要改的那一段，不要贴整页
- 说清楚放在哪个文件、哪一行附近
- 超过 20 行的改动，建议他切到「编码」模式让你直接改

## 约束
- 不要编造文件内容 —— 你看不到文件，只能依据用户告诉你的和对话历史。
- 不确定的地方就问，别猜。
- 不要提「我已经修改了」这类话，你做不到。

## 回复风格
中文，简洁，像同事之间说话。不要用「好的，我将为您…」这种客服腔。`;
  }

  const maxSteps = Number(opt.maxSteps ?? 12);

  return `你是 MinePage 的建站助手，帮用户把他/她的草稿网页改好。

${context}${background}

已有文件（共 ${totalFiles} 个）：
${fileList(files)}

## 工作方式
1. **先读后改**。动任何文件之前，先用 read_file 看它现在是什么样。
   不看就整体覆盖 = 把用户原来的内容全删了。
2. **一次做一件小事**。用户说「把标题改大」，就只改标题相关的样式，别顺手重写整个页面。
3. **改完说清楚**。告诉用户改了哪个文件、改了什么效果，不要复述你的内部步骤。
4. 需要新建文件时直接用 write_file，路径自己定（如 about.html、assets/app.css）。

## 你可以放心改
你的每一次改动都会自动存成一个带编号的版本，用户随时能回滚到任意一版。
所以不用因为「怕改坏」而反复确认——该动手就动手，改完说清楚就行。

## 预算意识
- 这一轮最多 ${maxSteps} 步（一次工具调用算一步）。到顶会被强制中断，
  所以**先做最重要的那件事**，剩下的留到下一轮。
- 读大文件会吃掉大量上下文。文件很多时，优先读和这次改动相关的；
  已经读过、内容没变过的文件不用再读一遍。

## 约束
- 只能操作这个草稿，不要提别的站点，也不要尝试访问网络或执行命令。
- 图片、字体等二进制文件不要用 write_file 写（它只处理文本）。
- 不要编造文件内容。读不到就说读不到，不要猜。
- 不确定用户想要什么的时候，先用一句话问清楚，别自己发挥。

## 回复风格
中文，简洁，像同事之间说话。不要用「好的，我将为您…」这种客服腔。`;
}

/**
 * 把历史消息裁到模型窗口能装下的量。
 *
 * ============ 2026-11 重做 ============
 *
 * 旧版有三个问题：
 *   1. 固定按「3 字符/token」算 —— 实测代码 1.86、中文 2.37、英文 5.21，
 *      按 3 算对代码会话会**高估**容量，直接超窗报 400
 *   2. 窗口利用率只取 45%，而实测模型能吃 480k，一半窗口白白浪费
 *   3. 空内容的消息（只发了图没打字）会原样塞进去，
 *      网关直接 400 `empty_message_content` —— 那个会话之后每条都失败
 *
 * 现在：
 *   - 用 tokens.js 自适应估 token
 *   - 利用率提到 70%（剩下 30% 给回复和工具结果）
 *   - 空内容消息一律跳过
 *
 * @param {Array} rows  数据库消息行（role/content/attach_ids，正序）
 * @param {object} cfg  模型配置（用 contextWindow 算预算）
 * @param {number} [reserveChars] 给 system prompt + 工具结果预留的字符数（保留参数兼容）
 * @param {string} [summaryOverride] 不走 DB 的摘要（内部调用时用）
 * @returns {Array<{role:string, content:string}>}
 */
export function buildHistory(rows, cfg, reserveChars = CONTEXT_TOOL_RESERVE_CHARS, summaryOverride) {
  const window = Number(cfg?.contextWindow) || 128_000;
  const budgetTokens = Math.max(8_000, Math.floor(window * CONTEXT_USABLE_RATIO));

  // 工具结果会占掉一部分预算，按字符预估后折算（保守按 2 字符/token）
  const reserveTokens = Math.ceil(reserveChars / 2);
  const available = Math.max(4_000, budgetTokens - reserveTokens);

  const kept = [];
  let used = 0;

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const role = row.role === 'agent' ? 'assistant' : 'user';
    const content = String(row.content ?? '').trim();

    // 空消息一律跳过。
    // 这是导致「会话永久 400」的元凶：只发图不打字时 content 是空串，
    // 拼进 history 后网关报 empty_message_content。（图只在本轮发，不进历史）
    if (!content) continue;

    const cost = estimateRowTokens(row) - (String(row.attach_ids ?? '').trim() ? 2000 : 0);
    // 单条就超预算的直接跳过（通常是早期贴了一大段代码）
    if (cost > available) continue;
    if (used + cost > available) break;

    kept.unshift({ role, content });
    used += cost;
  }

  // 历史必须以 user 开头：有的模型不接受 assistant 打头
  while (kept.length && kept[0].role !== 'user') kept.shift();

  // 摘要放在最前面（作为一条 assistant 消息，语义是「之前聊过这些」）。
  // 不用 system 是因为 system 已经被 prompt 占满，而且摘要更适合当「历史」。
  const summary = String(summaryOverride ?? '').trim();
  if (summary) {
    kept.unshift({ role: 'user', content: `【这段对话早期内容的摘要】\n${summary}` });
    kept.unshift({ role: 'assistant', content: '收到，我记住了之前的进展。' });
  }

  return kept;
}

export { MAX_FILES_IN_PROMPT };
