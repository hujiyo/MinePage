#!/usr/bin/env node
/**
 * 从现有代码里抽出「接口契约」，供换语言重写后端时照着实现。
 *
 * 思路：前端已经写好了、84 条测试也跑过了 —— 所以**前端就是规格**。
 * 重写的目标不是"重想业务"，而是"实现同一份契约，让前端一行都不用改"。
 *
 * 三个方向对齐：
 *   1. 路由：从 server.js 的 ROUTES 表拿（方法 / 路径 / 鉴权 / handler）
 *   2. 响应字段：从 handler 里的 sendJson(res, code, {...}) 顶层键提取
 *   3. 调用方：从 public/*.html 与 app.js 里找谁在调这个路径
 *
 * 用法：
 *   node tests/scripts/api-contract.mjs            # 打到标准输出
 *   node tests/scripts/api-contract.mjs --out x.md
 *   node tests/scripts/api-contract.mjs --json x.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const serverLines = server.split(/\r?\n/);

// ---------------------------------------------------------------- 1. 路由与鉴权

function authOf(handler) {
  const start = serverLines.findIndex((l) => new RegExp(`^(?:async\\s+)?function\\s+${handler}\\b`).test(l));
  if (start < 0) return '?';
  let end = serverLines.length;
  for (let i = start + 1; i < serverLines.length; i++) {
    if (/^(?:async\s+)?function\s+\w+/.test(serverLines[i]) || /^\s{0,2}const ROUTES/.test(serverLines[i])) { end = i; break; }
  }
  const body = serverLines.slice(start, end).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const readsUser = /currentUser\(req\)/.test(body);
  const rejects = /requireLogin\(/.test(body) || /sendRedirect\(res,\s*'\/login'\)/.test(body) || /sendJson\(res,\s*401/.test(body);
  if (AUTH_OVERRIDES[handler]) return AUTH_OVERRIDES[handler];
  if (/handleMcp\(req,\s*res/.test(body)) return '密钥';
  if (/requireAdmin\(/.test(body) || /sendHtml\(res,\s*403/.test(body)) return '管理员';
  if (/ownSiteOrRespond/.test(body)) return '登录+属主';
  if (/requireLogin\(/.test(body) || (readsUser && rejects)) return '登录';
  if (readsUser) return '公开(读登录态)';
  return '公开';
}
const AUTH_OVERRIDES = { handleSendCode: '公开/登录' };

const routes = [];
for (const m of server.matchAll(/\['(GET|POST|PUT|DELETE)',\s*(\/\^[\s\S]*?\/),\s*([A-Za-z_$][\w$]*)\]/g)) {
  const raw = m[2].slice(1, m[2].lastIndexOf('/'));
  routes.push({ method: m[1], raw, handler: m[3], auth: authOf(m[3]) });
}

function pathOf(raw) {
  return raw.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/')
    .replace(/\(\[a-z0-9-\]\+\)/g, ':名字').replace(/\(\[a-zA-Z0-9\._-\]\+\)/g, ':文件')
    .replace(/\(\[A-Za-z0-9_-\]\+\)/g, ':key').replace(/\(\\d\+\)/g, ':id')
    .replace(/\(\\\/\.\*\)\?/g, '/*').replace(/\([^)]*\)/g, ':参数');
}

// ---------------------------------------------------------------- 2. 响应字段

function handlerBody(handler) {
  const start = serverLines.findIndex((l) => new RegExp(`^(?:async\\s+)?function\\s+${handler}\\b`).test(l));
  if (start < 0) return '';
  let end = serverLines.length;
  for (let i = start + 1; i < serverLines.length; i++) {
    if (/^(?:async\s+)?function\s+\w+/.test(serverLines[i]) || /^\s{0,2}const ROUTES/.test(serverLines[i])) { end = i; break; }
  }
  return serverLines.slice(start, end).join('\n');
}

/** 从 sendJson(res, 2xx, { ... }) 里抠出顶层键 */
function responseKeys(handler) {
  const body = handlerBody(handler);
  const keys = new Set();
  for (const m of body.matchAll(/sendJson\(res,\s*2\d\d,\s*\{([\s\S]{0,600}?)\}\s*\)/g)) {
    const inner = m[1];
    // 顶层键：行首（或 { 后）的 identifier:
    for (const k of inner.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g)) keys.add(k[1]);
    // 简写属性 { ok, user } 这种
    for (const k of inner.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) keys.add(k[1]);
  }
  return [...keys];
}

