// blocks 归并的行为测试：把被流式顺序切碎的正文接回去。
//
// 真实数据里的故障形态（task 013a5c1c56）：
//   step2 [T] "…轮子、曲柄、腿、翅膀、"
//   step2 [R] 92 字
//   step2 [T] "围巾都在动，背景有山和滚动的路面。"
// 一句话被同 step 内的思考劈成两半 → 用户看到「…翅膀、/ 思考 / 围巾都在动」。
import { deriveTrace } from '../lib/agent/trace.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass += 1; console.log(`  OK   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${d}`); }
};
const at = (ms) => 1_700_000_000_000 + ms;

const kindsOf = (turn) => (turn.blocks ?? []).map((b) => b.kind);

/* ================================================================
   1. step 内部被思考劈开的正文要接回去（主战场）
   ================================================================ */
console.log('\n[1] step 内部：正文被思考劈开');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '想A', at: at(2) },
    { type: 'text', text: '轮子、曲柄、腿、翅膀、', at: at(3) },
    { type: 'reasoning_delta', text: '想B', at: at(4) },
    { type: 'text', text: '围巾都在动。', at: at(5) },
    { type: 'step_end', step: 1, ms: 10, at: at(6) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(6) },
  ], { status: 'done' });

  const turn = view.turns[0];
  ok('块序列为 reasoning → text（不再是 R T R T）',
    JSON.stringify(kindsOf(turn)) === JSON.stringify(['reasoning', 'text']), JSON.stringify(kindsOf(turn)));

  const textBlock = turn.blocks.find((b) => b.kind === 'text');
  ok('正文接回完整一句', textBlock.text === '轮子、曲柄、腿、翅膀、围巾都在动。', JSON.stringify(textBlock.text));

  const reasonBlock = turn.blocks.find((b) => b.kind === 'reasoning');
  ok('思考也合并了', reasonBlock.text === '想A想B', JSON.stringify(reasonBlock.text));
}

/* ================================================================
   2. 工具是硬边界：R T C R T 不能被并成一坨
   ================================================================ */
console.log('\n[2] 工具调用是硬边界');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '想1', at: at(2) },
    { type: 'text', text: '先说一句', at: at(3) },
    { type: 'tool_start', name: 'read_file', path: 'a', at: at(4) },
    { type: 'tool_end', name: 'read_file', path: 'a', ok: true, ms: 5, at: at(5) },
    { type: 'reasoning_delta', text: '想2', at: at(6) },
    { type: 'text', text: '再说了句', at: at(7) },
    { type: 'step_end', step: 1, ms: 10, at: at(8) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(8) },
  ], { status: 'done' });

  const ks = kindsOf(view.turns[0]);
  ok('序列为 R T C R T', JSON.stringify(ks) === JSON.stringify(['reasoning', 'text', 'tool', 'reasoning', 'text']), JSON.stringify(ks));

  const texts = (view.turns[0].blocks ?? []).filter((b) => b.kind === 'text');
  ok('两段正文没有被合并', texts.length === 2, String(texts.length));
  ok('第一段是「先说一句」', texts[0].text === '先说一句');
  ok('第二段是「再说了句」', texts[1].text === '再说了句');
}

/* ================================================================
   3. 跨 step：完整句子不该被强行接续
   ================================================================ */
console.log('\n[3] 跨 step：上句已说完 → 不接');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'text', text: '第一轮说完了。', at: at(2) },
    { type: 'step_end', step: 1, ms: 5, at: at(3) },
    { type: 'llm_start', step: 2, at: at(10) },
    { type: 'text', text: '第二轮开始了。', at: at(11) },
    { type: 'step_end', step: 2, ms: 5, at: at(12) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(12) },
  ], { status: 'done' });

  const texts = (view.turns[0].blocks ?? []).filter((b) => b.kind === 'text');
  ok('保持为两段（不合并）', texts.length === 2, String(texts.length));
}

/* ================================================================
   4. 跨 step：上句没说完 → 接上
   ================================================================ */
