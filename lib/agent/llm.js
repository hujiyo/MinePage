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

/* ============================================================
   流式调用
   ------------------------------------------------------------
   和 chat() 的区别只有一个：请求体 stream:true，响应是 SSE，边收边回调。

   为什么值得单写一段：agent 一轮 10–30 秒，非流式期间用户只能看「正在想…」；
   流式之后文字是一个字一个字出来的，体感差别很大。

   协议细节（openai-completions 的 SSE）：
     data: {"choices":[{"delta":{"content":"你"}}]}
     data: {"choices":[{"delta":{"tool_calls":[{"index":0,...}]}}]}
     data: [DONE]

   工具调用是**分片**下发的：id / name 只在第一片有，arguments 要按 index 累加。
   这是流式最容易写错的地方 —— 拼错了模型就会收到半截 JSON。
   ============================================================ */

/**
 * 流式调一次模型。
 *
 * @param {object} opt
 *   cfg        模型配置
 *   messages   对话数组
 *   tools      工具清单
 *   signal     取消信号
 *   onDelta    每收到一段文本回调 (text) => void
 *   temperature
 * @returns {Promise<{content:string, toolCalls:Array, raw:object, usage:object}>}
 *          返回结构和 chat() 完全一致，循环那边不用区分
 */
export async function chatStream({
  cfg,
  messages,
  tools = [],
  signal,
  onDelta,
  temperature = 0.2,
}) {
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
    stream: true,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const timer = AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (signal?.aborted) throw new LlmError('这一轮被取消了', 'ABORTED');
    if (err?.name === 'TimeoutError') {
      throw new LlmError(`模型 ${Math.round(AGENT_REQUEST_TIMEOUT_MS / 1000)} 秒没响应`, 'TIMEOUT');
    }
    throw new LlmError(`连不上模型服务（${cfg.baseURL}）`, 'TRANSPORT', String(err?.message ?? err));
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status === 401 || res.status === 403) throw new LlmError('模型服务拒绝了这个 Key', 'AUTH', text);
    if (res.status === 429) throw new LlmError('模型服务限流了，稍等一会儿', 'RATE_LIMIT', text);
    if (res.status >= 500) throw new LlmError('模型服务出错了', 'SERVER', text);
    throw new LlmError(`模型请求被拒绝（HTTP ${res.status}）`, 'INVALID_REQUEST', text);
  }

  // 有的网关对 stream:true 仍返回整包 JSON（不支持流式时）。这种情况直接按非流式解析，
  // 免得我们把一整个 JSON 当 SSE 解析，最后得到空回复。
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      usage: data.usage ?? {},
      raw: msg,
    };
  }
  if (!res.body) throw new LlmError('模型服务没有返回流', 'SERVER');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let content = '';
  let usage = {};
  /** index -> { id, name, arguments } —— 工具调用按 index 累积分片 */
  const toolAcc = new Map();
  let finished = false;

  const handleEvent = (rawEvent) => {
    for (const line of rawEvent.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { finished = true; continue; }

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        // 单条坏 JSON 不该打断整个流，跳过继续
        continue;
      }

      if (json.usage) usage = json.usage;

      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (onDelta) {
          try { onDelta(delta.content); } catch { /* 回调出错不影响收流 */ }
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          const idx = part.index ?? 0;
          let acc = toolAcc.get(idx);
          if (!acc) {
            acc = { id: '', name: '', arguments: '' };
            toolAcc.set(idx, acc);
          }
          // id / name 只在第一片有，后续是空；不要覆盖已有的
          if (part.id) acc.id = part.id;
          if (part.function?.name) acc.name = part.function.name;
          if (part.function?.arguments) acc.arguments += part.function.arguments;
        }
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleEvent(rawEvent);
      }
    }
    // 收尾：最后一段可能没有以空行结尾
    if (buffer.trim()) handleEvent(buffer);
  } catch (err) {
    if (signal?.aborted) throw new LlmError('这一轮被取消了', 'ABORTED');
    if (err?.name === 'TimeoutError') {
      throw new LlmError(`模型 ${Math.round(AGENT_REQUEST_TIMEOUT_MS / 1000)} 秒没响应`, 'TIMEOUT');
    }
    throw new LlmError('收流中断了', 'TRANSPORT', String(err?.message ?? err));
  }

  // 拼成和 chat() 一样的 tool_calls 结构，交给循环统一处理
  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, acc]) => ({
      id: acc.id || `stream_call_${idx}`,
      type: 'function',
      function: { name: acc.name, arguments: acc.arguments || '{}' },
    }))
    .filter((c) => c.function.name);

  if (!content.trim() && toolCalls.length === 0 && !finished) {
    throw new LlmError('流式回复是空的', 'EMPTY_RESPONSE');
  }
  if (!content.trim() && toolCalls.length === 0) {
    throw new LlmError('模型返回了空回复', 'EMPTY_RESPONSE');
  }

  return {
    content,
    toolCalls,
    usage,
    raw: {
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
  };
}

/**
 * 带重试的流式调用。
 *
 * 注意：**已经吐出去的字收不回来**。所以只在「一个字都还没吐」时才重试；
 * 一旦开始输出，失败就直接抛给上层 —— 否则用户会看到同一段话重复两遍。
 */
export async function chatStreamWithRetry({
  cfg, messages, tools, signal, onDelta, maxRetries = 2, onRetry,
}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let started = false;
    try {
      return await chatStream({
        cfg,
        messages,
        tools,
        signal,
        onRetry,
        onDelta: (t) => {
          started = true;
          if (onDelta) onDelta(t);
        },
      });
    } catch (err) {
      lastErr = err;
      const canRetry = !started && !signal?.aborted && isRetryable(err) && attempt < maxRetries;
      if (!canRetry) break;
      if (onRetry) onRetry(err, attempt + 1);
      const wait = 500 * 2 ** attempt + Math.random() * 200;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
