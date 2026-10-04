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

/**
 * 校验并规范化站名，返回 checkName 给的 name（去空格、转小写）。
 * 陷阱：规范化后的名字可能和入参不一样，后续查询和落库都必须用返回值，不要再用 args.name。
 */
function requireName(raw) {
  const checked = checkName(raw);
  if (!checked.ok) throw new McpToolError(checked.reason);
  return checked.name;
}

/**
 * 校验站点内相对路径，原样返回，不做任何规范化。
 * 路径区分大小写：写的时候用什么，读和删就得用什么。非法路径抛工具级错误。
 */
function requirePath(raw) {
  const value = String(raw ?? '');
  if (!isValidSitePath(value)) {
    throw new McpToolError(
      '文件路径不合法：不能以 / 开头、不能含反斜杠，每段只能用字母数字和 . _ -，且不能用 . 或 ..',
    );
  }
  return value;
}

/**
 * 校验单页 HTML：不能是空白，且不超过 MAX_HTML_BYTES。
 * 返回原字符串（不 trim），所以首尾空白会原样存进 sites.html。
 */
function requireHtml(raw) {
  const html = String(raw ?? '');
  if (html.trim() === '') throw new McpToolError('HTML 内容是空的');
  const size = Buffer.byteLength(html, 'utf8');
  if (size > MAX_HTML_BYTES) {
    throw new McpToolError(`内容太大了，单个 HTML 上限 ${Math.round(MAX_HTML_BYTES / 1024 / 1024)} MB`);
  }
  return html;
}

/** 把站名拼成给用户看的绝对地址。地址形态只由 lib/addressing.js 决定，这里不自己拼字符串。 */
function siteUrl(origin, name) {
  return absoluteUrlForSite(origin, name);
}

/** 文件行 → 对外字段：只挑 path / size / updatedAt，行里其它列（比如 content）不会漏出去。 */
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

/** 拼一个 outputSchema：顶层 required 由工具自己给全，额外字段一律放行，省得客户端逐字段挑刺。 */
function output({ required, properties }) {
  return { additionalProperties: true, properties, required, type: 'object' };
}

/**
 * 组装 MCP 的 annotations 提示，客户端据此决定要不要先找用户确认。
 *
 * 默认 idempotent=true、readOnly 与 destructive 都是 false：读工具显式传 readOnly，
 * 会覆盖或删数据的工具传 destructive，重复执行结果不同的（create_site）再把 idempotent 关掉。
 * openWorldHint 固定 false —— 这十个工具只动本平台库里的数据，不访问外部世界。
 */
function annotations({ destructive = false, idempotent = true, readOnly = false }) {
  return { destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false, readOnlyHint: readOnly };
}

// ---------------------------------------------------------------- 读工具

/**
 * list_sites：列出密钥主人名下的全部站点（名字、地址、标题、简介、标签、状态、文件数、时间）。
 *
 * 参数：无。
 * 返回 { count, sites[] }：kind 由 file_count 推出来（有文件 = multi），
 * totalSize 是「单页 HTML 字节数 + 所有文件字节数」之和。
 * 归属：listSitesByOwner 的 SQL 自带 WHERE owner_id = ctx.userId，
 * 这里没有「先查出来再判断」的窗口，别人的站点根本不会进结果集。
 */
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
  /** 列表查询不带 html（几 MB 的大字段不进内存），文件数与文件总大小由 SQL 的聚合列直接给出。 */
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

/**
 * get_site：看单个站点的完整信息，单页站直接带 html 全文，多页站带文件清单。
 *
 * 参数：name。
 * 返回 { site, files[] }：site.kind 是 single / multi，决定之后该用 update_site_html
 * 还是 write_file；多页站的 site.html 恒为 null，免得 AI 把库里遗留的单页内容当成真内容。
 * 归属：requireOwnSite 显式比 owner_id === ctx.userId，不是自己的站直接抛工具级错误。
 */
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
  /** 取详情要带 html（withHtml: true 走 findSiteByName），多页站那一段在返回前主动抹成 null。 */
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

/**
 * list_files：列出多页站里的文件（路径、大小、更新时间，不含内容）。
 *
 * 参数：name。
 * 返回 { name, total, files[] }；单页站没有 site_files 行，返回空列表而不是报错。
 * 归属：requireOwnSite。
 */
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
  /** 单页站在 site_files 里天然查不到行，所以这里不用按站点类型分支。 */
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name);
    const files = listSiteFiles(site.id).map(fileRow);
    return { files, name: site.name, total: files.length };
  },
};

