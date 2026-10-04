import {
  MAX_HTML_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SITE,
  MCP_READ_MAX_BYTES,
  SITE_TITLE_MAX,
  SITE_DESC_MAX,
} from '../config.js';
import { checkName } from '../names.js';
import { absoluteUrlForSite } from '../addressing.js';
import {
  countSiteFiles,
  createSite,
  deleteSite,
  findSiteByName,
  findSiteHeaderByName,
  getSiteFile,
  isValidSitePath,
  isValidSiteTag,
  listSiteFiles,
  listSitesByOwner,
  removeSiteFile,
  siteTagLabel,
  updateSiteHtml,
  updateSiteMeta,
  upsertSiteFile,
  SITE_TAGS,
} from '../sites.js';

/**
 * MCP 工具注册表——**唯一真源**：tools/list 由它渲染，tools/call 按名字路由。
 * 加一个工具 = 加一个描述符，协议层（server.js）不用动。
 *
 * backend 直接调 lib/sites.js，不绕自己的 HTTP 接口：MCP 和网页在同一个进程里，
 * 多走一趟 socket 只会多一处出错的地方。所有校验也复用同一批函数
 * （checkName / isValidSitePath / 各种上限），MCP 不另写一套。
 *
 * 权限口径：严格 owner_id === ctx.userId。管理员的密钥也不例外 ——
 * 想封人、下线别人的页面，还是回 /admin 网页做。
 */

/** 工具级错误：message 会被原样显示在用户的对话里，所以用中文写人话。 */
export class McpToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpToolError';
  }
}

// ---------------------------------------------------------------- 公共片段

const NAME_RULE = '站名只能是 3-32 位小写字母、数字和连字符，不能以连字符开头或结尾。';
const SANDBOX_NOTE =
  '用户的页面会被平台的沙箱 CSP 隔离，脚本里拿不到平台登录态、也没有 localStorage 可用，这是平台硬性安全策略，不要试图绕过。';

const SITE_LOOKUP_RULE =
  `站点分两种：单页站（内容存在 sites.html，用 update_site_html 改）和` +
  `多页站（内容是一组文件，入口页必须是 index.html，用 write_file / delete_file 管）。` +
  `先 list_sites 或 get_site 确认名字和类型，再动手。`;

/** 取自己的站点。不存在或不是自己的都抛工具级错误。 */
function requireOwnSite(userId, rawName, { withHtml = false } = {}) {
  const checked = checkName(rawName);
  if (!checked.ok) throw new McpToolError(checked.reason);

  const site = withHtml ? findSiteByName(checked.name) : findSiteHeaderByName(checked.name);
  if (!site) throw new McpToolError(`没有找到 "${checked.name}" 这个站点`);
  if (site.owner_id !== userId) {
    throw new McpToolError(`"${checked.name}" 不是你自己的站点，只能操作自己的页面`);
  }
  return site;
}

function requireName(raw) {
  const checked = checkName(raw);
  if (!checked.ok) throw new McpToolError(checked.reason);
  return checked.name;
}

function requirePath(raw) {
  const value = String(raw ?? '');
  if (!isValidSitePath(value)) {
    throw new McpToolError(
      '文件路径不合法：不能以 / 开头、不能含反斜杠，每段只能用字母数字和 . _ -，且不能用 . 或 ..',
    );
  }
  return value;
}

function requireHtml(raw) {
  const html = String(raw ?? '');
  if (html.trim() === '') throw new McpToolError('HTML 内容是空的');
  const size = Buffer.byteLength(html, 'utf8');
  if (size > MAX_HTML_BYTES) {
    throw new McpToolError(`内容太大了，单个 HTML 上限 ${Math.round(MAX_HTML_BYTES / 1024 / 1024)} MB`);
  }
  return html;
}

function siteUrl(origin, name) {
  return absoluteUrlForSite(origin, name);
}

function fileRow(row) {
  return { path: row.path, size: row.size, updatedAt: row.updated_at };
}

// ---------------------------------------------------------------- 输出 Schema

/**
 * 结构化输出的 JSON Schema。
 *
 * 客户端会强制校验 structuredContent，而各家客户端只支持一个很窄的子集
 * （type / oneOf / properties / required / additionalProperties / items / enum /
 * const / description；不含 $ref / anyOf / allOf / minimum）。
 * 所以：顶层只列「两条路径都必然出现」的键当 required，嵌套对象一律留成
 * { type: 'object', additionalProperties: true }，让客户端别去逐字段挑刺。
 */
