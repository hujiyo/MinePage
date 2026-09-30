import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HOST,
  PORT,
  MAX_HTML_BYTES,
  MAX_BODY_BYTES,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  COOKIE_SECURE,
  PASSWORD_MIN,
} from './lib/config.js';
import { checkName } from './lib/names.js';
import { absoluteUrlForSite, siteNameFromRequest } from './lib/addressing.js';
import { closeDb } from './lib/db.js';
import { buildCookie, parseCookies, looksLikeEmail } from './lib/auth.js';
import {
  authenticate,
  countUsers,
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  ensureAdminAccount,
  findSessionUser,
  findUserByLogin,
  listUsers,
  publicUser,
  setUserStatus,
} from './lib/users.js';
import {
  countSites,
  createSite,
  deleteSite,
  findSiteByName,
  listAllSites,
  listSitesByOwner,
  setSiteStatus,
} from './lib/sites.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

// 用户页面一律关进沙箱。
// 关键：绝不能带 allow-same-origin —— 带上之后页面里的脚本能自己解除沙箱，等于没做。
// 现在平台上有了登录 Cookie，这道墙不再是「保险」而是「必需品」。
const SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- 基础工具

function originOf(req) {
  return `http://${req.headers.host ?? `${HOST}:${PORT}`}`;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

async function sendPage(res, filename, status = 200) {
  try {
    const html = await fs.readFile(path.join(PUBLIC_DIR, filename), 'utf8');
    sendHtml(res, status, html, { 'Cache-Control': 'no-store' });
  } catch {
    sendHtml(res, 500, messagePage('页面文件缺失', '服务器上找不到这个页面。'));
  }
}

function setSessionCookie(res, token, maxAge) {
  res.setHeader(
    'Set-Cookie',
    buildCookie(SESSION_COOKIE, token, { maxAge, secure: COOKIE_SECURE }),
  );
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

/** 取当前登录用户。封禁中的账号按未登录处理。 */
function currentUser(req) {
  const row = findSessionUser(sessionToken(req));
  if (!row) return null;
  if (row.status !== 'active') return null;
  return publicUser(row);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error('内容太大了'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求格式不对'), { code: 'BAD_JSON' }));
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** 读取并解析 JSON 请求体，出错时已经替你回了响应并返回 null。 */
async function readBody(req, res) {
  try {
    return await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.code === 'TOO_LARGE' ? 413 : 400, { ok: false, message: err.message });
    return null;
  }
}

function requireLogin(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, message: '请先登录' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireLogin(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '需要管理员权限' });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------- 页面路由

async function handleRoot(req, res) {
  await sendPage(res, 'index.html');
}

async function handleLoginPage(req, res) {
  if (currentUser(req)) {
    sendRedirect(res, '/');
    return;
  }
  await sendPage(res, 'login.html');
}

async function handleAdminPage(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendRedirect(res, '/login');
    return;
  }
  if (!user.isAdmin) {
    sendHtml(res, 403, messagePage('没有权限', '这个页面只有管理员能看。'));
    return;
  }
  await sendPage(res, 'admin.html');
}

async function handleAsset(req, res, [file]) {
  // 只放行单层文件名，杜绝 ../ 之类的穿越
  if (!/^[a-zA-Z0-9._-]+$/.test(file) || file.includes('..')) {
    sendHtml(res, 404, messagePage('404', '找不到这个文件。'));
    return;
  }

  try {
    const data = await fs.readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendHtml(res, 404, messagePage('404', '找不到这个文件。'));
  }
}

// ---------------------------------------------------------------- 账号接口

async function handleMe(req, res) {
  sendJson(res, 200, { ok: true, user: currentUser(req) });
}

async function handleRegister(req, res) {
  const body = await readBody(req, res);
  if (!body) return;

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  if (!looksLikeEmail(email)) {
    sendJson(res, 400, { ok: false, message: '邮箱格式不对' });
    return;
  }
  if (password.length < PASSWORD_MIN) {
    sendJson(res, 400, { ok: false, message: `密码至少 ${PASSWORD_MIN} 位` });
    return;
  }
  if (findUserByLogin(email)) {
    sendJson(res, 409, { ok: false, message: '这个邮箱已经注册过了' });
    return;
  }

  const user = createUser({ email, password });
  const token = createSession(user.id);
  setSessionCookie(res, token, SESSION_TTL_DAYS * 86400);

  sendJson(res, 201, { ok: true, user: publicUser(user) });
}

async function handleLogin(req, res) {
  const body = await readBody(req, res);
  if (!body) return;

  const user = authenticate(String(body.login ?? '').trim(), String(body.password ?? ''));

  if (!user) {
    sendJson(res, 401, { ok: false, message: '账号或密码不对' });
    return;
  }
  if (user.status !== 'active') {
    sendJson(res, 403, { ok: false, message: '这个账号已被封禁' });
    return;
  }

  const token = createSession(user.id);
  setSessionCookie(res, token, SESSION_TTL_DAYS * 86400);

  sendJson(res, 200, { ok: true, user: publicUser(user) });
}

async function handleLogout(req, res) {
  deleteSession(sessionToken(req));
  setSessionCookie(res, '', 0);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 站点接口

async function handleMySites(req, res) {
  const user = requireLogin(req, res);
  if (!user) return;

  sendJson(res, 200, { ok: true, sites: listSitesByOwner(user.id) });
}

async function handleUpload(req, res) {
  const user = requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const checked = checkName(body.name);
  if (!checked.ok) {
    sendJson(res, 400, { ok: false, message: checked.reason });
    return;
  }

  const html = body.html;
  if (typeof html !== 'string' || html.trim() === '') {
    sendJson(res, 400, { ok: false, message: '没有拿到文件内容' });
    return;
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    sendJson(res, 413, { ok: false, message: '文件太大了，单个文件上限 2 MB' });
    return;
  }

  try {
    const site = createSite({ name: checked.name, html, ownerId: user.id });
    sendJson(res, 201, {
      ok: true,
      name: site.name,
      size: site.size,
      url: absoluteUrlForSite(originOf(req), site.name),
    });
  } catch (err) {
    if (err.code === 'NAME_TAKEN') {
      sendJson(res, 409, { ok: false, message: err.message });
      return;
    }
    console.error('[upload]', err);
    sendJson(res, 500, { ok: false, message: '服务器出错了，稍后再试' });
  }
}

// ---------------------------------------------------------------- 管理接口

async function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;

  sendJson(res, 200, {
    ok: true,
    total: countUsers(),
    users: listUsers().map(publicUser),
  });
}

async function handleAdminUserStatus(req, res, [id]) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const targetId = Number(id);
  if (targetId === admin.id) {
    sendJson(res, 400, { ok: false, message: '不能封禁自己' });
    return;
  }

  const body = await readBody(req, res);
  if (!body) return;

  const status = body.status === 'banned' ? 'banned' : 'active';
  const changes = setUserStatus(targetId, status);

  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }

  sendJson(res, 200, { ok: true, id: targetId, status });
}

