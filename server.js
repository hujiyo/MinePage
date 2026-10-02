import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HOST,
  PORT,
  MAX_HTML_BYTES,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SITE,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  COOKIE_SECURE,
  PASSWORD_MIN,
  SITE_TITLE_MAX,
  SITE_DESC_MAX,
  BIO_MAX,
} from './lib/config.js';
import { checkName } from './lib/names.js';
import { absoluteUrlForSite } from './lib/addressing.js';
import { closeDb } from './lib/db.js';
import { buildCookie, parseCookies, looksLikeEmail, verifyPassword } from './lib/auth.js';
import {
  authenticate,
  changePassword,
  countUsers,
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteOtherSessions,
  deleteSession,
  ensureAdminAccount,
  findSessionUser,
  findUserById,
  findUserByLogin,
  listUsers,
  publicUser,
  setBio,
  setUserStatus,
  setUsername,
  updateUserPassword,
} from './lib/users.js';
import { issueCode, consumeCode } from './lib/verification.js';
import {
  countSiteFiles,
  countSites,
  createSite,
  deleteSite,
  findSiteByName,
  findSiteHeaderByName,
  getSiteFile,
  isValidSitePath,
  isValidSiteTag,
  listAllSites,
  listSiteFiles,
  listSitesByOwner,
  removeSiteFile,
  setSiteStatus,
  siteTagLabel,
  updateSiteHtml,
  updateSiteMeta,
  upsertSiteFile,
  SITE_TAGS,
} from './lib/sites.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

// 用户页面一律关进沙箱。
// 关键：绝不能带 allow-same-origin —— 带上之后页面里的脚本能自己解除沙箱，等于没做。
// 现在平台上有了登录 Cookie，这道墙不再是「保险」而是「必需品」。
const SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
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

