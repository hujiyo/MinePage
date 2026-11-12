// 一次模型调用（单轮，不带循环）。
//
// 只实现 openai-completions 协议：DeepSeek / Moonshot / GLM / Ollama / 大多数网关
// 都说这套，换后端只改 models.js 里的配置。不引任何 SDK —— 一个 fetch 就够，
// 引 SDK 反而多一层版本锁定和错误类型翻译。
//
// 这个文件只管「问一次、拿一个回复」，循环在 loop.js 里。

import { AGENT_REQUEST_TIMEOUT_MS } from '../config.js';
import { modelApiKey } from './models.js';

/**
 * 模型调用失败。带 code 方便上层区分「重试有用」和「重试没用」。
 *   TRANSPORT / TIMEOUT / SERVER / RATE_LIMIT → 可以重试
 *   AUTH / INVALID_REQUEST / NO_MODEL          → 重试没用，直接告诉用户
 */
export class LlmError extends Error {
  constructor(message, code = 'UNKNOWN', detail = '') {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.detail = detail;
  }
}

const RETRYABLE = new Set(['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE']);

export function isRetryable(err) {
  return err instanceof LlmError && RETRYABLE.has(err.code);
}

/**
 * 调一次模型。
 *
 * @param {object} opt
 *   cfg        models.js 里的一条模型配置
 *   messages   对话数组（含 system）
 *   tools      OpenAI 格式的工具清单；空数组表示这次不给工具
 *   signal     AbortSignal（整轮的超时由 loop 控制）
 *   temperature 默认 0.2 —— 改页面这种活要稳，不要发挥
 * @returns {Promise<{content:string, toolCalls:Array, raw:object, usage:object}>}
 */
export async function chat({ cfg, messages, tools = [], signal, temperature = 0.2 }) {
  if (!cfg) throw new LlmError('没有可用的模型配置', 'NO_MODEL');

  const key = modelApiKey(cfg);
  if (cfg.apiKeyEnv && !key) {
    throw new LlmError(`模型「${cfg.label}」缺少 API Key（环境变量 ${cfg.apiKeyEnv}）`, 'AUTH');
  }

  const url = `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    temperature,
    stream: false,
  };
  // 不给工具时不要塞空数组：有些网关对 tools: [] 会报 400
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // 单次请求的超时 + 外部的整轮取消，两个信号取或
  const timer = AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    // 外部取消（用户点了停止 / 整轮超时）要如实说，别伪装成网络错误
    if (signal?.aborted) throw new LlmError('这一轮被取消了', 'ABORTED');
    if (err?.name === 'TimeoutError') {
      throw new LlmError(`模型 ${Math.round(AGENT_REQUEST_TIMEOUT_MS / 1000)} 秒没响应`, 'TIMEOUT');
    }
    throw new LlmError(`连不上模型服务（${cfg.baseURL}）`, 'TRANSPORT', String(err?.message ?? err));
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('模型服务拒绝了这个 Key', 'AUTH', text);
    }
    if (res.status === 429) {
      throw new LlmError('模型服务限流了，稍等一会儿', 'RATE_LIMIT', text);
    }
    if (res.status >= 500) {
      throw new LlmError('模型服务出错了', 'SERVER', text);
    }
    throw new LlmError(`模型请求被拒绝（HTTP ${res.status}）`, 'INVALID_REQUEST', text);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new LlmError('模型返回的不是合法 JSON', 'SERVER');
  }

  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new LlmError('模型返回里没有 message', 'SERVER', JSON.stringify(data).slice(0, 300));

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const content = typeof msg.content === 'string' ? msg.content : '';

  // 既没说话也没调工具 =  degenerate 回复，重试一次通常就好了
  if (!content.trim() && toolCalls.length === 0) {
    throw new LlmError('模型返回了空回复', 'EMPTY_RESPONSE');
  }

  return {
    content,
    toolCalls,
    usage: data.usage ?? {},
    raw: msg,
  };
}

/**
 * 带重试的调用：只对可重试的失败重试，最多 2 次，指数退避。
 * 不重试的理由很简单——AUTH / INVALID_REQUEST 换多少次都一样，白白让用户多等。
 */
export async function chatWithRetry({ cfg, messages, tools, signal, maxRetries = 2, onRetry }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await chat({ cfg, messages, tools, signal });
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || !isRetryable(err) || attempt === maxRetries) break;
      if (onRetry) onRetry(err, attempt + 1);
      // 500ms, 1000ms；加一点抖动，避免多用户同时重试打成尖峰
      const wait = 500 * 2 ** attempt + Math.random() * 200;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
