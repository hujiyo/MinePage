# MinePage MCP 设计（2026-10-02）

## 目标

让用户把自己的 AI 客户端（Claude Code / Cursor / 豆包…）接到 MinePage，
之后**只靠对话**就能建站、改内容、管文件，不必再打开网页操作。

网页仍然要做两件事：注册登录、创建/吊销 MCP 密钥。

## 形态

**远程 Streamable HTTP MCP，挂在现有 `server.js` 上。**

- `POST /mcp` —— 标准接入点，密钥走 `Authorization: Bearer <key>`
- `POST /mcp/<key>` —— 给不能自定义请求头的客户端（纯 URL 接入）兜底
- `?key=<key>` 同样可用

不引 MCP SDK：只用协议最小子集（`initialize` / `tools/list` / `tools/call` /
`ping`），单条消息、无会话、无 SSE 上行，手写 JSON-RPC 分发约 150 行，
**零新依赖**。（沿用 emate 的结论：等需要 sampling / elicitation 时再评估 SDK。）

## 鉴权

- 密钥格式 `mp_mcp_<32 字节 base64url>`，**库里只存 sha256**，明文只在创建响应里出现一次。
- 表 `mcp_tokens`，与其余表同在 `data/minepage.db`；吊销 = 删行。
- 每账户最多 10 把有效密钥。
- 每次调用校验：密钥存在 + 用户 `status === 'active'`（封禁用户手里的密钥立刻失效）。
- `last_used_at` 节流落盘：距上次记录超过 60 秒才写，避免每次调用都写库。
- 密钥即凭证，权限**等同于网页登录**（但只限页面管理，不含改密码等账号操作）。

## 工具集

10 个工具，全部**只作用于密钥主人自己的站点**（严格 `owner_id === user.id`，
管理员密钥也不例外，管理能力仍然只能在 `/admin` 网页用）。

| 工具 | 对应网页能力 | 破坏性 |
| --- | --- | --- |
| `list_sites` | 站点列表 | 否 |
| `get_site` | 站点详情（单页站含 HTML） | 否 |
| `create_site` | 上传单页 | 是 |
| `update_site_html` | 改单页 HTML | 是 |
| `update_site_meta` | 改标题/简介/标签 | 是 |
| `delete_site` | 删站 | 是 |
| `list_files` | 多页站文件清单 | 否 |
| `read_file` | 读单个文件（文本直出 / 二进制 base64） | 否 |
| `write_file` | 上传或覆盖文件（站点不存在则建） | 是 |
| `delete_file` | 删文件 | 是 |

不做点数额度体系（课程项目，YAGNI）。

## 代码结构

```
lib/db.js            + mcp_tokens 表
lib/config.js        + MCP_TOKEN_PREFIX / MCP_TOKENS_PER_USER / MCP_BODY_BYTES
lib/mcp/tokens.js    密钥存储：铸造 / 列表 / 吊销 / 鉴权
lib/mcp/tools.js     工具注册表（唯一真源）+ 10 个 backend
lib/mcp/server.js    JSON-RPC 分发 + handleMcpRequest
server.js            + /mcp、/mcp/:key、/api/mcp/tokens 路由
public/settings.html + 密钥管理 UI
```

**backend 直接调 `lib/sites.js`**，不绕自己的 HTTP 接口（同进程）。所有校验
复用现有函数：`checkName` / `isValidSitePath` / `isValidSiteTag` /
`MAX_HTML_BYTES` / `MAX_FILE_BYTES` / `MAX_FILES_PER_SITE`，MCP 不另写一套。

## 错误约定

沿用 emate 的分工：

- **协议级错误**（JSON-RPC error）用英文 —— 面向接入调试者，会落在客户端日志里。
- **工具级错误**（`isError: true` 的 content）用中文 —— 会原样显示在用户的对话里。
- 工具级错误正常返回 `result`（HTTP 仍 200），不是 JSON-RPC error，这样 AI 能读到原因。

## 接入方式

```
claude mcp add --transport http minepage http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer mp_mcp_xxx"
```

或不能配请求头的客户端直接填 `http://127.0.0.1:3000/mcp/mp_mcp_xxx`。

## 风险与取舍

- 密钥明文只显示一次，丢了只能重建。
- `/mcp/<key>` 会把密钥写进浏览器/代理日志，是便利换安全；标准做法仍是 Authorization 头。
- 站名 `mcp` 加入保留字，避免和路由撞车。
- 上传内容仍然被沙箱 CSP 关着（`sandbox`，无 `allow-same-origin`），MCP 只是换了
  写入通道，不改变用户页面的隔离级别。