function readRawBody(req, limit = MAX_BODY_BYTES) {
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
      resolve(Buffer.concat(chunks));
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

/** 读取原始字节流请求体（文件夹上传用），出错时已经替你回了响应并返回 null。 */
async function readFileBody(req, res, limit) {
  try {
    return await readRawBody(req, limit);
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

async function handleSettingsPage(req, res) {
  if (!currentUser(req)) {
    sendRedirect(res, '/login');
    return;
  }
  await sendPage(res, 'settings.html');
}

async function handleForgotPage(req, res) {
  if (currentUser(req)) {
    sendRedirect(res, '/');
    return;
  }
  await sendPage(res, 'forgot.html');
}

async function handleAccountPage(req, res) {
  if (!currentUser(req)) {
    sendRedirect(res, '/login');
    return;
  }
  await sendPage(res, 'account.html');
}

/** 页面管理页：站点列表 / 访问 / 编辑 / 删除。 */
async function handleSitesPage(req, res) {
  if (!currentUser(req)) {
    sendRedirect(res, '/login');
    return;
  }
  await sendPage(res, 'sites.html');
}

/** 站点管理编辑页（单页编辑 / 多页文件管理，也是未来智能体辅助编辑的挂载点）。 */
async function handleSiteEditPage(req, res) {
  if (!currentUser(req)) {
    sendRedirect(res, '/login');
    return;
  }
  await sendPage(res, 'site.html');
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

// ---------------------------------------------------------------- 验证码与密码

const CODE_PATTERN = /^\d{6}$/;

/**
 * 发验证码。purpose:
 *   register — 注册新邮箱，邮箱不能已被注册
 *   reset    — 找回密码，邮箱不存在时静默不发（回复统一，防探测）
 *   change   — 已登录用户给自己绑定的邮箱发
 */
async function handleSendCode(req, res) {
  const body = await readBody(req, res);
  if (!body) return;

  const purpose = String(body.purpose ?? '');

  if (purpose === 'register' || purpose === 'reset') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      sendJson(res, 400, { ok: false, message: '邮箱格式不对' });
      return;
    }

    if (purpose === 'register') {
      if (findUserByLogin(email)) {
        sendJson(res, 409, { ok: false, message: '这个邮箱已经注册过了' });
        return;
      }
      const result = await issueCode(email, purpose);
      if (!result.ok) {
        sendJson(res, 429, { ok: false, message: result.message });
        return;
      }
      sendJson(res, 200, { ok: true, dev: result.dev });
      return;
    }

    // reset：不管邮箱存不存在，回复都一样，避免被人拿来探测哪些邮箱注册过
    const user = findUserByLogin(email);
    if (user) await issueCode(email, purpose);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (purpose === 'change') {
    const user = requireLogin(req, res);
    if (!user) return;

    const result = await issueCode(user.email, purpose);
    if (!result.ok) {
      sendJson(res, 429, { ok: false, message: result.message });
      return;
    }
    sendJson(res, 200, { ok: true, dev: result.dev });
    return;
  }

  sendJson(res, 400, { ok: false, message: '未知的验证码用途' });
}

/** 注册：现在必须带邮箱验证码。 */
async function handleRegister(req, res) {
  const body = await readBody(req, res);
  if (!body) return;

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const code = String(body.code ?? '').trim();

  if (!looksLikeEmail(email)) {
    sendJson(res, 400, { ok: false, message: '邮箱格式不对' });
    return;
  }
  if (password.length < PASSWORD_MIN) {
    sendJson(res, 400, { ok: false, message: `密码至少 ${PASSWORD_MIN} 位` });
    return;
  }
  if (!CODE_PATTERN.test(code)) {
    sendJson(res, 400, { ok: false, message: '请输入 6 位邮箱验证码' });
    return;
  }
  if (findUserByLogin(email)) {
    sendJson(res, 409, { ok: false, message: '这个邮箱已经注册过了' });
    return;
  }

  const verified = consumeCode(email, 'register', code);
  if (!verified.ok) {
    sendJson(res, 400, { ok: false, message: verified.message });
    return;
  }

  const user = createUser({ email, password });
  const token = createSession(user.id);
  setSessionCookie(res, token, SESSION_TTL_DAYS * 86400);

  sendJson(res, 201, { ok: true, user: publicUser(user) });
}

/** 找回密码第一步：要验证码。邮箱不存在时不报错，防探测。 */
async function handleForgotPassword(req, res) {
  const body = await readBody(req, res);
  if (!body) return;

  const email = String(body.email ?? '').trim().toLowerCase();
  if (!looksLikeEmail(email)) {
    sendJson(res, 400, { ok: false, message: '邮箱格式不对' });
    return;
  }

  if (findUserByLogin(email)) {
    await issueCode(email, 'reset');
  }

  sendJson(res, 200, { ok: true });
}

/** 找回密码第二步：验证码 + 新密码。成功后该用户所有旧会话全部失效。 */
async function handleResetPassword(req, res) {
  const body = await readBody(req, res);
  if (!body) return;

  const email = String(body.email ?? '').trim().toLowerCase();
  const code = String(body.code ?? '').trim();
  const password = String(body.password ?? '');

  if (!looksLikeEmail(email) || !CODE_PATTERN.test(code)) {
    sendJson(res, 400, { ok: false, message: '邮箱或验证码不对' });
    return;
  }
  if (password.length < PASSWORD_MIN) {
    sendJson(res, 400, { ok: false, message: `密码至少 ${PASSWORD_MIN} 位` });
    return;
  }

  const user = findUserByLogin(email);
  if (!user) {
    sendJson(res, 400, { ok: false, message: '验证码不对或已过期' });
    return;
  }

  const verified = consumeCode(email, 'reset', code);
  if (!verified.ok) {
    sendJson(res, 400, { ok: false, message: verified.message });
    return;
  }

  updateUserPassword(user.id, password);
  deleteOtherSessions(user.id);
  sendJson(res, 200, { ok: true });
}

/**
 * 登录用户改密码（设置页）：当前密码 + 邮箱验证码 + 新密码。
 * 成功后踢掉其他设备的会话，保留当前这一个。
 */
async function handleChangePassword(req, res) {
  const session = currentUser(req);
  if (!session) {
    sendJson(res, 401, { ok: false, message: '请先登录' });
    return;
  }

  const body = await readBody(req, res);
  if (!body) return;

  const currentPassword = String(body.currentPassword ?? '');
  const code = String(body.code ?? '').trim();
  const newPassword = String(body.newPassword ?? '');

  if (newPassword.length < PASSWORD_MIN) {
    sendJson(res, 400, { ok: false, message: `新密码至少 ${PASSWORD_MIN} 位` });
    return;
  }
  if (newPassword === currentPassword) {
    sendJson(res, 400, { ok: false, message: '新密码不能和当前密码一样' });
    return;
  }

  const row = findUserById(session.id);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    sendJson(res, 400, { ok: false, message: '当前密码不对' });
    return;
  }

  if (!CODE_PATTERN.test(code)) {
    sendJson(res, 400, { ok: false, message: '请输入 6 位邮箱验证码' });
    return;
  }
  const verified = consumeCode(row.email, 'change', code);
  if (!verified.ok) {
    sendJson(res, 400, { ok: false, message: verified.message });
    return;
  }

  updateUserPassword(row.id, newPassword);
  deleteOtherSessions(row.id, sessionToken(req));
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 账号自助设置接口

async function handleAccountUsername(req, res) {
  const user = requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  try {
    const username = setUsername(user.id, body.username ?? null);
    sendJson(res, 200, { ok: true, username });
  } catch (err) {
    if (err.code === 'BAD_NAME') {
      sendJson(res, 400, { ok: false, message: err.message });
      return;
    }
    if (err.code === 'NAME_TAKEN') {
      sendJson(res, 409, { ok: false, message: err.message });
      return;
    }
    throw err;
  }
}

async function handleAccountPassword(req, res) {
  const user = requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  try {
    changePassword(user.id, body.currentPassword, body.newPassword);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err.code === 'WRONG_PASSWORD' || err.code === 'PASSWORD_TOO_SHORT') {
      sendJson(res, 400, { ok: false, message: err.message });
      return;
    }
    throw err;
  }
}

/** 保存个人简介（个人中心的「想说的话」）。 */
async function handleAccountBio(req, res) {
  const user = requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  try {
    const bio = setBio(user.id, body.bio ?? null);
    sendJson(res, 200, { ok: true, bio });
  } catch (err) {
    if (err.code === 'BIO_TOO_LONG') {
      sendJson(res, 400, { ok: false, message: err.message });
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- 站点接口

async function handleMySites(req, res) {
  const user = requireLogin(req, res);
  if (!user) return;

  const sites = listSitesByOwner(user.id).map((s) => ({
    id: s.id,
    name: s.name,
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

  sendJson(res, 200, { ok: true, sites });
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

// ---------------------------------------------------------------- 站点多文件接口

/** 上传/覆盖站点里的一个文件。站点不存在时自动创建（入口页待补 index.html）。 */
async function handleSiteFileUpload(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const checked = checkName(name);
  if (!checked.ok) {
    sendJson(res, 400, { ok: false, message: checked.reason });
    return;
  }

  const filePath = new URL(req.url, 'http://internal').searchParams.get('path');
  if (!filePath) {
    sendJson(res, 400, { ok: false, message: '缺少 ?path= 参数' });
    return;
  }
  if (!isValidSitePath(filePath)) {
    sendJson(res, 400, { ok: false, message: '文件路径不合法' });
    return;
  }

  let site = findSiteHeaderByName(checked.name);
  if (!site) {
    try {
      createSite({ name: checked.name, html: '', ownerId: user.id });
      site = findSiteHeaderByName(checked.name);
    } catch (err) {
      if (err.code === 'NAME_TAKEN') {
        sendJson(res, 409, { ok: false, message: err.message });
        return;
      }
      console.error('[site-file-upload]', err);
      sendJson(res, 500, { ok: false, message: '服务器出错了，稍后再试' });
      return;
    }
  }
  if (site.owner_id !== user.id && !user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '只能操作自己的站点' });
    return;
  }

  const content = await readFileBody(req, res, MAX_FILE_BYTES);
  if (!content) return;
  if (content.length === 0) {
    sendJson(res, 400, { ok: false, message: '文件内容是空的' });
    return;
  }

  const isNew = getSiteFile(site.id, filePath) === null;
  if (isNew && countSiteFiles(site.id) >= MAX_FILES_PER_SITE) {
    sendJson(res, 409, { ok: false, message: `站点文件太多啦，上限 ${MAX_FILES_PER_SITE} 个` });
    return;
  }

  const saved = upsertSiteFile(site.id, filePath, content);
  sendJson(res, isNew ? 201 : 200, { ok: true, path: saved.path, size: saved.size });
}

/** 列出站点里的全部文件（不含内容）。站点的主人或管理员可看。 */
async function handleSiteFilesList(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const site = findSiteHeaderByName(name);
  if (!site) {
    sendJson(res, 404, { ok: false, message: '没有这个站点' });
    return;
  }
  if (site.owner_id !== user.id && !user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '只能查看自己的站点' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    total: countSiteFiles(site.id),
    files: listSiteFiles(site.id),
  });
}

// ---------------------------------------------------------------- 站点管理接口（个人中心 / 编辑页用）

/** 取一个站点（含 html），归属或管理员才放行；失败时已回响应并返回 null。 */
function ownSiteOrRespond(req, res, user, name) {
  const site = findSiteByName(name);
  if (!site) {
    sendJson(res, 404, { ok: false, message: '没有这个站点' });
    return null;
  }
  if (site.owner_id !== user.id && !user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '只能操作自己的站点' });
    return null;
  }
  return site;
}

/** 站点详情：单页站带 html，多页站带文件数。 */
async function handleSiteDetail(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const site = ownSiteOrRespond(req, res, user, name);
  if (!site) return;

  const fileCount = countSiteFiles(site.id);
  sendJson(res, 200, {
    ok: true,
    site: {
      id: site.id,
      name: site.name,
      status: site.status,
      kind: fileCount > 0 ? 'multi' : 'single',
      fileCount,
      size: site.size,
      html: site.html,
      title: site.title,
      description: site.description,
      tag: site.tag,
      tagLabel: siteTagLabel(site.tag),
      createdAt: site.created_at,
      updatedAt: site.updated_at,
    },
    tags: SITE_TAGS,
  });
}

/** 保存站点元信息（标题 / 简介 / 内容标签，编辑页「站点设置」用）。 */
async function handleSiteSaveMeta(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const site = ownSiteOrRespond(req, res, user, name);
  if (!site) return;

  const body = await readBody(req, res);
  if (!body) return;

  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim();
  const tag = String(body.tag ?? '').trim();

  if (title.length > SITE_TITLE_MAX) {
    sendJson(res, 400, { ok: false, message: `站点标题最多 ${SITE_TITLE_MAX} 字` });
    return;
  }
  if (description.length > SITE_DESC_MAX) {
    sendJson(res, 400, { ok: false, message: `站点简介最多 ${SITE_DESC_MAX} 字` });
    return;
  }
  if (!isValidSiteTag(tag)) {
    sendJson(res, 400, { ok: false, message: '内容标签不对' });
    return;
  }

  updateSiteMeta(site.id, { title, description, tag });
  sendJson(res, 200, { ok: true, title, description, tag, tagLabel: siteTagLabel(tag) });
}

/** 保存单页站的 HTML（编辑页的「保存」按钮）。 */
async function handleSiteSaveHtml(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const site = ownSiteOrRespond(req, res, user, name);
  if (!site) return;

  if (countSiteFiles(site.id) > 0) {
    sendJson(res, 400, {
      ok: false,
      message: '这是多页站点，请到下方文件列表里编辑单个文件',
    });
    return;
  }

  const body = await readBody(req, res);
  if (!body) return;

  const html = String(body.html ?? '');
  if (html.trim() === '') {
    sendJson(res, 400, { ok: false, message: '内容是空的' });
    return;
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    sendJson(res, 413, { ok: false, message: '文件太大了，单个文件上限 2 MB' });
    return;
  }

  const size = updateSiteHtml(site.id, html);
  sendJson(res, 200, { ok: true, size });
}

/** 删除整个站点（site_files 由外键级联清掉）。 */
async function handleSiteDelete(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const site = ownSiteOrRespond(req, res, user, name);
  if (!site) return;

  deleteSite(site.id);
  sendJson(res, 200, { ok: true });
}

/** 取一个站点文件的内容（文本文件才能在编辑页里编辑）。 */
async function handleSiteFileContent(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const site = ownSiteOrRespond(req, res, user, name);
  if (!site) return;

  const filePath = new URL(req.url, 'http://internal').searchParams.get('path');
  if (!filePath || !isValidSitePath(filePath)) {
    sendJson(res, 400, { ok: false, message: '文件路径不合法' });
    return;
  }

  const content = getSiteFile(site.id, filePath);
  if (!content) {
    sendJson(res, 404, { ok: false, message: '站点里没有这个文件' });
    return;
  }

  // 能无损转回 UTF-8 就当文本，否则标记 binary（前端只读、不允许编辑）
  const text = content.toString('utf8');
  const binary = content.includes(0) || !Buffer.from(text, 'utf8').equals(content);

  sendJson(res, 200, {
    ok: true,
    path: filePath,
    size: content.length,
    binary,
    content: binary ? content.toString('base64') : text,
  });
}

/** 删除站点里的一个文件。 */
async function handleSiteFileDelete(req, res, [name]) {
  const user = requireLogin(req, res);
  if (!user) return;

  const site = ownSiteOrRespond(req, res, user, name);
  if (!site) return;

  const filePath = new URL(req.url, 'http://internal').searchParams.get('path');
  if (!filePath || !isValidSitePath(filePath)) {
    sendJson(res, 400, { ok: false, message: '文件路径不合法' });
    return;
  }

  const changes = removeSiteFile(site.id, filePath);
  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '站点里没有这个文件' });
    return;
  }

  sendJson(res, 200, { ok: true });
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

function serveSiteFile(res, filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  // html / svg / xml 都是可以带脚本的文档类型，必须一起关进沙箱
  const isDoc = ext === '.html' || ext === '.htm' || ext === '.svg' || ext === '.xml';

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    ...(isDoc ? { 'Content-Security-Policy': SANDBOX_CSP } : {}),
  });
  res.end(content);
}