/** 从 handler 里找请求体字段：body.xxx / body['xxx'] */
function requestKeys(handler) {
  const body = handlerBody(handler);
  const keys = new Set();
  for (const m of body.matchAll(/\bbody\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
  for (const m of body.matchAll(/\bbody\[['"]([A-Za-z_$][\w$]*)['"]\]/g)) keys.add(m[1]);
  return [...keys];
}

// ---------------------------------------------------------------- 3. 调用方

const pageSources = [];
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
  if (!/\.(html|js)$/.test(f)) continue;
  pageSources.push({ file: `public/${f}`, src: fs.readFileSync(path.join(ROOT, 'public', f), 'utf8') });
}

/**
 * 从前端源码里抠出**实际发起请求时用的 URL 字面量**。
 *
 * 为什么不用「拿路由去反查页面」：那样对带参数的路径只能做前缀匹配，
 * 会把 /api/sites/:名字/meta 这种也塞给只调 /api/sites/:名字/files 的页面，
 * 得到一张"看起来有、其实是猜的"表 —— 错的契约比没有更糟。
 *
 * 反过来从调用点抠字面量是准的：`fetch('/api/sites/' + name + '/meta')`
 * 抠出来就是 `/api/sites/`，虽然丢了后缀，但至少不是编的。
 */
function callSites(pageSrc) {
  // 去掉整行注释，避免把 TODO 里的示例当成真调用
  const code = pageSrc.replace(/^\s*\/\/.*$/gm, '');
  const found = new Set();
  for (const m of code.matchAll(/\b(?:fetch|post|api|apiUrl)\s*\(\s*[`'"]([^`'"\s]*)/g)) {
    const u = m[1];
    if (u.startsWith('/api') || u.startsWith('/mcp')) found.add(u);
  }
  // 模板串里的 ${...} 之后可能还有静态后缀，如 `/api/mcp/tokens/${id}/revoke`
  for (const m of code.matchAll(/[`'"](\/api\/[^`'"]*)[`'"]/g)) {
    if (m[1].includes('/')) found.add(m[1]);
  }
  return [...found];
}

const pageCallSites = pageSources
  .map((p) => ({ page: path.basename(p.file), urls: callSites(p.src) }))
  .filter((p) => p.urls.length)
  .sort((a, b) => b.urls.length - a.urls.length);

// ---------------------------------------------------------------- 输出

// 注意：raw 是正则源码，开头有个 ^（例如 "^\\/api\\/discover$"），
// 所以不能拿 raw.startsWith('\\/api') 去判 —— 要先转成可读路径再判。
const apiRoutes = routes
  .map((r) => ({ ...r, path: pathOf(r.raw) }))
  .filter((r) => r.path.startsWith('/api') || r.path.startsWith('/mcp'));

const rows = apiRoutes.map((r) => ({
  method: r.method,
  path: r.path,
  auth: r.auth,
  handler: r.handler,
  reqKeys: requestKeys(r.handler),
  resKeys: responseKeys(r.handler),
}));

const out = [];
out.push('# 后端重写契约（从前端与现有代码抽出）');
out.push('');
out.push('> 目的：换语言重写后端时，**让现有 15 个页面一行都不用改**。');
out.push('> 所以契约不是"应该是什么"，而是"现在是什么"。');
out.push('> 由 `tests/scripts/api-contract.mjs` 生成，改动路由后重新生成。');
out.push('');
out.push(`接口共 **${rows.length}** 条。`);
out.push('');
out.push('列的含义：');
out.push('');
out.push('- **鉴权**：`公开` / `公开(读登录态)` / `登录` / `登录+属主` / `管理员` / `密钥` / `公开/登录`（按参数分）');
out.push('- **请求字段**：从 handler 里 `body.xxx` 抠出来的');
out.push('- **响应顶层键**：从 `sendJson(res, 2xx, {...})` 抠出来的（**前端读的就是这些**）');
out.push('');
out.push('> ⚠️ 这里**没有「哪个页面在调」这一列**。试过，不准：带参数的路径在前端是拼出来的');
out.push('> （`\'/api/sites/\' + name + \'/meta\'`），拿路由反查只能做前缀匹配，会把');
out.push('> 页面根本没用的接口也算进去。需要调用方请看下面第二节（从调用点抠的，可信）。');
out.push('');
out.push('| 方法 | 路径 | 鉴权 | 请求字段 | 响应顶层键 | 处理函数 |');
out.push('|---|---|---|---|---|---|');
for (const r of rows) {
  const f = (a) => (a.length ? a.join(', ') : '—');
  out.push(`| ${r.method} | \`${r.path}\` | ${r.auth} | ${f(r.reqKeys)} | ${f(r.resKeys)} | \`${r.handler}\` |`);
}
out.push('');
out.push('## 前端实际在调什么（从 `fetch(...)` 的 URL 字面量抠的，可信）');
out.push('');
out.push('带参数的请求前端是拼字符串，所以抠出来的是**前缀**。');
out.push('比如 `fetch(\'/api/sites/\' + name + \'/meta\')` 抠出 `/api/sites/`。');
out.push('');
out.push('| 页面 | 调用的 URL 字面量 |');
out.push('|---|---|');
for (const p of pageCallSites) out.push(`| \`${p.page}\` | ${p.urls.map((u) => '`' + u + '`').join(' · ')} |`);
out.push('');
out.push('**没有任何 API 调用的页面**（＝纯演示页，重写后端时不影响它们）：');
out.push('');
const noCall = fs.readdirSync(path.join(ROOT, 'public'))
  .filter((f) => f.endsWith('.html'))
  .filter((f) => !pageCallSites.some((p) => p.page === f));
for (const f of noCall) out.push(`- \`${f}\``);
out.push('');
out.push('## 处理函数清单（重写时逐个对照）');
out.push('');
out.push(`共 ${rows.length} 个接口处理函数。`);

const md = out.join('\n');

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag > -1 && process.argv[jsonFlag + 1]) {
  fs.writeFileSync(path.resolve(ROOT, process.argv[jsonFlag + 1]), JSON.stringify(rows, null, 2), 'utf8');
}
const outFlag = process.argv.indexOf('--out');
if (outFlag > -1 && process.argv[outFlag + 1]) {
  const t = path.resolve(ROOT, process.argv[outFlag + 1]);
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, md, 'utf8');
  console.log(`已写入 ${path.relative(ROOT, t)}（${rows.length} 条接口）`);
} else {
  console.log(md);
}
