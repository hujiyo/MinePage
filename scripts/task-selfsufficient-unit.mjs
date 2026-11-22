// A 方案的回归测试：任务行必须能独立画出「用户气泡 + 过程面板 + 回复气泡」。
//
// 这一套取代了原来的 trace-match-unit（按回复正文内容配对）。配对这个概念
// 已经不存在了 —— 现在的契约是：**一个任务 = 一整组 UI**。
//
// 重点覆盖那个真实 bug：agent 思考中被停止 → 刷新后面板消失。
// 根因是 result 是「好的，停在这儿了…」这类补出来的文案，和检查点里
// 模型真说过的话对不上，内容匹配必然失败。
import { readFileSync } from 'node:fs';
import { publicTask } from '../lib/agent/task.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass += 1; console.log(`  OK   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${d}`); }
};

/* ================================================================
   1. publicTask：任务行必须自带画 UI 所需的全部字段
   ================================================================ */
console.log('\n[1] publicTask 输出自足字段');

const ROW = {
  id: 'task-abc',
  site_id: 1,
  thread_id: 2,
  user_id: 3,
  model: 'deepseek',
  user_text: '做一个游戏网页',
  attach_ids: '11,12',
  status: 'cancelled',
  step: 1,
  steps: '[]',
  events: '[]',
  result: '好的，停在这儿了（已完成 1 步，改了 1 处）。已经改的地方都保留着，想接着改就再说一句。',
  error: null,
  token_usage: '',
  created_at: '2026-11-21T16:04:48.505Z',
  updated_at: '2026-11-21T16:05:14.000Z',
};

const t = publicTask(ROW, []);
ok('userText 有值', t.userText === '做一个游戏网页', String(t.userText));
ok('attachIds 解析成数组', Array.isArray(t.attachIds) && t.attachIds.length === 2, JSON.stringify(t.attachIds));
ok('attachIds 是数字', t.attachIds[0] === 11 && t.attachIds[1] === 12);
ok('text 是收尾文案', String(t.text).startsWith('好的，停在这儿了'));
ok('createdAt 有值', Boolean(t.createdAt));

// 老任务：user_text 是 NULL，attach_ids 是 ''（合法状态，不需要迁移）
const LEGACY = { ...ROW, user_text: null, attach_ids: '' };
const lt = publicTask(LEGACY, []);
ok('老任务 userText 为 null（前端据此跳过用户气泡）', lt.userText === null);
ok('老任务 attachIds 为空数组', Array.isArray(lt.attachIds) && lt.attachIds.length === 0);

// 只发图不打字：user_text 是空串，但 attach_ids 有值
const IMGONLY = { ...ROW, user_text: '', attach_ids: '7' };
const it = publicTask(IMGONLY, []);
ok('只发图时 userText 是空串（不是 null）', it.userText === '');
ok('只发图时 attachIds 仍有值', it.attachIds[0] === 7);

/* ================================================================
   2. 前端渲染契约：不再做内容配对
   ================================================================ */
console.log('\n[2] 前端渲染契约（studio.js）');

const STUDIO = readFileSync(new URL('../public/studio.js', import.meta.url), 'utf8');

// 这一条是本次改造的核心：配对机制必须彻底消失
ok('studio.js 里没有 matchTasksToMessages', !/matchTasksToMessages/.test(STUDIO));
ok('studio.js 里没有 fingerprint 配对', !/function fingerprint\(/.test(STUDIO));
ok('后端 match.js 已删除', !(() => {
  try {
    readFileSync(new URL('../lib/agent/match.js', import.meta.url));
    return true;
  } catch { return false; }
})());

// 渲染必须按任务走，且三件套齐全
ok('renderMessages 从 tasks 取数据', /const taskList = Array\.isArray\(tasks\)/.test(STUDIO));
ok('会画用户气泡', /task\.userText != null/.test(STUDIO));
ok('会画过程面板', /buildTraceFromTask\(task\)/.test(STUDIO));
ok('会画回复气泡', /const text = String\(task\.text/.test(STUDIO));
ok('老任务跳过用户气泡（不画空的）', /userText != null/.test(STUDIO));
ok('被停止的回复有标记', /status === 'cancelled'[\s\S]{0,120}stopped/.test(STUDIO));

/* ================================================================
   3. 关键回归：中断轮也必须能画出面板
   ================================================================ */
console.log('\n[3] 回归：中断轮（result 是补出来的收尾文案）');

const CANCELLED = publicTask({
  ...ROW,
  events: '[]',
  result: '好的，停在这儿了（已完成 1 步，改了 1 处）。',
}, [
  { type: 'turn_start', turn: 1, at: 1000 },
  { type: 'llm_start', step: 1, at: 1010 },
  { type: 'reasoning_delta', text: '我正在思考怎么做这个游戏……', at: 1020 },
  { type: 'tool_start', name: 'read_file', path: 'index.html', at: 1030 },
  { type: 'tool_end', name: 'read_file', path: 'index.html', ok: true, ms: 49, at: 1080 },
  { type: 'turn_end', turn: 1, reason: { kind: 'aborted' }, at: 1090 },
], null);

ok('中断任务 userText 保留', CANCELLED.userText === '做一个游戏网页');
ok('中断任务 view 仍有内容（面板能画出来）', (CANCELLED.view?.turns?.length ?? 0) > 0,
  JSON.stringify(CANCELLED.view?.turns?.length));
ok('中断任务有工具记录', (CANCELLED.view?.families?.tool?.length ?? 0) === 1);
ok('中断任务 status=cancelled', CANCELLED.status === 'cancelled');

// 对照：旧机制下这条任务会因「收尾文案 vs 模型原话」对不上而不显示面板。
// 现在不需要任何字符串比较就能定位它 —— 它就是 tasks 数组里的那一行。
const MESSAGES = [
  { role: 'user', content: '做一个游戏网页' },
  { role: 'agent', content: '我先看看现在的 index.html 是什么。' },   // 检查点里的原话
];
const oldWouldMatch = MESSAGES.some((m) => m.role === 'agent'
  && String(CANCELLED.text).includes(m.content));
ok('旧内容匹配机制确实会失败（证明这次改造的必要性）', oldWouldMatch === false);

/* ================================================================
   4. 多轮：任务顺序即 UI 顺序
   ================================================================ */
console.log('\n[4] 多轮顺序');

const rows = [
  { ...ROW, id: 't1', user_text: '做个视频站', result: '好了，视频站做好了', created_at: '2026-11-21T10:00:00.000Z' },
  { ...ROW, id: 't2', user_text: '背景改亮', result: '好的，停在这儿了', created_at: '2026-11-21T10:05:00.000Z', status: 'cancelled' },
  { ...ROW, id: 't3', user_text: '加个搜索框', result: '搜索框加好了', created_at: '2026-11-21T10:10:00.000Z' },
];
const tasks = rows.map((r) => publicTask(r, []));
ok('3 条任务各自的 userText 互不串位',
  tasks[0].userText === '做个视频站' && tasks[1].userText === '背景改亮' && tasks[2].userText === '加个搜索框');
ok('任务按 created_at 天然有序',
  tasks[0].createdAt < tasks[1].createdAt && tasks[1].createdAt < tasks[2].createdAt);
ok('每条任务都有自己的回复',
  tasks.every((x) => String(x.text ?? '').length > 0));

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