async function handleAdminSites(req, res) {
  if (!requireAdmin(req, res)) return;

  sendJson(res, 200, {
    ok: true,
    total: countSites(),
    sites: listAllSites(),
  });
}

async function handleAdminSiteStatus(req, res, [id]) {
  if (!requireAdmin(req, res)) return;

  const body = await readBody(req, res);
  if (!body) return;

  const status = body.status === 'offline' ? 'offline' : 'active';
  const changes = setSiteStatus(Number(id), status);

  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个页面' });
    return;
  }

  sendJson(res, 200, { ok: true, id: Number(id), status });
}

async function handleAdminDeleteSite(req, res, [id]) {
  if (!requireAdmin(req, res)) return;

  const changes = deleteSite(Number(id));
  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个页面' });
    return;
  }

  sendJson(res, 200, { ok: true, id: Number(id) });
}

// ---------------------------------------------------------------- 用户站点

function handleSite(req, res, [name]) {
  const site = findSiteByName(name);

  if (!site) {
    sendHtml(res, 404, messagePage('404', `没有找到 "${name}" 这个页面。`));
    return;
  }
  if (site.status !== 'active') {
    sendHtml(res, 451, messagePage('已下线', '这个页面已被管理员下线。'));
    return;
  }

  sendHtml(res, 200, site.html, {
    'Content-Security-Policy': SANDBOX_CSP,
    'Cache-Control': 'no-cache',
  });
}

// ---------------------------------------------------------------- 路由表

const ROUTES = [
  ['GET', /^\/$/, handleRoot],
  ['GET', /^\/login$/, handleLoginPage],
  ['GET', /^\/admin$/, handleAdminPage],
  ['GET', /^\/_assets\/([a-zA-Z0-9._-]+)$/, handleAsset],

  ['GET', /^\/api\/me$/, handleMe],
  ['POST', /^\/api\/auth\/register$/, handleRegister],
  ['POST', /^\/api\/auth\/login$/, handleLogin],
  ['POST', /^\/api\/auth\/logout$/, handleLogout],

  ['GET', /^\/api\/sites$/, handleMySites],
  ['POST', /^\/api\/upload$/, handleUpload],

  ['GET', /^\/api\/admin\/users$/, handleAdminUsers],
  ['POST', /^\/api\/admin\/users\/(\d+)\/status$/, handleAdminUserStatus],
  ['GET', /^\/api\/admin\/sites$/, handleAdminSites],
  ['POST', /^\/api\/admin\/sites\/(\d+)\/status$/, handleAdminSiteStatus],
  ['DELETE', /^\/api\/admin\/sites\/(\d+)$/, handleAdminDeleteSite],
];

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://internal');

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  for (const [method, pattern, handler] of ROUTES) {
    if (req.method !== method) continue;

    const match = pathname.match(pattern);
    if (match) {
      await handler(req, res, match.slice(1));
      return;
    }
  }

  // 平台自己的路由都没命中，最后才考虑用户站点
  if (req.method === 'GET') {
    const name = siteNameFromRequest(req);
    if (name) {
      handleSite(req, res, [name]);
      return;
    }
  }

  sendHtml(res, 404, messagePage('404', '这里什么都没有。'));
}

// ---------------------------------------------------------------- 通用页面

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function messagePage(title, message) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · MinePage</title>
<link rel="stylesheet" href="/_assets/style.css">
</head>
<body>
  <main class="narrow center">
    <h1>${escapeHtml(title)}</h1>
    <p class="muted">${escapeHtml(message)}</p>
    <p><a href="/">回到首页</a></p>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------- 启动

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[error]', err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, message: '服务器出错了' });
    } else {
      res.end();
    }
  });
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  const removed = deleteExpiredSessions();
  if (removed > 0) console.log(`清理了 ${removed} 条过期会话`);

  const created = ensureAdminAccount();

  console.log(`\nMinePage 跑起来了 → http://${HOST}:${PORT}`);

  if (created) {
    console.log(`
┌──────────────────────────────────────────────┐
   已创建默认管理员账号（只在数据库为空时创建一次）

   用户名   ${created.username}
   密码     ${created.password}
   邮箱     ${created.email}

   ! 这是开发用的默认密码，上线前必须改掉。
   登录地址 http://${HOST}:${PORT}/login
└──────────────────────────────────────────────┘`);
  }
});
