// agent 里统一的错误类型。
//
// 为什么单独一个文件：它被 loop.js、server.js、compact.js 同时依赖，
// 而原来它长在 llm.js 里。改成 LangGraph 之后 llm.js 那 452 行手写
// HTTP 已经没用了，但错误类型还得留着 —— 拆出来最干净。
//
// code 的作用是让上层能区分「重试有用」和「重试没用」：
//   TRANSPORT / TIMEOUT / SERVER / RATE_LIMIT / EMPTY_RESPONSE → 可以重试
//   AUTH / INVALID_REQUEST / NO_MODEL / NO_KEY / MODEL_DISABLED → 重试没用

/** 可重试的失败码。和 nodes.js 里的 isRetryableErr 口径保持一致。 */
const RETRYABLE = new Set([
  'TRANSPORT',
  'TIMEOUT',
  'SERVER',
  'RATE_LIMIT',
  'EMPTY_RESPONSE',
  'REASONING_OVERFLOW',
]);

export class LlmError extends Error {
  constructor(message, code = 'UNKNOWN', detail = '') {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.detail = detail;
  }
}

/** 这个错误重试有没有意义。 */
export function isRetryable(err) {
  return err instanceof LlmError && RETRYABLE.has(err.code);
}

export { RETRYABLE };
