// 正在跑的 agent 任务的取消句柄。
//
// 为什么放内存里而不是数据库：
//   - 取消是一个「立刻生效」的动作，写库再轮询到下一轮才生效太慢；
//   - 进程重启后跑着的任务本来就会被 reapStaleTasks 标成失败，没有跨进程取消的需求。
//
// 一个任务对应一个 AbortController；任务结束时（成功/失败/取消）必须 unregister，
// 否则内存会随任务数一直涨。

const running = new Map(); // taskId -> AbortController

/** 登记一个正在跑的任务，返回它的 signal 给 runAgent 用。 */
export function register(taskId) {
  const controller = new AbortController();
  running.set(taskId, controller);
  return controller.signal;
}

/** 任务结束了（不管什么结局），把句柄摘掉。 */
export function unregister(taskId) {
  running.delete(taskId);
}

/**
 * 取消一个任务。
 * @returns {'aborted'|'not-running'} not-running 表示它已经跑完或压根没在跑
 */
export function cancel(taskId) {
  const controller = running.get(taskId);
  if (!controller) return 'not-running';
  controller.abort();
  // 这里不删：真正的清理由 runAgentTask 的 finally 做，
  // 删早了会让正在收尾的逻辑拿不到 aborted 状态。
  return 'aborted';
}

/** 这个任务现在跑着吗（给前端/调试用）。 */
export function isRunning(taskId) {
  return running.has(taskId);
}

/** 当前正在跑的任务数（监控用）。 */
export function runningCount() {
  return running.size;
}
