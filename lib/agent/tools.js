// 工作区 agent 的工具集（这一层是「手」，模型是「脑」）。
//
// 和 lib/mcp/tools.js 的关系：
//   - MCP 那套是**给外部 AI 客户端**用的，认的是「用户 + 站名」，能力强、工具多；
//   - 这里这套是**工作区内置 agent** 用的，认的是「当前草稿的 siteId」，
//     故意收窄到 5 个工具：没有建站、没有删站、没有发布、没有任何账号操作。
//
// 安全模型（三条，缺一不可）：
//   1. siteId / userId 由服务端注入的 ctx 提供，模型只给 path，**永远指定不了改哪个站**；
//   2. 工具白名单就是下面这张表，模型调不到表外的东西；
//   3. 每个写操作前先过快照，改坏了能回滚。
//
// 每个工具的 run 签名统一为 run(args, ctx)，ctx = { siteId, userId }。
// siteId / userId 由服务端注入，模型不能自己指定目标站点。
// 返回对象会被 JSON.stringify 后作为 tool 消息回灌给模型，所以别塞巨大的二进制。

import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_SITE,
  SITE_DESC_MAX,
  SITE_TITLE_MAX,
} from '../config.js';
import { isValidSitePath } from '../sites.js';
import {
  assertStorageBudget,
  countSiteFiles,
  getSiteFile,
  listSiteFiles,
  removeSiteFile,
  updateSiteMeta,
  upsertSiteFile,
} from '../sites.js';
import { get } from '../db.js';

// 一次读文件最多回灌多少字符进上下文。再大就是往模型嘴里灌体积，
// 而且真实场景里没人会「整体重写」一个 200KB 的 CSS——那种改法本身就不可靠。
const READ_MAX_CHARS = 20000;

// list_files / 错误提示里最多列多少个文件路径。文件多的站（模板站动辄上千个）
// 全列出来会把上下文和 tool 结果一起撑爆。
const LIST_MAX = 40;

// 超过这个体积的文件，拒绝「整体覆盖写」。
//
// 原因：read_file 只回灌 READ_MAX_CHARS 个字符，模型看到的是残缺内容；
// 如果它照着残缺内容 write_file，剩下的部分就被无声删掉了。
// 与其让它悄悄搞坏，不如明确拒绝并引导用户手动改。
const LOOSE_WRITE_LIMIT = READ_MAX_CHARS * 3;

/** 工具里抛这个错，会被当成「可读的业务失败」回灌给模型，让它自己纠正。 */
export class AgentToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentToolError';
  }
}

function requirePath(raw) {
  const value = String(raw ?? '');
  if (!isValidSitePath(value)) {
    throw new AgentToolError(
      '文件路径不合法：不能以 / 开头、不能含反斜杠，每段只能用字母数字和 . _ -，且不能用 . 或 ..',
    );
  }
  return value;
}

function requireText(raw, label) {
  const value = String(raw ?? '');
  if (value.trim() === '') throw new AgentToolError(`${label}不能是空的`);
  return value;
}

// ---------------------------------------------------------------- 工具定义