const SITE_OBJECT = { additionalProperties: true, type: 'object' };

function output({ required, properties }) {
  return { additionalProperties: true, properties, required, type: 'object' };
}

function annotations({ destructive = false, idempotent = true, readOnly = false }) {
  return { destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false, readOnlyHint: readOnly };
}

// ---------------------------------------------------------------- 读工具

const LIST_SITES = {
  annotations: annotations({ readOnly: true }),
  description: [
    '列出当前密钥账户名下的所有站点，返回每个站点的名字、访问地址、标题、简介、内容标签、状态、',
    '文件数量与更新时间。',
    `这是所有站点操作的入口：操作某个站点之前先用它（或 get_site）确认站名。${NAME_RULE}`,
    SITE_LOOKUP_RULE,
  ].join(''),
  inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
  name: 'list_sites',
  outputSchema: output({
    properties: {
      count: { type: 'integer' },
      sites: { items: SITE_OBJECT, type: 'array' },
    },
    required: ['count', 'sites'],
  }),
  title: '列出我的站点',
  async run(ctx) {
    const sites = listSitesByOwner(ctx.userId).map((s) => ({
      name: s.name,
      url: siteUrl(ctx.origin, s.name),
      title: s.title,
      description: s.description,
      tag: s.tag,
      tagLabel: siteTagLabel(s.tag),
      status: s.status,
      kind: s.file_count > 0 ? 'multi' : 'single',
      fileCount: s.file_count,
      totalSize: s.size + s.files_size,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }));
    return { count: sites.length, sites };
  },
};

const GET_SITE = {
  annotations: annotations({ readOnly: true }),
  description: [
    '查看单个站点的完整信息。',
    '单页站会直接带上 html 全文；多页站返回文件清单（不含内容，读内容用 read_file）。',
    '返回的 kind 字段是 single / multi，决定接下来该用 update_site_html 还是 write_file。',
  ].join(''),
  inputSchema: {
    additionalProperties: false,
    properties: { name: { description: '站名', type: 'string' } },
    required: ['name'],
    type: 'object',
  },
  name: 'get_site',
  outputSchema: output({
    properties: {
      files: { items: SITE_OBJECT, type: 'array' },
      site: SITE_OBJECT,
    },
    required: ['files', 'site'],
  }),
  title: '查看站点详情',
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name, { withHtml: true });
    const files = listSiteFiles(site.id).map(fileRow);
    const kind = files.length > 0 ? 'multi' : 'single';

    return {
      files,
      site: {
        name: site.name,
        url: siteUrl(ctx.origin, site.name),
        status: site.status,
        kind,
        fileCount: files.length,
        htmlSize: site.size,
        // 单页站才有 html；多页站是 null，免得 AI 把过期的单页内容当成真内容
        html: kind === 'single' ? site.html : null,
        title: site.title,
        description: site.description,
        tag: site.tag,
        tagLabel: siteTagLabel(site.tag),
        createdAt: site.created_at,
        updatedAt: site.updated_at,
      },
    };
  },
};

const LIST_FILES = {
  annotations: annotations({ readOnly: true }),
  description:
    '列出多页站点里的所有文件（路径、大小、更新时间，不含内容）。单页站会返回空列表。读具体内容用 read_file。',
  inputSchema: {
    additionalProperties: false,
    properties: { name: { description: '站名', type: 'string' } },
    required: ['name'],
    type: 'object',
  },
  name: 'list_files',
  outputSchema: output({
    properties: {
      files: { items: SITE_OBJECT, type: 'array' },
      name: { type: 'string' },
      total: { type: 'integer' },
    },
    required: ['files', 'name', 'total'],
  }),
  title: '列出站点文件',
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name);
    const files = listSiteFiles(site.id).map(fileRow);
    return { files, name: site.name, total: files.length };
  },
};