function handleSite(req, res, [name, rest = '']) {
  const site = findSiteHeaderByName(name);

  if (!site) {
    sendHtml(res, 404, messagePage('404', `没有找到 "${name}" 这个页面。`));
    return;
  }
  if (site.status !== 'active') {
    sendHtml(res, 451, messagePage('已下线', '这个页面已被管理员下线。'));
    return;
  }

  // /站点名 和 /站点名/ 都算入口页；其余去掉开头的 / 得到站点内路径
  const filePath = !rest || rest === '/' ? 'index.html' : rest.slice(1);

  const content = getSiteFile(site.id, filePath);
  if (content) {
    serveSiteFile(res, filePath, content);
    return;
  }

  // 老的「单 HTML 文件」站点：内容存在 sites.html 里，只兜入口页
  if (filePath === 'index.html') {
    const legacy = findSiteByName(name);
    if (legacy && legacy.html && legacy.html.trim() !== '') {
      sendHtml(res, 200, legacy.html, {
        'Content-Security-Policy': SANDBOX_CSP,
        'Cache-Control': 'no-cache',
      });
      return;
    }
  }

  sendHtml(res, 404, messagePage('404', `站点里没有这个文件：${filePath}`));
}

// ---------------------------------------------------------------- 路由表

const ROUTES = [
  ['GET', /^\/$/, handleRoot],
  ['GET', /^\/login$/, handleLoginPage],
  ['GET', /^\/account$/, handleAccountPage],
  ['GET', /^\/sites$/, handleSitesPage],
  ['GET', /^\/edit\/([a-z0-9-]+)$/, handleSiteEditPage],
  ['GET', /^\/admin$/, handleAdminPage],
  ['GET', /^\/settings$/, handleSettingsPage],
  ['GET', /^\/forgot$/, handleForgotPage],
  ['GET', /^\/_assets\/([a-zA-Z0-9._-]+)$/, handleAsset],

  ['GET', /^\/api\/me$/, handleMe],
  ['POST', /^\/api\/auth\/register$/, handleRegister],
  ['POST', /^\/api\/auth\/login$/, handleLogin],
  ['POST', /^\/api\/auth\/logout$/, handleLogout],
  ['POST', /^\/api\/auth\/send-code$/, handleSendCode],
  ['POST', /^\/api\/auth\/password$/, handleChangePassword],
  ['POST', /^\/api\/auth\/forgot-password$/, handleForgotPassword],
  ['POST', /^\/api\/auth\/reset-password$/, handleResetPassword],

  ['POST', /^\/api\/account\/username$/, handleAccountUsername],
  ['POST', /^\/api\/account\/password$/, handleAccountPassword],
  ['POST', /^\/api\/account\/bio$/, handleAccountBio],

  ['GET', /^\/api\/sites$/, handleMySites],
  ['POST', /^\/api\/upload$/, handleUpload],
  ['GET', /^\/api\/sites\/([a-z0-9-]+)$/, handleSiteDetail],
  ['PUT', /^\/api\/sites\/([a-z0-9-]+)$/, handleSiteSaveHtml],
  ['PUT', /^\/api\/sites\/([a-z0-9-]+)\/meta$/, handleSiteSaveMeta],
  ['DELETE', /^\/api\/sites\/([a-z0-9-]+)$/, handleSiteDelete],
  ['GET', /^\/api\/sites\/([a-z0-9-]+)\/files$/, handleSiteFilesList],
  ['POST', /^\/api\/sites\/([a-z0-9-]+)\/files$/, handleSiteFileUpload],
  ['GET', /^\/api\/sites\/([a-z0-9-]+)\/files\/content$/, handleSiteFileContent],
  ['DELETE', /^\/api\/sites\/([a-z0-9-]+)\/files$/, handleSiteFileDelete],

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
  // /站点名 或 /站点名/任意/相对/路径.css
  if (req.method === 'GET') {
    const m = pathname.match(/^\/([a-z0-9-]+)(\/.*)?$/);
    if (m) {
      handleSite(req, res, [m[1], m[2] ?? '']);
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