/**
 * read_file：读站点里单个文件的内容。
 *
 * 参数：name、path。
 * 返回 { name, path, size, binary, content }：binary 只是 content 的编码标记，
 * false = UTF-8 原文，true = base64；size 始终是真实字节数，不是编码后的长度。
 * 超过 MCP_READ_MAX_BYTES 直接报错、不截断——截断的 HTML 会让 AI 以为文件就只有这么长。
 * 归属：requireOwnSite。
 */
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
  /** getSiteFile 返回 null 才表示路径不存在（空文件是 truthy 的 Buffer），存在之后再判体积拒绝超限。 */
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

/**
 * create_site：用一个名字 + 一份完整 HTML 建单页站。
 *
 * 参数：name、html（完整文档，上限 MAX_HTML_BYTES）。
 * 返回 { name, size, url }，size 是 HTML 的 UTF-8 字节数。
 * 归属：ownerId 直接取 ctx.userId，没有「传别人的 id」这个入口；
 * 重名时 createSite 抛 NAME_TAKEN，这里翻成中文工具错误，绝不覆盖已有站点。
 */
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
  /** 站名和体积都先本地校验（不查库），重名留给 createSite 的 UNIQUE 约束兜底。 */
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

/**
 * update_site_html：整体替换**单页站**的 HTML，是覆盖不是合并。
 *
 * 参数：name、html。
 * 返回 { name, size, url }，size 是新内容的字节数。
 * 只对单页站有效：站点已经有文件（countSiteFiles > 0）就报错，要求改用 write_file。
 * 归属：requireOwnSite。
 */
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
  /** 用「站点有没有文件」判多页站，多页站直接拒绝，然后再整体覆盖 sites.html。 */
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

/**
 * update_site_meta：改站点的标题 / 简介 / 内容标签，不碰页面内容。
 *
 * 参数：name，外加 title / description / tag 的任意子集；没传的字段保持原值，
 * 传空串表示清空（用 Object.hasOwn 区分这两者，所以传 null 会按空串处理）。
 * 返回 { name, title, description, tag, tagLabel }，tagLabel 是标签的中文名。
 * 归属：requireOwnSite。
 *
 * 注意：lib/sites.js 的 updateSiteMeta 不写 updated_at（它只承担「内容更新时间」的语义），
 * 所以只改标题 / 简介 / 标签，不会让站点在 list_sites 的排序（按 updated_at DESC）里冒头。
 */
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
  /** 三个字段先和现有值合并，再统一判长度与标签合法性；任何一项不过就一个字段都不写。 */
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

/**
 * write_file：在站点里新建或覆盖一个文件，多页站的唯一写入通道。
 *
 * 参数：name、path、content、encoding（'utf8' 默认 / 'base64'；base64 会先去掉空白再解码）。
 * 返回 { name, path, size, siteCreated, fileCreated }：siteCreated 表示这次顺手把站点建了出来，
 * fileCreated 表示该路径原本不存在（覆盖已有文件时为 false）。
 * 归属：站点不存在就用 ownerId = ctx.userId 建一个；已存在则显式比 owner_id，
 * 不是自己的直接拒绝——两条路都把写入锁死在密钥主人身上。
 * MAX_FILES_PER_SITE 只拦新文件，覆盖老文件不受它限制。
 */
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
  /** 顺序是「校验内容 → 没站就建站 → 比归属 → 卡文件数 → upsert」，所以被文件数上限拒掉时站点可能已经建出来了。 */
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

/**
 * delete_file：删掉站点里的一个文件，站点本身保留。
 *
 * 参数：name、path。
 * 返回 { deleted: true, name, path }；文件本来就不存在时报工具级错误，不会静默成功。
 * 删掉 index.html 后 域名/名字 变 404；文件全删光时站点会退回 kind = 'single'，
 * 那时内容取 sites.html（自动建出来的多页站里它是空串）。
 * 归属：requireOwnSite。
 */
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
  /** 以 DELETE 的影响行数判成败：0 行就是「没有这个文件」。 */
  async run(ctx, args) {
    const site = requireOwnSite(ctx.userId, args.name);
    const filePath = requirePath(args.path);

    const changes = removeSiteFile(site.id, filePath);
    if (changes === 0) throw new McpToolError(`站点里没有这个文件：${filePath}`);

    return { deleted: true, name: site.name, path: filePath };
  },
};

/**
 * delete_site：删除整个站点，不可撤销。
 *
 * 参数：name。
 * 返回 { deleted: true, name }；站点不存在时报工具级错误。
 * 归属：requireOwnSite。
 * 连带影响：site_files 以及挂在这个 site_id 上的点赞、评论、收藏、浏览历史都由外键
 * CASCADE 一起删掉（见 lib/db.js）；站名随之释放，任何人都能立刻重新注册同名站点。
 */
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
  /** 没有回收站也不做二次确认：认准站点后直接删行，连带删多少由库里的 CASCADE 决定。 */
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

/** 按名字找工具，tools/call 的路由表；找不到返回 null（由 server.js 翻成 -32602），不抛错。 */
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