const READ_FILE = {
  annotations: annotations({ readOnly: true }),
  description: [
    '读取站点里单个文件的内容。',
    '文本文件直接返回原文（binary=false）；二进制文件（图片、字体等）返回 base64（binary=true）。',
    `超过 ${Math.round(MCP_READ_MAX_BYTES / 1024)} KB 的文件会被拒绝——那么大的内容塞进对话也没有意义，`,
    '请让用户到网页的编辑页里看，或者直接用站点地址在浏览器里打开。',
  ].join(''),
  inputSchema: {
    additionalProperties: false,
    properties: {
      name: { description: '站名', type: 'string' },
      path: { description: '站点内相对路径，如 index.html 或 assets/app.js', type: 'string' },
    },
    required: ['name', 'path'],
    type: 'object',
  },
  name: 'read_file',
  outputSchema: output({
    properties: {
      binary: { type: 'boolean' },
      content: { type: 'string' },
      name: { type: 'string' },
      path: { type: 'string' },
      size: { type: 'integer' },
    },
    required: ['binary', 'content', 'name', 'path', 'size'],
  }),
  title: '读取站点文件',
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name);
    const filePath = requirePath(args.path);

    const content = getSiteFile(site.id, filePath);
    if (!content) throw new McpToolError(`站点里没有这个文件：${filePath}`);

    if (content.length > MCP_READ_MAX_BYTES) {
      throw new McpToolError(
        `文件太大（${content.length} 字节，上限 ${MCP_READ_MAX_BYTES}），不在这里返回内容`,
      );
    }

    const text = content.toString('utf8');
    const binary = content.includes(0) || !Buffer.from(text, 'utf8').equals(content);

    return {
      binary,
      content: binary ? content.toString('base64') : text,
      name: site.name,
      path: filePath,
      size: content.length,
    };
  },
};

// ---------------------------------------------------------------- 写工具

const CREATE_SITE = {
  annotations: annotations({ idempotent: false }),
  description: [
    '新建一个单页站点：给一个名字 + 一份完整 HTML，立刻可以通过 域名/名字 访问。',
    'CSS 和 JS 请内嵌在 HTML 里，或者改用多页站（write_file 传 index.html、style.css 等）。',
    `名字已被占用时会直接报错，不会覆盖别人的内容；想改已有站点用 update_site_html。${NAME_RULE}${SANDBOX_NOTE}`,
  ].join(''),
  inputSchema: {
    additionalProperties: false,
    properties: {
      html: { description: '完整的 HTML 文档内容（含 <!DOCTYPE html>）', type: 'string' },
      name: { description: '站名，决定访问地址 域名/名字', type: 'string' },
    },
    required: ['name', 'html'],
    type: 'object',
  },
  name: 'create_site',
  outputSchema: output({
    properties: {
      name: { type: 'string' },
      size: { type: 'integer' },
      url: { type: 'string' },
    },
    required: ['name', 'size', 'url'],
  }),
  title: '新建站点',
  async run(ctx, args) {
    const name = requireName(args.name);
    const html = requireHtml(args.html);

    try {
      const site = createSite({ name, html, ownerId: ctx.userId });
      return { name: site.name, size: site.size, url: siteUrl(ctx.origin, site.name) };
    } catch (err) {
      if (err.code === 'NAME_TAKEN') {
        throw new McpToolError(`"${name}" 这个名字已经被占用了，换一个`);
      }
      throw err;
    }
  },
};

const UPDATE_SITE_HTML = {
  annotations: annotations({ destructive: true }),
  description: [
    '整体替换一个**单页站**的 HTML。',
    '只对单页站有效：如果这个站点已经有文件（多页站），会报错，请改用 write_file 改具体文件。',
    '传进来的 html 会完全覆盖旧内容，不是合并。',
  ].join(''),
  inputSchema: {
    additionalProperties: false,
    properties: {
      html: { description: '新的完整 HTML 文档内容', type: 'string' },
      name: { description: '站名', type: 'string' },
    },
    required: ['name', 'html'],
    type: 'object',
  },
  name: 'update_site_html',
  outputSchema: output({
    properties: {
      name: { type: 'string' },
      size: { type: 'integer' },
      url: { type: 'string' },
    },
    required: ['name', 'size', 'url'],
  }),
  title: '替换单页站 HTML',
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name, { withHtml: true });
    const html = requireHtml(args.html);

    if (countSiteFiles(site.id) > 0) {
      throw new McpToolError(
        `"${site.name}" 是多页站点，改内容请用 write_file（入口页是 index.html），不要整体替换`,
      );
    }

    const size = updateSiteHtml(site.id, html);
    return { name: site.name, size, url: siteUrl(ctx.origin, site.name) };
  },
};

