// Regression guard for the reasoning-fetch abort leak.
// Before the fix: cancel-while-pull-in-flight leaks an unhandled AbortError,
// which (with no process-level handler) kills the whole server.
// Run: node scripts/reasoning-fetch-abort-unit.mjs
import { makeReasoningFetch } from '../lib/agent/reasoning-fetch.js';

let leaked = null;
process.on('unhandledRejection', (e) => { leaked = e; });

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  OK  ', name); }
  else { fail += 1; console.log('  FAIL', name, extra); }
}

/** A gateway that emits one SSE chunk then hangs, like a model still thinking. */
function gatewayFetch() {
  return async (url, init) => {
    const signal = init?.signal;
    const enc = new TextEncoder();
    let c;
    const body = new ReadableStream({
      start(ctrl) {
        c = ctrl;
        ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning":"think"}}]}\n'));
      },
      pull() { return new Promise(() => { /* never resolves */ }); },
    });
    signal?.addEventListener('abort', () => {
      try { c.error(new DOMException('This operation was aborted', 'AbortError')); } catch { /* closed */ }
    }, { once: true });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

console.log('[1] 基本改写：reasoning → reasoning_content');
{
  const { injectReasoningContent } = await import('../lib/agent/reasoning-fetch.js');
  const line = 'data: {"choices":[{"delta":{"reasoning":"abc"}}]}';
  const out = injectReasoningContent(line);
  ok('补出 reasoning_content', out.includes('"reasoning_content":"abc"'));
  ok('原字段保留', out.includes('"reasoning":"abc"'));
  ok('非 data 行不动', injectReasoningContent('foo') === 'foo');
  ok('坏 JSON 原样返回', injectReasoningContent('data: {broken') === 'data: {broken');
}

console.log('\n[2] cancel 时 pull 正在 await reader.read()（线上崩溃的那个时序）');
{
  const patched = makeReasoningFetch(gatewayFetch());
  const ctrl = new AbortController();
  const res = await patched('http://x', { signal: ctrl.signal });
  const reader = res.body.getReader();

  const first = await reader.read();
  ok('读到第一块', first.done === false);

  // 让 pull() 卡在 await reader.read() 上
  reader.read().catch(() => {});

  // 像 LangChain 那样取消
  ctrl.abort();
  await reader.cancel(new DOMException('This operation was aborted', 'AbortError')).catch(() => {});

  await new Promise((r) => setTimeout(r, 600));
  ok('没有 unhandledRejection', leaked === null, leaked ? `${leaked.name}: ${leaked.message}` : '');
}

console.log('\n[3] abort 后流给出错误（不是静默吞掉）');
{
  leaked = null;
  const patched = makeReasoningFetch(gatewayFetch());
  const ctrl = new AbortController();
  const res = await patched('http://x', { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read();
  const pending = reader.read().catch((e) => e);
  ctrl.abort();
  const outcome = await pending;
  ok('读取以错误结束', outcome instanceof Error, String(outcome));
  await new Promise((r) => setTimeout(r, 400));
  ok('仍然没有 unhandledRejection', leaked === null);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
