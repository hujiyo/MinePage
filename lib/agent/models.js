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
//   label          界面上显示的名字
//   hint           一句话说明（界面第二行）
//   provider       厂商 / 网关名，只用于展示与日志
//   baseURL        接口根地址（openai-completions 协议要带 /v1）
//   model          传给接口的模型 id
//   api            协议。目前只实现 openai-completions
//   apiKeyEnv      从哪个环境变量读 key。留空表示不需要 key（例如本机 Ollama）
//   supportsTools  支不支持 function calling。**这是 agent 的硬门槛**
//   contextWindow  上下文窗口（token），循环据此决定带多少历史
//   maxOutput      单次输出上限（token）
//
// 下面这 8 个模型都在当前网关上实测过：能正常返回 tool_calls。

const ENV = (key) => (key ? process.env[key] ?? '' : '');

const GATEWAY = process.env.LLM_BASE_URL ?? 'https://amr-link.open-design.ai/v1';

/** 网关上的模型，字段都一样，用个小工厂少写重复。 */
function gw({ label, hint, model, contextWindow = 128_000, maxOutput = 8_192 }) {
  return {
    label,
    hint,
    provider: 'OpenDesign',
    baseURL: GATEWAY,
    model,
    api: 'openai-completions',
    apiKeyEnv: 'LLM_API_KEY',
    supportsTools: true,
    contextWindow,
    maxOutput,
  };
}

export const MODELS = {
  'claude-haiku-5.5': gw({
    label: 'Claude Haiku 5.5',
    hint: '稳，长文本理解好',
    model: 'claude-haiku-5.5',
    contextWindow: 200_000,
  }),

  'gpt-6-luna': gw({
    label: 'GPT-6 Luna',
    hint: '通用能力强',
    model: 'gpt-6-luna',
    contextWindow: 200_000,
    maxOutput: 16_384,
  }),

  'deepseek-v4.1-flash': gw({
    label: 'DeepSeek V4.1 Flash',
    hint: '快，日常改页面首选',
    model: 'deepseek-v4.1-flash',
    maxOutput: 8_192,
  }),

  'minimax-m3.1-flash': gw({
    label: 'MiniMax M3.1 Flash',
    hint: '快，中文表达好',
    model: 'minimax-m3.1-flash',
    contextWindow: 128_000,
  }),

  'glm-5.3-flashx': gw({
    label: 'GLM-5.3 Flash-X',
    hint: 'GLM 加强版',
    model: 'glm-5.3-flashx',
  }),

  'mimo-v2.6-flash': gw({
    label: 'MiMo V2.6 Flash',
    hint: '快',
    model: 'mimo-v2.6-flash',
    contextWindow: 128_000,
  }),

  'mimo-v2.6-pro': gw({
    label: 'MiMo V2.6 Pro',
    hint: '慢一点但更细致',
    model: 'mimo-v2.6-pro',
    contextWindow: 128_000,
    maxOutput: 16_384,
  }),

  'glm-5.3-flash': gw({
    label: 'GLM-5.3 Flash',
    hint: 'GLM 标准版',
    model: 'glm-5.3-flash',
  }),
};

// 兼容旧的别名（数据库里存过 'fast' / 'smart' / 'coder' 的会话不至于报错）
const ALIASES = {
  fast: 'deepseek-v4.1-flash',
  smart: 'deepseek-v4.1-flash',
  coder: 'deepseek-v4.1-flash',
  local: 'deepseek-v4.1-flash',
};

/** 某个模型现在能不能用（只看 key 配没配）。 */
export function isModelReady(id) {
  const m = MODELS[id];
  if (!m) return false;
  if (!m.apiKeyEnv) return true;              // 不需要 key
  return Boolean(ENV(m.apiKeyEnv));
}

/** 取一个模型配置；不认识就返回 null（不静默兜底，避免用错模型）。 */
export function resolveModel(id) {
  if (!id) return null;
  return MODELS[id] ?? MODELS[ALIASES[id]] ?? null;
}

/** 把别名归一到真实 id，用于写库和比较。 */
export function canonicalModelId(id) {
  if (!id) return null;
  if (MODELS[id]) return id;
  return ALIASES[id] ?? null;
}

// 探活结果缓存：id -> { ok, at }
const PROBE_TTL_MS = 30_000;
const probeCache = new Map();

/**
 * 探活一个模型现在到底能不能用。
 *
 * 网关上的模型只用检查 key 在不在 —— 真连不上会在调用时报错，那属于运行时问题。
 * 这个函数留着是为了以后加本机 Ollama 时不用改调用方。
 */
export async function probeModel(id, { timeoutMs = 1500 } = {}) {
  const real = canonicalModelId(id);
  if (!real) return false;

  const cached = probeCache.get(real);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.ok;

  const m = MODELS[real];
  let ok;
  if (m.apiKeyEnv) {
    ok = Boolean(ENV(m.apiKeyEnv));
  } else {
    ok = await reachable(m.baseURL, timeoutMs);
  }

  probeCache.set(real, { ok, at: Date.now() });
  return ok;
}

/** 轻量探活：只关心「有没有 HTTP 响应」，不解析内容。 */
async function reachable(baseURL, timeoutMs) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** 清掉探活缓存。 */
export function clearProbeCache() {
  probeCache.clear();
}

/** 给前端看：只暴露 id / 名字 / 能力，绝不带 key 和 baseURL。 */
export async function publicModelList(preferred) {
  const real = canonicalModelId(preferred);
  return Promise.all(
    Object.entries(MODELS).map(async ([id, m]) => ({
      id,
      label: m.label,
      hint: m.hint,
      provider: m.provider,
      model: m.model,
      supportsTools: m.supportsTools,
      contextWindow: m.contextWindow,
      ready: await probeModel(id),
      default: id === real,
    })),
  );
}

/** 挑一个真正可用的默认模型。 */
export async function pickUsableModel(preferred) {
  const real = canonicalModelId(preferred);
  const order = real
    ? [real, ...Object.keys(MODELS).filter((id) => id !== real)]
    : Object.keys(MODELS);

  for (const id of order) {
    const m = MODELS[id];
    if (!m || !m.supportsTools) continue;
    if (await probeModel(id)) return id;
  }
  return null;
}

/** 读一个模型对应的 apiKey（读不到返回空串）。 */
export function modelApiKey(cfg) {
  return cfg ? ENV(cfg.apiKeyEnv) : '';
}

/* ------------------------------------------------------------
   工作模式
   ------------------------------------------------------------
   同一个模型既能聊天也能编码 —— 区别在**给不给工具**。
   对话模式不给工具，模型就只能回文字，物理上改不了文件。
   ------------------------------------------------------------ */

export const MODES = {
  chat: {
    label: '对话',
    hint: '只回答，不改文件',
    tools: false,
  },
  code: {
    label: '编码',
    hint: '可以读写文件',
    tools: true,
  },
};

export const DEFAULT_MODE = 'code';

/** 归一化模式值，不认识就退回默认。 */
export function canonicalMode(mode) {
  return MODES[mode] ? mode : DEFAULT_MODE;
}

/** 给前端看的模式清单。 */
export function publicModeList(current) {
  const cur = canonicalMode(current);
  return Object.entries(MODES).map(([id, m]) => ({
    id,
    label: m.label,
    hint: m.hint,
    tools: m.tools,
    default: id === cur,
  }));
}

/** 这个模式要不要给模型工具。 */
export function modeUsesTools(mode) {
  return MODES[canonicalMode(mode)].tools;
}
