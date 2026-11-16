// agent 可用模型：注册表 + 读写。
//
// 历史：这份清单以前是写死在本文件里的常量（8 个 gw() 工厂调用）。现在配置搬到了
// 数据库的 agent_models 表，后台可以增删改，用户能在会话里随时切。
//
// 关键约束（改代码时别破坏）：
//   1. resolveModel / canonicalModelId / isModelReady 对外仍是**同步**的。
//      它们被 llm.js、loop.js、compact.js、server.js 到处直接调用，改成 async
//      会传染一大片。所以做法是：进程内维护一份注册表 Map，启动时从库里灌，
//      后台改完再调 reloadModels() 重建。读永远走内存，写才碰数据库。
//   2. API key 明文只存在于内存注册表里，落库是密文（lib/agent/crypto.js）。
//   3. 下发给前端的东西绝不带 key 和 baseURL（见 publicModelList）。
//
// 启动顺序：server.js 在 listen 回调里调 `await loadModels()`，之后才处理请求。

import { all, get, run } from '../db.js';
import { AGENT_DEFAULT_MODEL } from '../config.js';
import { decryptSecret, encryptSecret } from './crypto.js';

/* ------------------------------------------------------------
   内置模型种子
   ------------------------------------------------------------
   首次启动（表里一条都没有）时把下面这些灌进去，行为与改造前一致：
   都指向 LLM_BASE_URL 网关，key 从 LLM_API_KEY 环境变量读。

   api_key 这里留空 —— 种子阶段没有 MODEL_SECRET，加密不了；
   运行时会走「环境变量兜底」：见 apiKeyOf()。
   管理员在后台填了 key 之后，就以库里的密文为准，环境变量只是兜底。
   ------------------------------------------------------------ */

const GATEWAY = process.env.LLM_BASE_URL ?? 'https://amr-link.open-design.ai/v1';

/**
 * 种子定义。字段名和表列一一对应，方便直接 INSERT。
 *
 * reasoning 标记的模型会先思考几百 token 再吐内容。坑：max_tokens 给小了，
 * 思考把预算吃光，content 变空串、finish_reason=length —— 看着像「模型做不到」，
 * 其实只是没给够预算。（我就在这里误判过 DeepSeek 不支持看图。）
 */
const SEED = [
  {
    id: 'claude-haiku-5.5', label: 'Claude Haiku 5.5', hint: '稳，长文本理解好，能看图',
    model: 'claude-haiku-5.5', contextWindow: 400_000, maxOutput: 8_192,
  },
  {
    id: 'gpt-6-luna', label: 'GPT-6 Luna', hint: '通用能力强，能看图',
    model: 'gpt-6-luna', contextWindow: 480_000, maxOutput: 16_384,
  },
  {
    id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', hint: '快，日常改页面首选，能看图',
    model: 'deepseek-v4.1-flash', contextWindow: 480_000, maxOutput: 8_192, reasoning: true,
    isDefault: true, isCompact: true,
  },
  {
    id: 'minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', hint: '快，中文表达好，能看图',
    model: 'minimax-m3.1-flash', contextWindow: 128_000, maxOutput: 8_192, reasoning: true,
  },
  {
    id: 'glm-5.3-flashx', label: 'GLM-5.3 Flash-X', hint: 'GLM 加强版，能看图',
    model: 'glm-5.3-flashx', contextWindow: 480_000, maxOutput: 8_192,
  },
  {
    id: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash', hint: '快，能看图',
    model: 'mimo-v2.6-flash', contextWindow: 480_000, maxOutput: 8_192, reasoning: true,
  },
  {
    id: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro', hint: '慢一点但更细致，能看图',
    model: 'mimo-v2.6-pro', contextWindow: 480_000, maxOutput: 16_384, reasoning: true,
  },
  {
    id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', hint: 'GLM 标准版，能看图',
    model: 'glm-5.3-flash', contextWindow: 480_000, maxOutput: 8_192,
  },
];

/** 老库兼容：历史会话里可能存过这些简写。 */
const ALIASES = {
  fast: 'deepseek-v4.1-flash',
  smart: 'deepseek-v4.1-flash',
  coder: 'deepseek-v4.1-flash',
  local: 'deepseek-v4.1-flash',
};

