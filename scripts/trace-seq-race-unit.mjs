// 精确复现真实竞态：appendEvents 是 async，内部有 await db。
// 关键：eventSeq 的更新发生在 **await 之后**，而 pushEvents 在 await 之后再被调用。
import { readFileSync } from 'node:fs';

// 用真实的 appendEvents 逻辑（从 task.js 抽取核心行为），配一个慢速 sink
const TASK_SRC = readFileSync(new URL('../lib/agent/task.js', import.meta.url), 'utf8');

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass += 1; console.log(`  OK   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${d}`); }
};

// 模拟数据库：INSERT IGNORE，主键 (task_id, seq)
function makeDb(delayMs) {
  const rows = new Map();
  let ignored = 0;
  return {
    async insertIgnore(taskId, startSeq, events) {
      await new Promise((r) => setTimeout(r, delayMs));   // 模拟网络往返
      for (let i = 0; i < events.length; i += 1) {
        const key = `${taskId}:${startSeq + i}`;
        if (rows.has(key)) { ignored += 1; continue; }
        rows.set(key, events[i]);
      }
    },
    stats: () => ({ kept: rows.size, ignored }),
  };
}

// 旧写法：async 函数返回后才更新 eventSeq
function makeOldPushEvents(db, state) {
  return (taskId, list) => {
    if (list.length > state.appendedCount) {
      const fresh = list.slice(state.appendedCount);
      state.appendedCount = list.length;
      db.insertIgnore(taskId, state.eventSeq, fresh)
        .then((next) => { state.eventSeq = next; })
        .catch(() => {});
    }
  };
}

// 新写法：同步预留
function makeNewPushEvents(db, state) {
  return (taskId, list) => {
    if (list.length > state.appendedCount) {
      const fresh = list.slice(state.appendedCount);
      state.appendedCount = list.length;
      const startSeq = state.eventSeq;
      state.eventSeq = startSeq + fresh.length;
      db.insertIgnore(taskId, startSeq, fresh).catch(() => {});
    }
  };
}

// 模拟一轮 agent：事件同步地一条条进数组，pushEvents 被连续调用
// （真实场景：tools 节点里 tool_start→tool_end→step_end 之间没有 await）
const events = [];
function emit(push, taskId, ev) {
  events.push(ev);
  push(taskId, events);
}

async function runScenario(makePush, dbDelay) {
  const db = makeDb(dbDelay);
  const state = { appendedCount: 0, eventSeq: 1 };
  const push = makePush(db, state);
  events.length = 0;

  // 关键：这些 emit 全部在同一个 tick 里连续执行，中间没有 await
  emit(push, 't1', { type: 'turn_start' });
  emit(push, 't1', { type: 'llm_start' });
  emit(push, 't1', { type: 'tool_start' });
  emit(push, 't1', { type: 'tool_end' });
  emit(push, 't1', { type: 'tool_start' });
  emit(push, 't1', { type: 'tool_end' });
  emit(push, 't1', { type: 'turn_end' });

  // 等所有异步写入落定
  await new Promise((r) => setTimeout(r, dbDelay * 12 + 60));
  return { ...db.stats(), total: events.length };
}

console.log('\n[1] 旧写法在「同一 tick 连续 emit」下是否丢行');
const oldRes = await runScenario(makeOldPushEvents, 20);
console.log(`  保留 ${oldRes.kept}/${oldRes.total}, 被 IGNORE ${oldRes.ignored}`);
ok('旧写法确实会丢行（bug 复现）', oldRes.kept < oldRes.total, `${oldRes.kept}/${oldRes.total}`);
ok('旧写法产生 IGNORE', oldRes.ignored > 0, String(oldRes.ignored));

console.log('\n[2] 新写法同样场景下是否完整');
const newRes = await runScenario(makeNewPushEvents, 20);
console.log(`  保留 ${newRes.kept}/${newRes.total}, 被 IGNORE ${newRes.ignored}`);
ok('新写法一条不丢', newRes.kept === newRes.total, `${newRes.kept}/${newRes.total}`);
ok('新写法没有 IGNORE', newRes.ignored === 0, String(newRes.ignored));

console.log('\n[3] 不同 db 延迟下新写法都稳');
for (const d of [1, 5, 20, 50]) {
  const r = await runScenario(makeNewPushEvents, d);
  ok(`延迟 ${d}ms: ${r.kept}/${r.total}`, r.kept === r.total, `${r.kept}/${r.total}`);
}

console.log('\n[4] 源码检查（剥掉注释后再匹配）');
const stripped = TASK_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok('task.js 使用 INSERT IGNORE', /INSERT IGNORE INTO agent_task_events/.test(stripped));

const SRV = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const srvCode = SRV.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok('server.js 与 seq 相关的 .then 已消失', !/\.then\(\s*\(?next\)?\s*=>/.test(srvCode));
ok('server.js 同步预留 seq', /eventSeq\s*=\s*startSeq\s*\+/.test(srvCode));

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
