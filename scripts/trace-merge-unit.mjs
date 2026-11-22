// mergeWithV1（v1 补齐）的纯逻辑测试。
//
// 为什么要测：2026-11 的 seq 竞态 bug 会让 agent_task_events 缺行
// （tool_start 有、tool_end 没了）。修了 bug 不代表旧数据会自己好，
// 所以加了「新表残缺时用 v1 补齐」。这个补齐必须：
//   - 只补缺的，不重复已有的
//   - 不补思考增量（补了容易重复，且丢思考不会让界面错乱）
//   - 新表为空时整份用 v1
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../lib/agent/task.js', import.meta.url), 'utf8');

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass += 1; console.log(`  OK   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${d}`); }
};

// 从源码抽出 mergeWithV1 + parseV1Events（依赖 keyOf 等内部结构）
const mParse = SRC.match(/function parseV1Events\([\s\S]*?\n\}\n/);
const mMerge = SRC.match(/function mergeWithV1\([\s\S]*?\n\}\n/);
ok('抽出 parseV1Events', Boolean(mParse));
ok('抽出 mergeWithV1', Boolean(mMerge));

if (!mParse || !mMerge) {
  console.log('无法提取函数，终止');
  process.exit(1);
}

// eslint-disable-next-line no-eval
const { mergeWithV1, parseV1Events } = eval(`
  (() => {
    ${mParse[0]}
    ${mMerge[0]}
    return { mergeWithV1, parseV1Events };
  })()
`);

const mkRow = (events) => ({ id: 't', events: JSON.stringify(events) });

console.log('\n[1] 新表为空 → 整份用 v1');
const v1Full = [
  { type: 'tool_start', name: 'read_file', path: 'a.html', at: 100 },
  { type: 'tool_end', name: 'read_file', path: 'a.html', at: 110 },
];
const r1 = mergeWithV1([], mkRow(v1Full));
ok('返回 v1 全部', r1.length === 2, String(r1.length));
ok('内容一致', JSON.stringify(r1) === JSON.stringify(v1Full));

console.log('\n[2] 新表完整 → 不重复补');
const v2Complete = [
  { type: 'tool_start', name: 'read_file', path: 'a.html', at: 100 },
  { type: 'tool_end', name: 'read_file', path: 'a.html', at: 110 },
];
const r2 = mergeWithV1(v2Complete, mkRow(v1Full));
ok('条数不变', r2.length === 2, String(r2.length));
const ends2 = r2.filter((e) => e.type === 'tool_end').length;
ok('tool_end 没有变成 2 条', ends2 === 1, String(ends2));

console.log('\n[3] 新表残缺（seq 竞态现场）→ 补上缺的 tool_end');
const v1Broken = [
  { type: 'tool_start', name: 'write_file', path: 'books/a.html', at: 100 },
  { type: 'tool_end', name: 'write_file', path: 'books/a.html', at: 110 },
  { type: 'tool_start', name: 'write_file', path: 'books/b.html', at: 120 },
  { type: 'tool_end', name: 'write_file', path: 'books/b.html', at: 130 },
  { type: 'tool_start', name: 'write_file', path: 'books/c.html', at: 140 },
  { type: 'tool_end', name: 'write_file', path: 'books/c.html', at: 150 },
];
// 新表只剩前两对里的 start 和第一个 end（模拟 IGNORE 丢行）
const v2Broken = [
  { type: 'tool_start', name: 'write_file', path: 'books/a.html', at: 100 },
  { type: 'tool_end', name: 'write_file', path: 'books/a.html', at: 110 },
  { type: 'tool_start', name: 'write_file', path: 'books/b.html', at: 120 },
  { type: 'tool_start', name: 'write_file', path: 'books/c.html', at: 140 },
];
const r3 = mergeWithV1(v2Broken, mkRow(v1Broken));
const s3 = r3.filter((e) => e.type === 'tool_start').length;
const e3 = r3.filter((e) => e.type === 'tool_end').length;
ok('start 数 = 3', s3 === 3, String(s3));
ok('end 补齐到 3', e3 === 3, String(e3));
ok('start 与 end 配对', s3 === e3);

console.log('\n[4] 思考增量不补（避免重复）');
const v1WithReason = [
  { type: 'reasoning', text: '一整段思考内容', at: 100 },
  { type: 'tool_end', name: 'read_file', path: 'a.html', at: 110 },
];
const v2NoReason = [
  { type: 'reasoning_delta', text: '一整段思考内容', at: 100 },
];
const r4 = mergeWithV1(v2NoReason, mkRow(v1WithReason));
const reasonCount = r4.filter((e) => e.type === 'reasoning' || e.type === 'reasoning_delta').length;
ok('思考只有 1 条（没被 v1 再补一条）', reasonCount === 1, String(reasonCount));
ok('但 tool_end 补上了', r4.filter((e) => e.type === 'tool_end').length === 1);

console.log('\n[5] v1 是坏 JSON → 不影响 v2');
const badRow = { id: 't', events: '{"cut": "off"' };   // 模拟被 slice 截断
const r5 = mergeWithV1(v2Complete, badRow);
ok('v1 坏了仍返回 v2', r5.length === 2, String(r5.length));
ok('parseV1Events 对坏数据返回 null', parseV1Events(badRow) === null);

console.log('\n[6] 收尾标记补齐（step_end / turn_end 丢了会让整轮显示成还在跑）');
const v1Tail = [
  { type: 'tool_end', name: 'read_file', path: 'a.html', at: 100 },
  { type: 'step_end', step: 1, ms: 50, at: 110 },
  { type: 'turn_end', turn: 1, at: 120 },
];
const v2NoTail = [
  { type: 'tool_end', name: 'read_file', path: 'a.html', at: 100 },
];
const r6 = mergeWithV1(v2NoTail, mkRow(v1Tail));
ok('补上 step_end', r6.filter((e) => e.type === 'step_end').length === 1);
ok('补上 turn_end', r6.filter((e) => e.type === 'turn_end').length === 1);

console.log('\n[7] 合并后按时间排序');
const outOrder = r6.map((e) => e.type);
ok('顺序为 tool_end → step_end → turn_end',
  JSON.stringify(outOrder) === JSON.stringify(['tool_end', 'step_end', 'turn_end']),
  JSON.stringify(outOrder));

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
