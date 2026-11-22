// deriveTrace 的行为验证：给固定事件序列，断言视图输出。
// 纯函数，不连数据库、不起服务，所以可以在本地直接跑。
import { normalizeEvents, deriveTrace } from '../lib/agent/trace.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       期望: ${e}`);
    console.log(`       实际: ${a}`);
  }
}

function checkTrue(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`); }
}

/* ================================================================
   1. v2 事件：turn / step / tool_start / tool_end / retry
   ================================================================ */
console.log('\n[1] v2 事件：基本分组与统计');

const v2 = [
  { type: 'turn_start', turn: 1, at: 1000 },
  { type: 'llm_start', step: 1, at: 1010 },
  { type: 'reasoning_delta', text: '先读文件', at: 1020 },
  { type: 'tool_start', name: 'read_file', path: 'index.html', step: 1, at: 1030 },
  { type: 'tool_end', name: 'read_file', path: 'index.html', ok: true, ms: 42, step: 1, at: 1072 },
  { type: 'step_end', step: 1, ms: 62, at: 1080 },
  { type: 'llm_start', step: 2, at: 1090 },
  { type: 'retry', attempt: 1, maxRetries: 2, waitMs: 500, failure: { code: 'TRANSPORT', message: 'boom' }, at: 1100 },
  { type: 'reasoning_delta', text: '再改', at: 1110 },
  { type: 'tool_start', name: 'write_file', path: 'index.html', step: 2, at: 1150 },
  { type: 'tool_end', name: 'write_file', path: 'index.html', ok: true, ms: 606, step: 2, at: 1756 },
  { type: 'step_end', step: 2, ms: 666, at: 1760 },
  { type: 'turn_end', turn: 1, reason: { kind: 'done', steps: 2 }, at: 1770 },
];

const view = deriveTrace(v2, { status: 'done', text: '改好了' });

check('轮数', view.turns.length, 1);
check('第1轮的步数', view.turns[0].steps.length, 2);
check('第1轮耗时', view.turns[0].ms, 770);
check('工具总数', view.totals.toolCount, 2);
check('成功数', view.totals.okCount, 2);
check('失败数', view.totals.failCount, 0);
check('重试次数', view.totals.retryCount, 1);
check('改了几处', view.totals.changed, 1);
check('已读取文件', view.filesRead.map((f) => f.path), ['index.html']);
check('已修改文件', view.filesChanged.map((f) => f.path), ['index.html']);
check('第1步思考', view.turns[0].steps[0].reasoning, '先读文件');
check('第2步思考', view.turns[0].steps[1].reasoning, '再改');
check('工具与 start 配对（ms 来自 end）', view.turns[0].steps[0].tools[0].ms, 42);
check('配对的工具是 done 状态', view.turns[0].steps[0].tools[0].done, true);
check('family: tool 数量', view.families.tool.length, 2);
check('family: file 数量', view.families.file.length, 2);
check('family: error 数量（含重试）', view.families.error.length, 1);
check('family: reasoning 数量', view.families.reasoning.length, 2);
checkTrue('family: message 有正文', view.families.message.length === 1);

/* ================================================================
   2. v1 兼容：reasoning 是累积快照，必须去重取最长
   ================================================================ */
console.log('\n[2] v1 快照去重（老数据不能重复拼接）');

const v1 = [
  { type: 'llm_start', step: 1, at: 100 },
  { type: 'reasoning', text: '思考A', at: 110 },
  { type: 'reasoning', text: '思考A思考B', at: 120 },        // 更完整的快照
  { type: 'tool_end', name: 'read_file', path: 'a.html', ok: true, ms: 10, step: 1, at: 130 },
  { type: 'step_end', step: 1, ms: 40, at: 140 },
];

const v1view = deriveTrace(v1, { status: 'done' });

check('v1 思考取最长快照', v1view.turns[0].steps[0].reasoning, '思考A思考B');
check('v1 工具仍能读到', v1view.totals.toolCount, 1);
check('v1 没有 turn 标记也能分轮', v1view.turns.length, 1);

/* ================================================================
   3. 顺序正确性：思考不能被摊到最后一轮
   （这正是老「整轮快照 append 到末尾」的 bug）
   ================================================================ */
console.log('\n[3] 思考归属正确的轮次');

const order = [
  { type: 'turn_start', turn: 1, at: 1000 },
  { type: 'llm_start', step: 1, at: 1010 },
  { type: 'reasoning_delta', text: '第一轮的想法', at: 1020 },
  { type: 'tool_start', name: 'read_file', path: 'a.html', step: 1, at: 1030 },
  { type: 'tool_end', name: 'read_file', path: 'a.html', ok: true, ms: 5, step: 1, at: 1035 },
  { type: 'turn_end', turn: 1, reason: { kind: 'done' }, at: 1040 },
  { type: 'turn_start', turn: 2, at: 2000 },
  { type: 'llm_start', step: 1, at: 2010 },
  { type: 'reasoning_delta', text: '第二轮的想法', at: 2020 },
  { type: 'tool_start', name: 'write_file', path: 'b.html', step: 1, at: 2030 },
  { type: 'tool_end', name: 'write_file', path: 'b.html', ok: true, ms: 8, step: 1, at: 2038 },
  { type: 'turn_end', turn: 2, reason: { kind: 'done' }, at: 2040 },
];

const ov = deriveTrace(order, { status: 'done' });
check('两轮分开', ov.turns.length, 2);
check('第1轮只有一个思考', ov.turns[0].steps[0].reasoning, '第一轮的想法');
check('第2轮的思考属于第2轮', ov.turns[1].steps[0].reasoning, '第二轮的想法');
checkTrue('每轮的工具各归各轮',
  ov.turns[0].steps[0].tools[0].name === 'read_file'
  && ov.turns[1].steps[0].tools[0].name === 'write_file');

/* ================================================================
   4. 失败与当前动作
   ================================================================ */
console.log('\n[4] 失败态与 currentAction');

const failed = [
  { type: 'turn_start', turn: 1, at: 100 },
  { type: 'llm_start', step: 1, at: 110 },
  { type: 'tool_start', name: 'write_file', path: 'x.html', step: 1, at: 120 },
  { type: 'tool_end', name: 'write_file', path: 'x.html', ok: false, error: '路径不合法', ms: 3, step: 1, at: 123 },
  { type: 'turn_end', turn: 1, reason: { kind: 'error', error: { code: 'LLM', message: 'x' } }, at: 130 },
];

const fv = deriveTrace(failed, { status: 'failed' });
check('失败数', fv.totals.failCount, 1);
check('失败工具的 error 保留', fv.turns[0].steps[0].tools[0].error, '路径不合法');
check('family: error 有这条', fv.families.error.length, 1);
checkTrue('currentAction 显示失败', /失败/.test(fv.currentAction), fv.currentAction);

// 运行中：有未完成的 tool_start → 显示正在读
const running = [
  { type: 'turn_start', turn: 1, at: 100 },
  { type: 'llm_start', step: 1, at: 110 },
  { type: 'tool_start', name: 'read_file', path: 'index.html', step: 1, at: 120 },
];
const rv = deriveTrace(running, { status: 'running' });
check('运行中 currentAction', rv.currentAction, '正在读取 index.html…');
checkTrue('运行中 running=true', rv.running === true);

/* ================================================================
   5. 空/异常输入不能炸
   ================================================================ */
console.log('\n[5] 空输入与脏数据');

const empty = deriveTrace([], { status: 'done' });
check('空事件 → 0 轮', empty.turns.length, 0);
check('空事件 → 0 工具', empty.totals.toolCount, 0);
checkTrue('空事件不抛错', true);

const dirty = deriveTrace([
  null,
  undefined,
  { type: 'unknown_type', foo: 1 },
  { type: 'tool_end', name: 'read_file', ok: false, error: 'x' },  // 没有 path、没有 step
  'string-instead-of-object',
  42,
], { status: 'done' });
checkTrue('脏数据不抛错且能出工具', dirty.totals.toolCount === 1);
check('脏数据 → error family', dirty.families.error.length, 1);

/* ================================================================
   6. normalizeEvents 幂等
   ================================================================ */
console.log('\n[6] normalizeEvents 幂等与 seq');

const once = normalizeEvents(v2);
const twice = normalizeEvents(once);
check('归一化两次结果一致', once, twice);
check('seq 从 1 开始连续', once.map((e) => e.seq).slice(0, 4), [1, 2, 3, 4]);
check('未知类型被丢弃', normalizeEvents([{ type: 'whatever' }]).length, 0);

/* ================================================================
   结果
   ================================================================ */
console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
