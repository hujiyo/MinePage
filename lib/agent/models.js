// 可用模型清单。
//
// 为什么单独一个文件、而不是散在环境变量里：
//   - 换模型不该改代码；但「有哪些模型」是产品决策，也不该只藏在 env 里；
//   - 每个模型的窗口大小、输出上限、支不支持工具调用都不一样，这些数字循环要读；
//   - 前端要显示「有哪些模型可选」，但不能看到 key 和 baseURL。
//
// 加一个模型 = 在 MODELS 里加一条。key 从环境变量读，永远不落库、不下发给前端。
//
// 字段说明：
//   provider       厂商 / 网关名，只用于展示与日志
//   baseURL        接口根地址（openai-completions 协议要带 /v1）
//   model          传给接口的模型 id
//   api            协议。目前只实现 openai-completions —— DeepSeek / Moonshot /
//                  GLM / Ollama / 大多数网关都说这套，换后端只改配置
//   apiKeyEnv      从哪个环境变量读 key。留空表示不需要 key（例如本机 Ollama）
//   supportsTools  支不支持 function calling。**这是 agent 的硬门槛**，
//                  不支持就只能在对话里回文字，动不了文件
//   contextWindow  上下文窗口（token），循环据此决定带多少历史
//   maxOutput      单次输出上限（token），写大文件时会被截断，要心里有数

const ENV = (key) => (key ? process.env[key] ?? '' : '');

// 网关地址与 key 都走环境变量；模型 id 给一个默认值，可用环境变量覆盖。
// 当前网关（amr-link.open-design.ai）实测：deepseek-v4.1-flash / glm-5.3-flash /
// kimi-k2.7-code 三个都支持工具调用与流式，优先用 deepseek-v4.1-flash（最快）。
const GATEWAY = process.env.LLM_BASE_URL ?? 'https://amr-link.open-design.ai/v1';

export const MODELS = {
  fast: {
    label: 'Fast',
    hint: '日常改页面，快',
    provider: 'OpenDesign',
    baseURL: GATEWAY,
    model: process.env.LLM_MODEL ?? 'deepseek-v4.1-flash',
    api: 'openai-completions',
    apiKeyEnv: 'LLM_API_KEY',
    supportsTools: true,
    contextWindow: 128_000,
    maxOutput: 8_192,
  },

  smart: {
    label: 'Smart',
    hint: '复杂改版，慢一点但更靠谱',
    provider: 'OpenDesign',
    baseURL: GATEWAY,
    model: 'deepseek-v4-pro',
    api: 'openai-completions',
    apiKeyEnv: 'LLM_API_KEY',
    supportsTools: true,
    contextWindow: 128_000,
    maxOutput: 16_384,
  },

  coder: {
    label: 'Coder',
    hint: '写代码更稳',
    provider: 'OpenDesign',
    baseURL: GATEWAY,
    model: 'kimi-k2.7-code',
    api: 'openai-completions',
    apiKeyEnv: 'LLM_API_KEY',
    supportsTools: true,
    contextWindow: 128_000,
    maxOutput: 16_384,
  },

  local: {
    label: 'Local',
    hint: '本机 Ollama，不联网',
    provider: 'Ollama',
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b',
    api: 'openai-completions',
    apiKeyEnv: '',                 // 本地不需要 key
    supportsTools: true,
    contextWindow: 32_768,
    maxOutput: 4_096,
  },
};

/** 某个模型现在能不能用（key 有没有配、本地服务在不在不管）。 */
export function isModelReady(id) {
  const m = MODELS[id];
  if (!m) return false;
  if (!m.apiKeyEnv) return true;              // 不需要 key
  return Boolean(ENV(m.apiKeyEnv));
}

/** 取一个模型配置；不认识就返回 null（不静默兜底，避免用错模型）。 */
export function resolveModel(id) {
  return MODELS[id] ?? null;
}

/**
 * 默认模型：优先用配置里指定的那个，不可用就挑第一个 ready 的。
 * 一个都不可用时返回 null —— 调用方据此回「还没配置模型」而不是硬跑。
 *
 * 注意这是**同步**判断，只看 key 配没配。本机 Ollama 这类还得看服务在不在，
 * 那种检查要走 probeModel()（异步、带缓存）。
 */
export function pickDefaultModel(preferred) {
  if (preferred && isModelReady(preferred)) return preferred;
  const ready = Object.keys(MODELS).find((id) => isModelReady(id));
  return ready ?? null;
}

// 探活结果缓存：id -> { ok, at }
const PROBE_TTL_MS = 30_000;
const probeCache = new Map();

/**
 * 探活一个模型现在到底能不能用。
 *
 * 两种判断：
 *   - 要 key 的：key 配了就算可用（真连不上会在调用时报错，那属于运行时问题）
 *   - 不要 key 的（本机 Ollama）：必须真的能连上，否则 isModelReady 说 true
 *     会把一个连不上的模型当成默认，用户点发送才炸。这里用一次轻量 GET 探。
 *
 * 结果缓存 30 秒：列表页会被反复拉，不能每次都去打本地服务。
 */
export async function probeModel(id, { timeoutMs = 1500 } = {}) {
  const cached = probeCache.get(id);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.ok;

  const m = MODELS[id];
  if (!m) return false;

  let ok;
  if (m.apiKeyEnv) {
    // 要 key 的模型只检查 key 在不在；网络故障留给调用时的错误处理
    ok = Boolean(ENV(m.apiKeyEnv));
  } else {
    ok = await reachable(m.baseURL, timeoutMs);
  }

  probeCache.set(id, { ok, at: Date.now() });
  return ok;
}

/** 轻量探活：只关心「有没有 HTTP 响应」，不解析内容。 */
async function reachable(baseURL, timeoutMs) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 有响应就算活着：有的服务对 /models 回 401/404，说明端口是通的
    return res.status < 500;
  } catch {
    return false;
  }
}

/** 清掉探活缓存（改完配置重启不必要，但留个口子方便调试）。 */
export function clearProbeCache() {
  probeCache.clear();
}

/**
 * 给前端看：只暴露 id / 名字 / 能力，绝不带 key 和 baseURL。
 * ready 用探活结果，所以这是异步的 —— 别在同步上下文里调用。
 */
export async function publicModelList(preferred) {
  const list = await Promise.all(
    Object.entries(MODELS).map(async ([id, m]) => ({
      id,
      label: m.label,
      hint: m.hint,
      provider: m.provider,
      model: m.model,
      supportsTools: m.supportsTools,
      contextWindow: m.contextWindow,
      ready: await probeModel(id),
      default: id === preferred,
    })),
  );
  return list;
}

/**
 * 挑一个真正可用的默认模型（异步版，带探活）。
 * 这是启动和接口该用的那个；pickDefaultModel 只适合「只看 key」的场合。
 */
export async function pickUsableModel(preferred) {
  const order = preferred ? [preferred, ...Object.keys(MODELS).filter((id) => id !== preferred)] : Object.keys(MODELS);
  for (const id of order) {
    if (!MODELS[id]) continue;
    // 不支持工具的模型当不了默认 —— 它动不了文件
    if (!MODELS[id].supportsTools) continue;
    if (await probeModel(id)) return id;
  }
  return null;
}

/** 读一个模型对应的 apiKey（读不到返回空串）。 */
export function modelApiKey(cfg) {
  return cfg ? ENV(cfg.apiKeyEnv) : '';
}
