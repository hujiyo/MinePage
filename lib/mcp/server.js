import { MCP_BODY_BYTES, MCP_TOKEN_PREFIX } from '../config.js';
import { authenticateMcpToken } from './tokens.js';
import { MCP_INSTRUCTIONS, McpToolError, findTool, toolDescriptors } from './tools.js';

/**
 * MinePage MCP 服务端（Streamable HTTP，无状态，JSON 响应模式）。
 *
 * 不引 MCP SDK：只用协议的最小子集（initialize / ping / tools/list / tools/call，
 * 单条消息、无会话、无 SSE 上行），手写 JSON-RPC 分发就是下面这一百多行。
 * 好处是零新依赖、没有 SDK 大版本锁定；代价是 sampling / elicitation / tasks
 * 这些进阶能力暂时用不了——真需要时再评估引 SDK。
 *
 * 鉴权：Authorization: Bearer mp_mcp_...（或 ?key= / 路径段，见 extractToken）。
 * 错误语言分工：协议级错误用英文（面向接入调试者，会进客户端日志），
 * 工具级错误用中文（会被原样显示在终端用户的对话里）。
 */

export const MCP_SERVER_NAME = 'minepage-mcp';
export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

/** 这三通道取密钥：Authorization 头 > ?key= > /mcp/<key> 路径段。 */
export function extractToken(req, pathKey = '') {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) {
    const header = auth.slice(7).trim();
    if (header) return header;
  }

  const query = new URL(req.url, 'http://internal').searchParams.get('key');
  if (query && query.startsWith(MCP_TOKEN_PREFIX)) return query.trim();

  return pathKey.startsWith(MCP_TOKEN_PREFIX) ? pathKey : '';
}

/**
 * 把整个请求体读完再 JSON.parse（不做流式解析——MCP 的消息都不大）。
 *
 * 超过 MCP_BODY_BYTES 就 reject（code='TOO_LARGE'）并 destroy 请求流；
 * JSON 语法错误 reject（code='BAD_JSON'）。调用方按 code 决定回 413 还是 400。
 * settled 标志保证 data / end / error 三条路径只有一个能结算，后面的回调直接丢弃。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MCP_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('请求体太大'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }));
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * 统一的 JSON 响应出口：自己算 Content-Length，并明确 no-store。
 * MCP 的响应都是「这一刻的身份 + 这一刻的数据」，被任何一层缓存住都会串账号。
 * 只写一次（writeHead + end），调用方之后不要再往 res 上写东西。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 组装 JSON-RPC 错误响应。
 * id 缺失时补 null 而不是省略字段，这是规范要求，也方便客户端把错误对回到请求。
 * 这里是**协议级**错误（英文 message，面向接入调试者）；工具级错误走下面的 toolError。
 */
function jsonRpcError(id, code, message) {
  return { error: { code, message }, id: id ?? null, jsonrpc: '2.0' };
}

/** 工具级错误：HTTP 仍然 200，错误写在 result 里，这样 AI 能读到原因并自己纠正。 */
function toolError(id, message) {
  return { id, jsonrpc: '2.0', result: { content: [{ text: message, type: 'text' }], isError: true } };
}

/**
 * 版本协商：客户端报的 protocolVersion 在支持列表里就原样回（必须回显一致，客户端才认），
 * 否则回本文件默认的 MCP_PROTOCOL_VERSION，由客户端决定接不接受。
 * 不做「降级到最接近的旧版本」：没报版本、或报了个不认识的，都按最新版本处理。
 */