console.log('\n[4] 跨 step：上句没说完 → 接上');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'text', text: '这句话还没说完，', at: at(2) },
    { type: 'step_end', step: 1, ms: 5, at: at(3) },
    { type: 'llm_start', step: 2, at: at(10) },
    { type: 'text', text: '下半句在这里。', at: at(11) },
    { type: 'step_end', step: 2, ms: 5, at: at(12) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(12) },
  ], { status: 'done' });

  const texts = (view.turns[0].blocks ?? []).filter((b) => b.kind === 'text');
  ok('接成一段', texts.length === 1, String(texts.length));
  ok('内容完整', texts[0].text === '这句话还没说完，下半句在这里。', JSON.stringify(texts[0]?.text));
}

/* ================================================================
   5. 跨 step：中间有工具 → 不接
   ================================================================ */
console.log('\n[5] 跨 step 且中间有工具 → 不接');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'text', text: '还没说完，', at: at(2) },
    { type: 'tool_start', name: 'write_file', path: 'x', at: at(3) },
    { type: 'tool_end', name: 'write_file', path: 'x', ok: true, ms: 5, at: at(4) },
    { type: 'step_end', step: 1, ms: 5, at: at(5) },
    { type: 'llm_start', step: 2, at: at(10) },
    { type: 'text', text: '改完了。', at: at(11) },
    { type: 'step_end', step: 2, ms: 5, at: at(12) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(12) },
  ], { status: 'done' });

  const texts = (view.turns[0].blocks ?? []).filter((b) => b.kind === 'text');
  ok('不合并（中间有工具）', texts.length === 2, String(texts.length));
}

/* ================================================================
   6. 完整模拟真实故障：连续多段
   ================================================================ */
console.log('\n[6] 真实故障形态复现');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '看一下', at: at(2) },
    { type: 'tool_start', name: 'read_file', path: 'index.html', at: at(3) },
    { type: 'tool_end', name: 'read_file', path: 'index.html', ok: true, ms: 20, at: at(4) },
    { type: 'llm_start', step: 2, at: at(10) },
    { type: 'reasoning_delta', text: '构建动画', at: at(11) },
    { type: 'text', text: '读完了，是个空白草稿。我把它换成一张全屏 SVG 动画：一只鹈鹕蹬着自行车，轮子、曲柄、腿、翅膀、', at: at(12) },
    { type: 'reasoning_delta', text: '写代码', at: at(13) },
    { type: 'text', text: '围巾都在动，背景有山和滚动的路面。', at: at(14) },
    { type: 'tool_start', name: 'write_file', path: 'index.html', at: at(15) },
    { type: 'tool_end', name: 'write_file', path: 'index.html', ok: true, ms: 289, at: at(16) },
    { type: 'llm_start', step: 3, at: at(20) },
    { type: 'reasoning_delta', text: '报告结果', at: at(21) },
    { type: 'text', text: '改好了，整站换成了鹈鹕骑车场景。', at: at(22) },
    { type: 'step_end', step: 3, ms: 50, at: at(23) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(23) },
  ], { status: 'done' });

  const ks = kindsOf(view.turns[0]);
  ok('完整序列正确', JSON.stringify(ks) === JSON.stringify(
    ['reasoning', 'tool', 'reasoning', 'text', 'tool', 'reasoning', 'text'],
  ), JSON.stringify(ks));

  const texts = (view.turns[0].blocks ?? []).filter((b) => b.kind === 'text');
  ok('被劈开的正文接回去了', texts[0].text.endsWith('围巾都在动，背景有山和滚动的路面。'), JSON.stringify(texts[0]?.text?.slice(-30)));
  ok('没有相邻两个 text 块', !ks.some((k, i) => k === 'text' && ks[i + 1] === 'text'));
}

/* ================================================================
   7. 老数据（没有 text 事件）不回归
   ================================================================ */
console.log('\n[7] 老数据兼容');
{
  const view = deriveTrace([
    { type: 'turn_start', turn: 1, at: at(0) },
    { type: 'llm_start', step: 1, at: at(1) },
    { type: 'reasoning_delta', text: '只有思考', at: at(2) },
    { type: 'tool_start', name: 'read_file', path: 'p', at: at(3) },
    { type: 'tool_end', name: 'read_file', path: 'p', ok: true, ms: 1, at: at(4) },
    { type: 'step_end', step: 1, ms: 5, at: at(5) },
    { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: at(5) },
  ], { status: 'done' });

  const ks = kindsOf(view.turns[0]);
  ok('仍有 reasoning + tool', ks.includes('reasoning') && ks.includes('tool'), JSON.stringify(ks));
  ok('没有 text 块', !ks.includes('text'));
}

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
