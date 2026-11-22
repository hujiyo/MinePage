// segments（思考 / 说话 / 工具 的发生顺序）的行为测试。
//
// 背景：模型一步里的输出是「先想 → 说一句过渡话 → 再动手」。
// 以前只存 reasoning + tools 两个数组，前端只能「先画思考再画工具」，
// 中间那句过渡话没地方放，时间线是断的。
// 现在 deriveTrace 产出一个有序的 segments，按事件到达顺序追加。
import { deriveTrace } from '../lib/agent/trace.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass += 1; console.log(`  OK   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${d}`); }
};

const at = (ms) => 1_700_000_000_000 + ms;

/* ================================================================
   1. 完整一步：思考 → 说话 → 工具 → step_end
   ================================================================ */
console.log('\n[1] 一步内的发生顺序');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(10) },
    { type: 'reasoning_delta', text: '用户要改配色，先读文件。', at: at(20) },
    { type: 'text', text: '我先看一下 index.html。', at: at(30) },
    { type: 'tool_start', name: 'read_file', path: 'index.html', at: at(40) },
    { type: 'tool_end', name: 'read_file', path: 'index.html', ok: true, ms: 20, at: at(60) },
    { type: 'step_end', step: 1, ms: 50, at: at(60) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(60) },
  ], { status: 'done' });

  const step = view.turns[0].steps[0];
  const kinds = step.segments.map((s) => s.kind);
  ok('segments 顺序为 reasoning → text → tool', JSON.stringify(kinds) === JSON.stringify(['reasoning', 'text', 'tool']), JSON.stringify(kinds));
  ok('思考内容正确', step.segments[0].text === '用户要改配色，先读文件。');
  ok('说话内容正确', step.segments[1].text === '我先看一下 index.html。');
  ok('工具对象挂在 segment 上', step.segments[2].tool?.name === 'read_file');
  ok('step.text 汇总了过渡话', step.text === '我先看一下 index.html。', step.text);
  ok('step.reasoning 仍然保留', step.reasoning === '用户要改配色，先读文件。');
}

/* ================================================================
   2. 多次说话：中间穿插工具，全部按顺序
   ================================================================ */
console.log('\n[2] 一步内多次说话 + 多个工具');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '想1', at: at(2) },
    { type: 'text', text: '说1', at: at(3) },
    { type: 'tool_start', name: 'read_file', path: 'a.html', at: at(4) },
    { type: 'tool_end', name: 'read_file', path: 'a.html', ok: true, ms: 5, at: at(5) },
    { type: 'text', text: '说2', at: at(6) },
    { type: 'tool_start', name: 'write_file', path: 'a.html', at: at(7) },
    { type: 'tool_end', name: 'write_file', path: 'a.html', ok: true, ms: 9, at: at(8) },
    { type: 'reasoning_delta', text: '想2', at: at(9) },
    { type: 'step_end', step: 1, ms: 20, at: at(10) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(10) },
  ], { status: 'done' });

  const kinds = view.turns[0].steps[0].segments.map((s) => s.kind);
  ok('顺序完整保持', JSON.stringify(kinds) === JSON.stringify(
    ['reasoning', 'text', 'tool', 'text', 'tool', 'reasoning'],
  ), JSON.stringify(kinds));
}

/* ================================================================
   3. 连续增量合并成一个 segment（不该每个 8KB 切片单独成行）
   ================================================================ */
console.log('\n[3] 连续同类增量合并');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '第一段', at: at(2) },
    { type: 'reasoning_delta', text: '第二段', at: at(3) },
    { type: 'text', text: '你好', at: at(4) },
    { type: 'text', text: '世界', at: at(5) },
    { type: 'step_end', step: 1, ms: 10, at: at(6) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(6) },
  ], { status: 'done' });

  const segs = view.turns[0].steps[0].segments;
  ok('只有 2 个 segment（思考一块 + 说话一块）', segs.length === 2, JSON.stringify(segs.map((s) => s.kind)));
  ok('思考合并', segs[0].text === '第一段第二段', segs[0].text);
  ok('说话合并', segs[1].text === '你好世界', segs[1].text);
}

/* ================================================================
   4. 跨步：第 2 步的思考和说话不串到第 1 步
   ================================================================ */
console.log('\n[4] 多步隔离');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '步1想', at: at(2) },
    { type: 'text', text: '步1说', at: at(3) },
    { type: 'tool_start', name: 'read_file', path: 'x', at: at(4) },
    { type: 'tool_end', name: 'read_file', path: 'x', ok: true, ms: 1, at: at(5) },
    { type: 'step_end', step: 1, ms: 5, at: at(5) },
    { type: 'llm_start', step: 2, at: at(10) },
    { type: 'reasoning_delta', text: '步2想', at: at(11) },
    { type: 'text', text: '步2说', at: at(12) },
    { type: 'step_end', step: 2, ms: 5, at: at(13) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(13) },
  ], { status: 'done' });

  const [s1, s2] = view.turns[0].steps;
  ok('步1 只含自己的内容', s1.text === '步1说' && s1.reasoning === '步1想');
  ok('步2 只含自己的内容', s2.text === '步2说' && s2.reasoning === '步2想');
  ok('步1 的 segments 是 reasoning,text,tool', s1.segments.map((s) => s.kind).join(',') === 'reasoning,text,tool');
  ok('步2 的 segments 是 reasoning,text', s2.segments.map((s) => s.kind).join(',') === 'reasoning,text');
}

/* ================================================================
   5. 老数据兼容：只有 reasoning 快照（v1），没有 delta / segments
   ================================================================ */
console.log('\n[5] 老数据（v1 reasoning 快照）');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'reasoning', text: '老式累积快照', at: at(1) },
    { type: 'tool_end', name: 'write_file', path: 'old.html', ok: true, ms: 3, at: at(2) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(3) },
  ], { status: 'done' });

  const step = view.turns[0].steps[0];
  ok('老数据也能出 segments', Array.isArray(step.segments) && step.segments.length > 0);
  ok('v1 思考被补成 reasoning segment',
    step.segments[0]?.kind === 'reasoning' && step.segments[0]?.text === '老式累积快照',
    JSON.stringify(step.segments[0]));
  ok('工具仍然按结束事件补出来', step.tools.length === 1 && step.tools[0].name === 'write_file');
}

/* ================================================================
   6. 没有 text 事件时（本次改造前的历史任务）行为不变
   ================================================================ */
console.log('\n[6] 无 text 事件（历史任务）');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '只有思考', at: at(2) },
    { type: 'tool_start', name: 'read_file', path: 'p', at: at(3) },
    { type: 'tool_end', name: 'read_file', path: 'p', ok: true, ms: 1, at: at(4) },
    { type: 'step_end', step: 1, ms: 5, at: at(4) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(5) },
  ], { status: 'done' });

  const step = view.turns[0].steps[0];
  ok('没有 text 段', step.text === '', JSON.stringify(step.text));
  ok('segments 仍只有 reasoning + tool',
    step.segments.map((s) => s.kind).join(',') === 'reasoning,tool');
  ok('families.message 没被污染', (view.families.message ?? []).length === 0);
}

/* ================================================================
   7. families.message 收录过渡话
   ================================================================ */
console.log('\n[7] families.message');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'text', text: '这是过渡话', at: at(2) },
    { type: 'step_end', step: 1, ms: 5, at: at(3) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(3) },
  ], { status: 'done', text: '最终回复' });

  const msgs = view.families.message;
  ok('过渡话进 message 分类', msgs.some((m) => m.interim === true), JSON.stringify(msgs));
  ok('最终回复也在', msgs.some((m) => !m.interim));
}

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