function negotiateProtocolVersion(params) {
  const requested = params?.protocolVersion;
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

// ---------------------------------------------------------------- JSON-RPC 分发
//
// 支持的方法就是下面 switch 里那几个：initialize / ping / tools/list / tools/call，
// 外加两条只当通知吞掉的 notifications/initialized、notifications/cancelled。
// 其余方法一律回 -32601，不假装支持（sampling / elicitation / tasks 都还没做）。
//
// 与登录态无关：本文件不读 Cookie、不查 sessions 表，身份只有一个来源——
// 密钥换来的 { tokenId, userId }。密钥的创建/吊销走另一条要登录态的网页 API
// （/api/mcp/tokens），两条路互不相交。

/**
 * 处理一条 JSON-RPC 消息。返回 null 表示这是通知（notification），
 * 调用方应当回 202 空响应。
 */
async function dispatch(message, ctx) {
  const { id, method, params } = message;
  const hasId = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      if (!hasId) return null;
      return {
        id,
        jsonrpc: '2.0',
        result: {
          capabilities: { tools: { listChanged: false } },
          instructions: MCP_INSTRUCTIONS,
          protocolVersion: negotiateProtocolVersion(params),
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      };

    case 'ping':
      return hasId ? { id, jsonrpc: '2.0', result: {} } : null;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'tools/list':
      if (!hasId) return null;
      return { id, jsonrpc: '2.0', result: { tools: toolDescriptors() } };

    case 'tools/call': {
      if (!hasId) return null;

      const name = params?.name;
      const tool = findTool(name);
      if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${String(name)}`);

      try {
        const data = await tool.run(ctx, params?.arguments ?? {});
        return {
          id,
          jsonrpc: '2.0',
          result: {
            // content 与 structuredContent 必须同源：客户端会拿 outputSchema 校验
            // structuredContent，两者对不上就会被判成非法结果。
            content: [{ text: JSON.stringify(data), type: 'text' }],
            structuredContent: data,
          },
        };
      } catch (err) {
        if (err instanceof McpToolError) {
          console.log(`[mcp] ${tool.name} 被拒：${err.message}`);
          return toolError(id, err.message);
        }
        console.error(`[mcp] ${tool.name} 出错`, err);
        return toolError(id, '服务器出错了，稍后再试');
      }
    }

    default:
      return jsonRpcError(hasId ? id : null, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------- HTTP 入口
//
// 只接 POST（GET 之类由 server.js 的路由表挡成 405），一次一条消息：批量数组直接回 -32600。
// 状态码约定：
//   401 —— 密钥缺失、无效，或账号已被封（带 WWW-Authenticate: Bearer）
//   413 / 400 —— 请求体超限 / 不是合法 JSON、不是单个 JSON-RPC 消息
//   202 —— 通知类消息，空 body
//   200 —— 有 id 的请求，body 是 JSON-RPC 响应；**工具级错误也是 200**，错误写在 result 里
//
// ctx.origin 由 Host 头拼出来（固定 http://），工具返回的 url 字段就是它加上站名。

/**
 * MCP 的 HTTP 入口。server.js 只负责把请求路由到这里，协议细节全在本文件内。
 */
export async function handleMcp(req, res, pathKey = '') {
  const rawToken = extractToken(req, pathKey);
  const identity = rawToken ? authenticateMcpToken(rawToken) : null;

  if (!identity) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="minepage-mcp"');
    sendJson(res, 401, jsonRpcError(null, -32001, 'Invalid or missing MCP token'));
    return;
  }

  let message;
  try {
    message = await readBody(req);
  } catch (err) {
    sendJson(res, err.code === 'TOO_LARGE' ? 413 : 400, jsonRpcError(null, -32700, err.message));
    return;
  }

  if (Array.isArray(message)) {
    sendJson(res, 400, jsonRpcError(null, -32600, 'Batch requests are not supported; send one message per POST'));
    return;
  }
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
    sendJson(res, 400, jsonRpcError(null, -32600, 'Request body must be a single JSON-RPC message'));
    return;
  }

  const ctx = { origin: `http://${req.headers.host ?? 'localhost'}`, userId: identity.userId };
  const result = await dispatch(message, ctx);

  if (result === null) {
    // 通知（含 notifications/initialized）按规范回 202 + 空 body
    res.writeHead(202);
    res.end();
    return;
  }

  // 有 id 的请求必须 200 + JSON body；回 202 会让客户端以为「已接受但没响应」
  sendJson(res, 200, result);
}
