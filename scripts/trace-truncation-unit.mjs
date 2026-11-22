// 验证 stringifyCapped：无论输入多大，输出都必须能被 JSON.parse。
// 这是 bug A 的回归测试 —— 老代码 JSON.stringify(x).slice(n) 会切坏结构，
// 前端 parse 失败后整个「执行过程」面板凭空消失。
import { readFileSync } from 'node:fs';

// stringifyCapped 是 task.js 的内部函数（没导出），这里复制一份同实现来验证逻辑，
// 再从源码里确认 task.js 用的就是它、且没有残留的字符串 slice。
const SRC = readFileSync(new URL('../lib/agent/task.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`); }
};

/* ---------- 1. 源码层面：不该再有对 JSON.stringify 结果做 slice ---------- */
console.log('\n[1] 源码里是否还有「截断 JSON 字符串」的写法');

// 先剥掉注释，否则会把「解释这个 bug 的注释」误判成 bug 本身
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/^\s*\/\/.*$/gm, '');      // 行注释

const badPattern = /JSON\.stringify\([^)]*\)\.slice\(/g;
const bad = CODE.match(badPattern) ?? [];
ok('可执行代码里没有 JSON.stringify(...).slice( 的写法', bad.length === 0, bad.join(' | '));
ok('使用了 stringifyCapped', /stringifyCapped\(/.test(CODE));
ok('stringifyCapped 定义了', /function stringifyCapped/.test(CODE));

/* ---------- 2. 行为层面：把函数体抽出来跑 ---------- */
console.log('\n[2] stringifyCapped 的超长处理');

// 从源码里把 stringifyCapped 函数体抽出来 eval（保证测的是真实实现）
const m = SRC.match(/function stringifyCapped\([\s\S]*?\n}\n/);
if (!m) {
  console.log('  FAIL 没能从源码里抽出 stringifyCapped');
  process.exitCode = 1;
  process.exit(1);
}
// eslint-disable-next-line no-eval
const stringifyCapped = eval(`(${m[0].replace(/^function stringifyCapped/, 'function')})`);

const cases = [
  ['空数组', []],
  ['少量元素', [{ a: 1 }, { b: 2 }]],
  ['正好超限', Array.from({ length: 100 }, (_, i) => ({ i, text: 'x'.repeat(100) }))],
  ['远超上限', Array.from({ length: 5000 }, (_, i) => ({ i, type: 'reasoning_delta', text: 'y'.repeat(200) }))],
];

for (const [name, arr] of cases) {
  for (const limit of [50, 500, 5000, 60_000, 400_000]) {
    const out = stringifyCapped(arr, limit);
    let parsed = null;
    let threw = null;
    try { parsed = JSON.parse(out); } catch (e) { threw = e.message; }

    const label = `${name} / limit=${limit}`;
    if (threw) {
      ok(label, false, '解析失败: ' + threw);
      continue;
    }
    // 必须还是数组
    if (!Array.isArray(parsed)) {
      ok(label, false, '结果不是数组');
      continue;
    }
    // 超限时应该是「丢头部、留尾部」
    if (out.length > limit && arr.length > 1) {
      ok(label, false, `超限: ${out.length} > ${limit}`);
      continue;
    }
    // 保留的必须是原数组的**后缀**（顺序不能乱）
    const kept = parsed.length;
    if (kept > 0) {
      const tailOfOrig = arr.slice(arr.length - kept);
      const same = JSON.stringify(tailOfOrig) === JSON.stringify(parsed);
      if (!same) { ok(label, false, '保留的不是原数组后缀'); continue; }
    }
    ok(label, true);
  }
}

/* ---------- 3. 极端值 ---------- */
console.log('\n[3] 边界值');
ok('limit=0 也能解析', Array.isArray(JSON.parse(stringifyCapped([{ a: 1 }], 0))));
ok('null 输入 → []', stringifyCapped(null, 100) === '[]');
ok('非数组输入 → []', stringifyCapped({ a: 1 }, 100) === '[]');
ok('单个超大元素不炸', (() => {
  try {
    const out = stringifyCapped([{ big: 'z'.repeat(10_000) }], 100);
    JSON.parse(out);
    return true;
  } catch { return false; }
})());

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