const UPDATE_SITE_META = {
  annotations: annotations({}),
  description: [
    '更新站点的元信息：标题（网页列表里显示）、简介、内容标签。',
    '只传你要改的字段，没传的保持原样；传空字符串表示清空。',
    `标签可选值：${SITE_TAGS.map((t) => `${t.key}(${t.label})`).join('、')}，空串表示不设置。`,
    '这个工具不影响页面内容，改内容用 update_site_html 或 write_file。',
  ].join(''),
  inputSchema: {
    additionalProperties: false,
    properties: {
      description: { description: `站点简介，最多 ${SITE_DESC_MAX} 字`, type: 'string' },
      name: { description: '站名', type: 'string' },
      tag: {
        description: '内容标签 key，空串表示不设置',
        enum: ['', ...SITE_TAGS.map((t) => t.key)],
        type: 'string',
      },
      title: { description: `站点标题，最多 ${SITE_TITLE_MAX} 字`, type: 'string' },
    },
    required: ['name'],
    type: 'object',
  },
  name: 'update_site_meta',
  outputSchema: output({
    properties: {
      description: { type: 'string' },
      name: { type: 'string' },
      tag: { type: 'string' },
      tagLabel: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['description', 'name', 'tag', 'tagLabel', 'title'],
  }),
  title: '更新站点信息',
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name, { withHtml: true });

    const title = Object.hasOwn(args, 'title') ? String(args.title ?? '').trim() : site.title;
    const description = Object.hasOwn(args, 'description')
      ? String(args.description ?? '').trim()
      : site.description;
    const tag = Object.hasOwn(args, 'tag') ? String(args.tag ?? '').trim() : site.tag;

    if (title.length > SITE_TITLE_MAX) {
      throw new McpToolError(`站点标题最多 ${SITE_TITLE_MAX} 字`);
    }
    if (description.length > SITE_DESC_MAX) {
      throw new McpToolError(`站点简介最多 ${SITE_DESC_MAX} 字`);
    }
    if (!isValidSiteTag(tag)) {
      throw new McpToolError(
        `内容标签不对，只能是：${SITE_TAGS.map((t) => t.key).join(' / ')}，或空串`,
      );
    }

    updateSiteMeta(site.id, { title, description, tag });
    return { description, name: site.name, tag, tagLabel: siteTagLabel(tag), title };
  },
};