const TOOLS = {
  list_files: {
    description:
      '列出当前草稿的全部文件（路径 + 大小）。改任何东西之前先用它看一眼有什么，'
      + '不要凭想象猜文件名。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async run(args, ctx) {
      const files = await listSiteFiles(ctx.siteId);
      // 上千个文件全吐出来会把上下文烧光，只给前 LIST_MAX 个 + 总数
      const shown = files.slice(0, LIST_MAX).map((f) => ({ path: f.path, size: f.size }));
      return {
        count: files.length,
        files: shown,
        more: files.length > LIST_MAX ? files.length - LIST_MAX : 0,
      };
    },
  },

  read_file: {
    description:
      '读当前草稿里某个文件的完整内容。改某个文件之前必须先读它，'
      + `否则你改出来的版本会丢掉原有内容。超过 ${READ_MAX_CHARS} 字符会被截断。`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '站点内相对路径，例如 index.html、assets/css/style.css',
        },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const path = requirePath(args.path);
      const buf = await getSiteFile(ctx.siteId, path);
      if (buf === null) {
        const files = await listSiteFiles(ctx.siteId);
        // 错误消息也要防膨胀：几千个文件全列出来会把这个 tool 结果撑爆
        const names = files.slice(0, LIST_MAX).map((f) => f.path).join('、');
        const tail = files.length > LIST_MAX ? `……还有 ${files.length - LIST_MAX} 个` : '';
        throw new AgentToolError(
          `没有这个文件：${path}。现有文件：${names || '（空）'}${tail}`,
        );
      }

      const text = buf.toString('utf8');
      const truncated = text.length > READ_MAX_CHARS;
      return {
        path,
        size: buf.length,
        truncated,
        content: truncated
          ? `${text.slice(0, READ_MAX_CHARS)}\n\n…（文件还有 ${text.length - READ_MAX_CHARS} 字符，已截断）`
          : text,
      };
    },
  },

  write_file: {
    description:
      '把某个文件整体覆盖成新内容。传的必须是**完整文件内容**（不是 diff），'
      + '没写到的部分会丢失，所以要么先 read_file 再改，要么确保你自己写全了。'
      + '新建文件也用这个工具。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '站点内相对路径，例如 index.html、assets/css/style.css',
        },
        content: {
          type: 'string',
          description: '完整文件内容（纯文本）。图片等二进制文件不要用这个工具写。',
        },
      },
      required: ['path', 'content'],
    },
    async run(args, ctx) {
      const path = requirePath(args.path);
      const content = requireText(args.content, '文件内容');

      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        throw new AgentToolError(
          `文件太大了，单个文件上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`,
        );
      }

      const isNew = await getSiteFile(ctx.siteId, path) === null;
      if (isNew && await countSiteFiles(ctx.siteId) >= MAX_FILES_PER_SITE) {
        throw new AgentToolError(`站点文件太多啦，上限 ${MAX_FILES_PER_SITE} 个`);
      }

      // 防「照着残缺内容整体覆盖」：原文件明显大于一次能读完的量时拒绝直接改写。
      // 这不是限制能力，是防止无声丢内容 —— read_file 的截断提示模型经常忽略。
      if (!isNew) {
        const old = await getSiteFile(ctx.siteId, path);
        if (old && old.length > LOOSE_WRITE_LIMIT) {
          throw new AgentToolError(
            `${path} 有 ${old.length} 字节，超过一次能读完的量（${READ_MAX_CHARS} 字符），`
            + '整体覆盖会丢掉没读到的部分。请让用户用「代码」面板手动改这个文件，'
            + '或者只改其他小文件。',
          );
        }
      }

      // 存储预算和网页上传、MCP 走同一道闸
      const ownerId = ctx.userId;
      await assertStorageBudget({ get }, {
        ownerId,
        siteId: ctx.siteId,
        replacePath: path,
        incomingBytes: bytes,
      });

      // 版本记录不在这里做：agent 一轮可能写多个文件，应该在整轮结束后
      // 统一记一个版本（见 server.js 的 runAgentTask / commitVersion），
      // 否则一次对话会炸出十几个版本号。
      await upsertSiteFile(ctx.siteId, path, Buffer.from(content, 'utf8'));
      return { ok: true, path, size: bytes, created: isNew };
    },
  },

  delete_file: {
    description:
      '删除当前草稿里的一个文件。这是破坏性操作，只有用户明确说不要这个文件时才用；'
      + '不确定就先问。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的文件路径' },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const path = requirePath(args.path);
      const exists = await getSiteFile(ctx.siteId, path);
      if (exists === null) throw new AgentToolError(`没有这个文件：${path}`);

      const changes = await removeSiteFile(ctx.siteId, path);
      return { ok: true, path, removed: changes > 0 };
    },
  },

  update_meta: {
    description:
      '改草稿的标题 / 简介 / 内容标签。只在用户明确要求改这些时才用，'
      + '不要因为改了页面就顺手改标题。只传要改的字段，没传的保持原样。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `页面标题，最多 ${SITE_TITLE_MAX} 字` },
        description: { type: 'string', description: `页面简介，最多 ${SITE_DESC_MAX} 字` },
        tag: {
          type: 'string',
          description: '内容标签的 key（resume / portfolio / social / blog / event / opensource / docs / other），空串表示不设置',
        },
      },
      required: [],
    },
    async run(args, ctx) {
      const row = await get(
        'SELECT title, description, tag FROM sites WHERE id = ?',
        ctx.siteId,
      );
      if (!row) throw new AgentToolError('草稿不存在');

      const next = {
        title: args.title === undefined ? row.title : String(args.title).trim(),
        description: args.description === undefined ? row.description : String(args.description).trim(),
        tag: args.tag === undefined ? row.tag : String(args.tag).trim(),
      };

      if (next.title.length > SITE_TITLE_MAX) {
        throw new AgentToolError(`标题最多 ${SITE_TITLE_MAX} 字`);
      }
      if (next.description.length > SITE_DESC_MAX) {
        throw new AgentToolError(`简介最多 ${SITE_DESC_MAX} 字`);
      }

      await updateSiteMeta(ctx.siteId, next);
      return { ok: true, ...next };
    },
  },
};

// ---------------------------------------------------------------- 对外接口

/** 工具名集合，给 server 侧做白名单校验用。 */
export const AGENT_TOOL_NAMES = Object.keys(TOOLS);

/**
 * 转成 OpenAI `tools` 数组的形状。
 * 模型接入后可以直接塞进请求体的 tools 字段。
 */
export function toolSchemas() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    type: 'function',
    function: {
      name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** 给前端展示用的工具清单（不含执行逻辑）。 */
export function toolCatalog() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    params: Object.keys(t.parameters.properties ?? {}),
  }));
}

/**
 * 执行一个工具调用。
 *
 * @param {string} name 工具名（已在白名单内）
 * @param {object} args 模型给的参数（可能不合法，由各工具自己校验）
 * @param {{siteId:number, userId:number}} ctx 服务端注入的上下文
 * @returns {Promise<object>} 结构化结果，调用方负责 JSON.stringify 回灌给模型
 */
export async function runAgentTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) {
    throw new AgentToolError(`没有这个工具：${name}。可用工具：${AGENT_TOOL_NAMES.join(', ')}`);
  }
  if (!ctx || !ctx.siteId || !ctx.userId) {
    // 这是服务端接线错误，不是模型能纠正的，所以直接抛普通 Error
    throw new Error('工具调用缺少上下文（siteId / userId）');
  }
  return tool.run(args ?? {}, ctx);
}

export { READ_MAX_CHARS };