/* ------------------------------------------------------------
   进程内注册表
   ------------------------------------------------------------ */

/** id -> 完整配置（含解密后的 apiKey 明文）。只在内存里。 */
let registry = new Map();
let loaded = false;

/** 行 → 注册表条目。数据库的 snake_case 在这里转成代码里用的 camelCase。 */
function fromRow(row) {
  return {
    id: row.id,
    label: row.label,
    hint: row.hint,
    provider: row.provider,
    baseURL: row.base_url,
    api: row.api,
    model: row.model,
    apiKey: decryptSecret(row.api_key),   // 解不开就是空串
    hasStoredKey: Boolean(row.api_key),   // 有没有密文（用来区分「没配」和「配了但解不开」）
    supportsTools: Boolean(row.supports_tools),
    supportsVision: Boolean(row.supports_vision),
    reasoning: Boolean(row.reasoning),
    contextWindow: Number(row.context_window) || 128_000,
    maxOutput: Number(row.max_output) || 8_192,
    enabled: Boolean(row.enabled),
    builtin: Boolean(row.builtin),
    isDefault: Boolean(row.is_default),
    isCompact: Boolean(row.is_compact),
    sortOrder: Number(row.sort_order) || 0,
  };
}

/**
 * 取一个模型实际要用的 key。
 *
 * 优先级：库里的密文 > 环境变量 LLM_API_KEY。
 * 留环境变量兜底是为了「刚部署、还没进后台配」时 agent 也能用，
 * 以及本地开发不想把 key 写进库的场景。
 */
function apiKeyOf(cfg) {
  if (!cfg) return '';
  if (cfg.apiKey) return cfg.apiKey;
  // 只有内置种子（没在后台改过）才吃环境变量，避免管理员清空 key 后
  // 又悄悄被环境变量顶回去、看不出自己没配上
  if (cfg.builtin && !cfg.hasStoredKey) return String(process.env.LLM_API_KEY ?? '');
  return '';
}

/**
 * 从数据库重建注册表。启动时调一次，后台增删改后调一次。
 * @returns {Promise<number>} 载入的模型数量
 */
export async function loadModels() {
  const rows = await all('SELECT * FROM agent_models ORDER BY sort_order, id');
  const next = new Map();
  for (const row of rows) next.set(row.id, fromRow(row));
  registry = next;
  loaded = true;
  clearProbeCache();
  return registry.size;
}

/** 注册表灌过没有。没灌过就说明启动流程有问题，getModel 会返回 null。 */
export function modelsLoaded() {
  return loaded;
}

/* ------------------------------------------------------------
   种子：首次启动把内置 8 个写进库
   ------------------------------------------------------------ */

/**
 * 表是空的就灌种子。**只在完全空表时灌**，一旦管理员删光了也不重灌 ——
 * 否则「删掉不用的模型」这个动作会被下次重启撤销。
 */
