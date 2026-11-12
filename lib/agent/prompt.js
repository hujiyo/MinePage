// System prompt 构建。
//
// 提示词分三层，缺一不可：
//   1. 身份与约束（你是谁、能干什么、不能干什么）
//   2. 当前上下文（哪个草稿、有哪些文件）—— 让模型不用先探一遍路
//   3. 工作方式（先读后写、一次做一件、别乱猜）
//
// 工具描述本身也是提示词的一部分，已经写在 tools.js 里，这里不重复。

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
 * @param {Array}  files listSiteFiles 的结果
 * @returns {string}
 */
export function systemPrompt(site, files) {
  const title = site.title ? `「${site.title}」` : '（还没起标题）';
  const tag = site.tag ? `，分类是「${TAG_HINTS[site.tag] ?? site.tag}」` : '';

  return `你是 MinePage 的建站助手，帮用户把他/她的草稿网页改好。

## 当前草稿
名字：${site.name}
标题：${title}${tag}
状态：${site.status === 'draft' ? '草稿（还没发布）' : '已发布'}

已有文件：
${fileList(files)}

## 工作方式
1. **先读后改**。动任何文件之前，先用 read_file 看它现在是什么样。
   不看就整体覆盖 = 把用户原来的内容全删了。
2. **一次做一件小事**。用户说「把标题改大」，就只改标题相关的样式，别顺手重写整个页面。
3. **改完说清楚**。告诉用户改了哪个文件、改了什么效果，不要复述你的内部步骤。
4. 需要新建文件时直接用 write_file，路径自己定（如 about.html、assets/app.css）。

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
 * 策略：从新到旧累加，超过预算就停，保留最近的部分。
 * 不在这里做「摘要压缩」——那需要再调一次模型，成本和延迟都不划算，
 * 而且真需要压缩时，说明该让用户开新会话了。
 *
 * @param {Array} rows  数据库里的消息行（role/content，正序）
 * @param {object} cfg  模型配置（用 contextWindow 算预算）
 * @param {number} reserveChars 给 system prompt + 本轮工具结果预留的字符数
 * @returns {Array<{role:string, content:string}>}
 */
export function buildHistory(rows, cfg, reserveChars = 20000) {
  // 粗略换算：1 token ≈ 2 个中文字符 / 4 个英文字符，取保守的 3
  const budgetTokens = Math.floor((cfg?.contextWindow ?? 64_000) * 0.45);
  const budgetChars = Math.max(4000, budgetTokens * 3 - reserveChars);

  const kept = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const role = row.role === 'agent' ? 'assistant' : 'user';
    const content = String(row.content ?? '');
    // 单条就超预算的直接跳过（通常是早期贴了一大段代码）
    if (content.length > budgetChars) continue;
    if (used + content.length > budgetChars) break;
    kept.unshift({ role, content });
    used += content.length;
  }

  // 历史必须以 user 开头：有的模型不接受 assistant 打头
  while (kept.length && kept[0].role !== 'user') kept.shift();

  return kept;
}

export { MAX_FILES_IN_PROMPT };