const WRITE_FILE = {
  annotations: annotations({ destructive: true }),
  description: [
    '在站点里新建或覆盖一个文件，用来做多页站（HTML 子页、CSS、JS、图片、字体…）。',
    '站点还不存在时会自动创建；入口页必须叫 index.html，否则访问 域名/名字 还是 404。',
    '同名文件会被直接覆盖。content 默认按 UTF-8 文本写入；写图片等二进制内容时把 encoding 设成 base64。',
    `单个文件上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB，单站最多 ${MAX_FILES_PER_SITE} 个文件。${SANDBOX_NOTE}`,
  ].join(''),
  inputSchema: {
    additionalProperties: false,
    properties: {
      content: { description: '文件内容；encoding 为 utf8 时是原文，为 base64 时是 base64 字符串', type: 'string' },
      encoding: {
        default: 'utf8',
        description: 'content 的编码，默认 utf8；二进制文件用 base64',
        enum: ['utf8', 'base64'],
        type: 'string',
      },
      name: { description: '站名', type: 'string' },
      path: { description: '站点内相对路径，如 index.html、assets/app.js', type: 'string' },
    },
    required: ['name', 'path', 'content'],
    type: 'object',
  },
  name: 'write_file',
  outputSchema: output({
    properties: {
      fileCreated: { type: 'boolean' },
      name: { type: 'string' },
      path: { type: 'string' },
      siteCreated: { type: 'boolean' },
      size: { type: 'integer' },
      url: { type: 'string' },
    },
    required: ['fileCreated', 'name', 'path', 'siteCreated', 'size', 'url'],
  }),
  title: '写入站点文件',
  async run(ctx, args) {
    const name = requireName(args.name);
    const filePath = requirePath(args.path);
    const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
    const raw = String(args.content ?? '');

    let content;
    if (encoding === 'base64') {
      const compact = raw.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
        throw new McpToolError('encoding 是 base64，但 content 里有 base64 不认识的字符');
      }
      content = Buffer.from(compact, 'base64');
    } else {
      content = Buffer.from(raw, 'utf8');
    }

    if (content.length === 0) throw new McpToolError('文件内容是空的');
    if (content.length > MAX_FILE_BYTES) {
      throw new McpToolError(`文件太大了，单个文件上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
    }

    let site = findSiteHeaderByName(name);
    let siteCreated = false;
    if (!site) {
      try {
        createSite({ name, html: '', ownerId: ctx.userId });
      } catch (err) {
        if (err.code === 'NAME_TAKEN') {
          throw new McpToolError(`"${name}" 这个名字已经被占用了`);
        }
        throw err;
      }
      site = findSiteHeaderByName(name);
      siteCreated = true;
    }
    if (site.owner_id !== ctx.userId) {
      throw new McpToolError(`"${name}" 不是你自己的站点，只能操作自己的页面`);
    }

    const fileCreated = getSiteFile(site.id, filePath) === null;
    if (fileCreated && countSiteFiles(site.id) >= MAX_FILES_PER_SITE) {
      throw new McpToolError(`站点文件太多啦，上限 ${MAX_FILES_PER_SITE} 个`);
    }

    const saved = upsertSiteFile(site.id, filePath, content);
    return {
      fileCreated,
      name: site.name,
      path: saved.path,
      siteCreated,
      size: saved.size,
      url: siteUrl(ctx.origin, site.name),
    };
  },
};

const DELETE_FILE = {
  annotations: annotations({ destructive: true }),
  description: '删除站点里的一个文件。删掉 index.html 后访问 域名/名字 会变成 404，但站点本身还在。',
  inputSchema: {
    additionalProperties: false,
    properties: {
      name: { description: '站名', type: 'string' },
      path: { description: '要删的文件路径', type: 'string' },
    },
    required: ['name', 'path'],
    type: 'object',
  },
  name: 'delete_file',
  outputSchema: output({
    properties: {
      deleted: { type: 'boolean' },
      name: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['deleted', 'name', 'path'],
  }),
  title: '删除站点文件',
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name);
    const filePath = requirePath(args.path);

    const changes = removeSiteFile(site.id, filePath);
    if (changes === 0) throw new McpToolError(`站点里没有这个文件：${filePath}`);

    return { deleted: true, name: site.name, path: filePath };
  },
};

const DELETE_SITE = {
  annotations: annotations({ destructive: true }),
  description:
    '删除整个站点，连同它的全部文件。不可撤销，站名会被释放、之后可以被任何人重新注册。删之前先用 get_site 确认这就是用户想删的那个。',
  inputSchema: {
    additionalProperties: false,
    properties: { name: { description: '站名', type: 'string' } },
    required: ['name'],
    type: 'object',
  },
  name: 'delete_site',
  outputSchema: output({
    properties: {
      deleted: { type: 'boolean' },
      name: { type: 'string' },
    },
    required: ['deleted', 'name'],
  }),
  title: '删除站点',
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name);
    deleteSite(site.id);
    return { deleted: true, name: site.name };
  },
};

// ---------------------------------------------------------------- 注册表

export const MCP_TOOLS = [
  LIST_SITES,
  GET_SITE,
  LIST_FILES,
  READ_FILE,
  CREATE_SITE,
  UPDATE_SITE_HTML,
  UPDATE_SITE_META,
  WRITE_FILE,
  DELETE_FILE,
  DELETE_SITE,
];

export function findTool(name) {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** tools/list 的载荷。annotations 与 schema 一起给，客户端才知道哪些是只读的。 */
export function toolDescriptors() {
  return MCP_TOOLS.map((tool) => ({
    annotations: tool.annotations,
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
    outputSchema: tool.outputSchema,
    title: tool.title,
  }));
}

/** 给 initialize 的 instructions：把「怎么用这套工具」一次讲清楚。 */
export const MCP_INSTRUCTIONS = [
  'MinePage 是一个极简的 HTML 页面托管平台，用户上传单个 HTML 就得到一个 域名/名字 的地址。',
  '这套工具让用户不打开网页就能建站、改内容、管文件——所有操作都作用在密钥主人自己的账号下。',
  '典型动线：list_sites 看现有站点 → get_site 看某个站点的类型和内容 → create_site 建单页站，',
  '或者 write_file 写 index.html 等文件做多页站 → update_site_meta 补标题和简介。',
  SITE_LOOKUP_RULE,
  NAME_RULE,
  SANDBOX_NOTE,
  '动手之前先确认用户的意图：delete_site 和 delete_file 不可撤销，update_site_html 会整体覆盖旧内容。',
  '工具报错时会返回中文原因（isError），照着原因调整参数重试，不要把错误原样丢给用户。',
].join('');