export async function seedModelsIfEmpty() {
  const row = await get('SELECT COUNT(*) AS c FROM agent_models');
  if (Number(row?.c ?? 0) > 0) return 0;

  const now = new Date().toISOString();
  let seq = 0;
  for (const m of SEED) {
    await run(
      `INSERT INTO agent_models
         (id, label, hint, provider, base_url, api, model, api_key,
          supports_tools, supports_vision, reasoning, context_window, max_output,
          enabled, builtin, is_default, is_compact, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 'OpenDesign', ?, 'openai-completions', ?, '',
               1, 1, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
      m.id, m.label, m.hint, GATEWAY, m.model,
      m.reasoning ? 1 : 0, m.contextWindow, m.maxOutput,
      m.isDefault ? 1 : 0, m.isCompact ? 1 : 0, seq,
      now, now,
    );
    seq += 1;
  }
  return SEED.length;
}

/* ------------------------------------------------------------
   对外查询（同步，读内存）
   ------------------------------------------------------------ */

/** 所有模型（含停用的），给后台用。 */
export function allModels() {
  return [...registry.values()].sort((a, b) => (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id));
}

/** 只取启用的模型，给用户的选择器用。 */
export function enabledModels() {
  return allModels().filter((m) => m.enabled);
}

/** 取一个模型配置；不认识就返回 null（不静默兜底，避免用错模型）。 */
export function resolveModel(id) {
  if (!id) return null;
  const real = canonicalModelId(id);
  return real ? registry.get(real) ?? null : null;
}

/** 把别名归一到真实 id，用于写库和比较。 */
export function canonicalModelId(id) {
  if (!id) return null;
  if (registry.has(id)) return id;
  return ALIASES[id] ?? null;
}

/** 某个模型现在能不能用（启用 + 有 key 或不需要 key）。 */
export function isModelReady(id) {
  const m = resolveModel(id);
  if (!m || !m.enabled) return false;
  if (!m.api.startsWith('openai-')) return false;   // 目前只实现了一种协议
  return Boolean(apiKeyOf(m));                      // 没有 key 就用不了
}

/**
 * 当前默认模型 id。
 * 优先用后台勾了「默认」那条；没有就退回环境变量 AGENT_DEFAULT_MODEL；
 * 再没有就取第一个可用的启用模型。
 */
export function defaultModelId() {
  const marked = allModels().find((m) => m.enabled && m.isDefault);
  if (marked) return marked.id;
  const env = canonicalModelId(AGENT_DEFAULT_MODEL);
  if (env) return env;
  const first = enabledModels().find((m) => isModelReady(m.id));
  return first ? first.id : null;
}

/** 压缩专用模型 id。没勾就退回默认模型。 */
export function compactModelId() {
  const marked = allModels().find((m) => m.enabled && m.isCompact);
  if (marked) return marked.id;
  return defaultModelId();
}

/* ------------------------------------------------------------
   探活
   ------------------------------------------------------------ */

const PROBE_TTL_MS = 30_000;
const probeCache = new Map();

/** 探活：只看启用 + key 在不在。真连不上属于运行时问题，会在调用时报错。 */
export async function probeModel(id) {
  const real = canonicalModelId(id);
  if (!real) return false;

  const cached = probeCache.get(real);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.ok;

  const ok = isModelReady(real);
  probeCache.set(real, { ok, at: Date.now() });
  return ok;
}

/** 清掉探活缓存（注册表变了之后必须清，否则会拿旧结论）。 */
export function clearProbeCache() {
  probeCache.clear();
}

/* ------------------------------------------------------------
   给前端 / 后台的不同视图
   ------------------------------------------------------------ */

/** 给普通用户：只有 id / 名字 / 能力，**绝不带 key 和 baseURL**。 */
export async function publicModelList(preferred) {
  const real = canonicalModelId(preferred) ?? defaultModelId();
  const def = defaultModelId();
  return enabledModels().map((m) => ({
    id: m.id,
    label: m.label,
    hint: m.hint,
    provider: m.provider,
    model: m.model,
    supportsTools: m.supportsTools,
    supportsVision: m.supportsVision,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    ready: isModelReady(m.id),
    default: m.id === def,
  }));
}

/** 给管理员：多带配置详情，key 只给掩码，baseURL 可以看（它是接口地址不是秘密）。 */
export async function adminModelList() {
  const def = defaultModelId();
  const compact = compactModelId();
  return allModels().map((m) => {
    const key = apiKeyOf(m);
    return {
      id: m.id,
      label: m.label,
      hint: m.hint,
      provider: m.provider,
      baseURL: m.baseURL,
      api: m.api,
      model: m.model,
      // 只给掩码，明文永不出库
      keyMask: key ? maskForUi(key) : '',
      hasKey: Boolean(key),
      keyFromEnv: Boolean(m.builtin && !m.hasStoredKey && process.env.LLM_API_KEY),
      keyBroken: Boolean(m.hasStoredKey && !m.apiKey),   // 有密文但解不开（换过 MODEL_SECRET）
      supportsTools: m.supportsTools,
      supportsVision: m.supportsVision,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      enabled: m.enabled,
      builtin: m.builtin,
      isDefault: m.id === def,
      isCompact: m.id === compact,
      ready: isModelReady(m.id),
    };
  });
}

/** 界面上的掩码，和 crypto.js 里的 maskSecret 同口径（这里避免多引一层）。 */
function maskForUi(plain) {
  const s = String(plain ?? '');
  if (!s) return '';
  if (s.length <= 12) return '****';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/* ------------------------------------------------------------
   写操作（后台用）
   ------------------------------------------------------------ */

/** 读一个模型实际要用的 key（llm.js 调用前要它）。 */
export function modelApiKey(cfg) {
  return apiKeyOf(cfg);
}

/**
 * 新建或更新一个模型。key 传了才改，传空字符串表示「清空」，
 * 不传（undefined）表示「保持原样」—— 后台编辑时不会因为没重填 key 就被清掉。
 */
export async function upsertModel(input) {
  const now = new Date().toISOString();
  const exists = registry.has(input.id);

  const cols = {
    label: input.label ?? '',
    hint: input.hint ?? '',
    provider: input.provider ?? '',
    base_url: input.baseURL ?? '',
    api: input.api ?? 'openai-completions',
    model: input.model ?? '',
    supports_tools: input.supportsTools === false ? 0 : 1,
    supports_vision: input.supportsVision === false ? 0 : 1,
    reasoning: input.reasoning ? 1 : 0,
    context_window: Number(input.contextWindow) || 128_000,
    max_output: Number(input.maxOutput) || 8_192,
    enabled: input.enabled === false ? 0 : 1,
    updated_at: now,
  };

  if (exists) {
    const sets = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
    const params = Object.values(cols);
    // api_key 只在显式传了字符串时更新
    if (typeof input.apiKey === 'string') {
      await run(
        `UPDATE agent_models SET ${sets}, api_key = ? WHERE id = ?`,
        ...params, input.apiKey ? encryptSecret(input.apiKey) : '', input.id,
      );
    } else {
      await run(`UPDATE agent_models SET ${sets} WHERE id = ?`, ...params, input.id);
    }
  } else {
    await run(
      `INSERT INTO agent_models
         (id, label, hint, provider, base_url, api, model, api_key,
          supports_tools, supports_vision, reasoning, context_window, max_output,
          enabled, builtin, is_default, is_compact, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
      input.id, cols.label, cols.hint, cols.provider, cols.base_url, cols.api, cols.model,
      input.apiKey ? encryptSecret(input.apiKey) : '',
      cols.supports_tools, cols.supports_vision, cols.reasoning, cols.context_window, cols.max_output,
      cols.enabled, Number(input.sortOrder) || 0, now, now,
    );
  }

  await loadModels();
}

/** 删一个模型。内置的也允许删（管理员明确要清掉）。 */
export async function deleteModel(id) {
  const changes = (await run('DELETE FROM agent_models WHERE id = ?', id)).changes;
  await loadModels();
  return changes;
}

/**
 * 设默认模型。同一次 UPDATE 里把其他行的 is_default 清零，
 * 保证全局只有一条 —— 前端不需要处理「多个默认」这种状态。
 */
export async function setDefaultModel(id) {
  await run('UPDATE agent_models SET is_default = 0');
  if (id) await run('UPDATE agent_models SET is_default = 1 WHERE id = ?', id);
  await loadModels();
}

/** 设压缩专用模型。同样保证全局唯一；传 null 表示「跟随默认模型」。 */
export async function setCompactModel(id) {
  await run('UPDATE agent_models SET is_compact = 0');
  if (id) await run('UPDATE agent_models SET is_compact = 1 WHERE id = ?', id);
  await loadModels();
}

/**
 * 有多少个会话正在用这个模型。删除前给管理员看一眼（虽然按要求不弹提示，
 * 但后台列表里可以显示这个数字）。
 */
export async function countThreadsUsingModel(id) {
  const row = await get('SELECT COUNT(*) AS c FROM agent_threads WHERE model = ?', id);
  return Number(row?.c ?? 0);
}

/* ------------------------------------------------------------
   工作模式（与模型无关，保持原样）
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

/** 压缩模型 id 的旧导出名，compact.js 还在用。 */
export { compactModelId as COMPACT_MODEL_ID };
