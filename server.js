import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HOST,
  PORT,
  MAX_DRAFTS_PER_USER,
  MAX_HTML_BYTES,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SITE,
  MAX_SITE_TOTAL_BYTES,
  MAX_ZIP_BYTES,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  COOKIE_SECURE,
  PASSWORD_MIN,
  SITE_TITLE_MAX,
  SITE_DESC_MAX,
  SITE_MESSAGE_MAX,
  SITE_MESSAGES_KEEP,
  BIO_MAX,
  COMMENT_MAX,
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_DATABASE,
  USER_SPACE_PREFIX,
  MAX_SITES_PER_USER,
} from './lib/config.js';
import { checkName, checkUsername } from './lib/names.js';
import { absoluteUrlForSite, urlForSite, urlForView } from './lib/addressing.js';
import { closeDb } from './lib/db.js';
import { buildCookie, parseCookies, looksLikeEmail, verifyPassword } from './lib/auth.js';
import {
  authenticate,
  changePassword,
  countUsers,
  createSession,
  createUser,
  deleteAccount,
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
import { handleMcp } from './lib/mcp/server.js';
import { createMcpToken, listMcpTokens, revokeMcpToken } from './lib/mcp/tokens.js';
import {
  addSiteMessage,
  countDraftsByOwner,
  countSiteFiles,
  countSites,
  countSitesByOwner,
  createSite,
  deleteSite,
  findSiteByUsername,
  findSiteHeaderById,
  findSiteHeaderByUsername,
  getSiteFile,
  isValidSitePath,
  isValidSiteTag,
  listAllSites,
  listSiteFiles,
  listSiteMessages,
  listSitesByOwner,
  publishDraft,
  publishSiteZip,
  removeSiteFile,
  setSiteStatus,
  siteTagLabel,
  totalSiteFileSize,
  updateSiteHtml,
  updateSiteMeta,
  upsertSiteFile,
  SITE_TAGS,
} from './lib/sites.js';
import { parseZip } from './lib/zip.js';
import {
  createBanner,
  deleteBanner,
  findBannerById,
  listAllBanners,
  listPublicBanners,
  MAX_BANNERS,
  updateBanner,
} from './lib/banners.js';
import {
  addComment,
  countComments,
  countFavorites,
  countLikes,
  countUnread,
  countUnreadMessages,
  clearHistory,
  createFavoriteFolder,
  creatorPage,
  deleteComment,
  deleteFavoriteFolder,
  discoverSites,
  favoriteFolderExists,
  favoriteSite,
  favoriteSiteIds,
  FOLDER_NAME_MAX,
  followUser,
  getComment,
  hasFavorited,
  hasLiked,
  incrementViews,
  isFollowing,
  likeSite,
  listComments,
  listConversations,
  listFavorites,
  listFavoriteFolders,
  listFollows,
  listHistory,
  listMessagesWith,
  listNotifications,
  markConversationRead,
  markNotificationsSeen,
  moveFavorites,
  recordView,
  removeFavorites,
  removeHistory,
  renameFavoriteFolder,
  searchUsers,
  sendMessage,
  socialProfile,
  siteStats,
  unfavoriteSite,
  unfollowUser,
  unlikeSite,
  withViewerFlags,
} from './lib/social.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

// 用户页面一律关进沙箱。
// 关键：绝不能带 allow-same-origin —— 带上之后页面里的脚本能自己解除沙箱，等于没做。
// 现在平台上有了登录 Cookie，这道墙不再是「保险」而是「必需品」。
const SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation';

// 迷你封面滚动代理：注入到带 ?mpcover=1 的入口页。
// 封面 iframe 是沙箱（opaque origin），父页面摸不到它的内部滚动，
// 只能 postMessage 让页面自己滚 —— 等价于真实浏览器窗口往下翻，
// 「100vh 全屏首屏」这类内容高度跟着视口走的站点也能正常预览下翻。
// mpPeekSpeed：匀速下翻（px/s，到底循环）；mpPeekStop：停下回顶；mpPeekTo：滚到指定位置。
// 一律 behavior:'instant'：模板常设 scroll-behavior:smooth，平滑滚动既拖慢步进又会卡在半路。
const MPEEK_PROXY =
  '<script>(function(){var s=0,sp=0,raf=0,last=0;' +
  'function tick(t){if(!sp)return;var dt=Math.min((t-last)/1000,0.1);last=t;' +
  'var max=document.documentElement.scrollHeight-window.innerHeight;' +
  'if(max<=0){raf=requestAnimationFrame(tick);return;}' +
  's+=sp*dt;if(s>=max)s=0;window.scrollTo({top:s,behavior:"instant"});raf=requestAnimationFrame(tick);}' +
  'window.addEventListener("message",function(e){var d=e.data||{};' +
  'if(d.mpPeekSpeed!=null){sp=d.mpPeekSpeed;last=performance.now();if(sp&&!raf)raf=requestAnimationFrame(tick);}' +
  'else if(d.mpPeekStop){sp=0;if(raf)cancelAnimationFrame(raf);raf=0;window.scrollTo({top:0,behavior:"instant"});}' +
  'else if(d.mpPeekTo!=null){window.scrollTo({top:d.mpPeekTo,behavior:"instant"});}});' +
  'if(window.parent!==window)parent.postMessage({mpReady:1},"*");})();</script>';

// 把代理脚本插到最后一个 </body> 前，找不到就追加到末尾；Buffer 进 Buffer 出，string 进 string 出
function injectPeekProxy(html) {
  const s = html.toString('utf8');
  const i = s.toLowerCase().lastIndexOf('</body');
  const out = i === -1 ? s + MPEEK_PROXY : s.slice(0, i) + MPEEK_PROXY + s.slice(i);
  return Buffer.isBuffer(html) ? Buffer.from(out, 'utf8') : out;
}

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

/**
 * 未登录访问需要登录的页面时的统一出口：带上 ?next= 让登录后能回到原处。
 * 只回写 pathname + search（不带 origin），登录页那边也会校验必须是站内相对地址，
 * 所以不存在开放重定向。
 */
function sendLoginRedirect(req, res) {
  let target = '/';
  try {
    const u = new URL(req.url, 'http://internal');
    target = u.pathname + u.search;
  } catch { /* URL 解析不了就回首页 */ }
  sendRedirect(res, '/login?next=' + encodeURIComponent(target));
}

// ---------------------------------------------------------------- 响应压缩（gzip）

// 可压缩的文本类扩展名；图片/字体/视频已是二进制，压了更慢，不列。
const GZIP_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.map', '.webmanifest',
]);
const GZIP_MIN_BYTES = 512; // 太小的响应不值得压（省不下多少还费 CPU）

/** 请求头里是否声明接受 gzip。 */
function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
}

/**
 * 按需 gzip：客户端不接、非文本类型、体积太小三种情况都原样返回。
 * 返回 { body, gzip }，调用方据此决定要不要写 Content-Encoding 与 Vary。
 * 关键点：压缩做在应用里，本地/生产同一份代码都生效，不再依赖 nginx 的 gzip 配置。
 */
function maybeGzip(req, input, ext) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  if (!GZIP_EXTS.has(ext) || buf.length < GZIP_MIN_BYTES || !acceptsGzip(req)) {
    return { body: buf, gzip: false };
  }
  return { body: zlib.gzipSync(buf), gzip: true };
}

/** 按 gzip 结果补头并下发一条响应（Content-Length 用压缩后的真实长度）。 */
function sendWithGzip(req, res, status, headers, input, ext) {
  const { body, gzip } = maybeGzip(req, input, ext);
  res.writeHead(status, {
    ...headers,
    ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    'Content-Length': body.length,
  });
  res.end(body);
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
async function currentUser(req) {
  const row = await findSessionUser(sessionToken(req));
  if (!row) return null;
  if (row.status !== 'active') return null;
  return publicUser(row);
}

/** 当前请求者是不是这个站的作者（草稿可见性判断用）。 */
async function isSiteOwner(req, site) {
  const user = await currentUser(req);
  return Boolean(user) && (site.owner_id === user.id || user.isAdmin);
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
        // 把剩下的请求体读完再丢掉，别在这里 destroy：
        // 掐掉连接会让客户端看到 ECONNRESET，而不是我们想回的 413「文件太大」。
        req.resume();
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
        // 同上：读干丢弃，保证调用方能把这声 413 送出去
        req.resume();
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

async function requireLogin(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, message: '请先登录' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '需要管理员权限' });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------- 页面路由

/** 社区首页（发现流）。 */
async function handleRoot(req, res) {
  await sendPage(res, 'discover.html');
}

/** 老投稿页：投稿已并入「创作」页的「投稿」标签，这里只做跳转。 */
async function handleUploadPage(req, res) {
  sendRedirect(res, '/sites?tab=upload');
}

async function handleLoginPage(req, res) {
  if (await currentUser(req)) {
    sendRedirect(res, '/');
    return;
  }
  await sendPage(res, 'login.html');
}

async function handleAdminPage(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendLoginRedirect(req, res);
    return;
  }
  if (!user.isAdmin) {
    sendHtml(res, 403, messagePage('没有权限', '这个页面只有管理员能看。'));
    return;
  }
  await sendPage(res, 'admin.html');
}

async function handleSettingsPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'settings.html');
}

async function handleForgotPage(req, res) {
  if (await currentUser(req)) {
    sendRedirect(res, '/');
    return;
  }
  await sendPage(res, 'forgot.html');
}

async function handleAccountPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'account.html');
}

/** 页面管理页：站点列表 / 访问 / 编辑 / 删除。 */
async function handleSitesPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'sites.html');
}

/** 新建网页：空态对话栏（图 4），agent 开始编码后跳到工作区。 */
async function handleStudioNewPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'studio-new.html');
}

/** 工作区（图 3）：左边对话栏，右边预览 / 代码。 */
async function handleWorkspacePage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'workspace.html');
}

/** 站点管理编辑页（单页编辑 / 多页文件管理，也是未来智能体辅助编辑的挂载点）。 */
async function handleSiteEditPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
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
  const user = await currentUser(req);
  // 登录用户附带未读通知数 / 未读私信数，导航条不用额外请求
  sendJson(res, 200, {
    ok: true,
    user,
    unread: user ? await countUnread(user.id) : 0,
    unreadMessages: user ? await countUnreadMessages(user.id) : 0,
  });
}

async function handleLogin(req, res) {
  const body = await readBody(req, res);
  if (!body) return;

  const user = await authenticate(String(body.login ?? '').trim(), String(body.password ?? ''));

  if (!user) {
    sendJson(res, 401, { ok: false, message: '账号或密码不对' });
    return;
  }
  if (user.status !== 'active') {
    sendJson(res, 403, { ok: false, message: '这个账号已被封禁' });
    return;
  }

  const token = await createSession(user.id);
  setSessionCookie(res, token, SESSION_TTL_DAYS * 86400);

  sendJson(res, 200, { ok: true, user: publicUser(user) });
}

async function handleLogout(req, res) {
  await deleteSession(sessionToken(req));
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
      if (await findUserByLogin(email)) {
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
    const user = await findUserByLogin(email);
    if (user) await issueCode(email, purpose);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (purpose === 'change') {
    const user = await requireLogin(req, res);
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
  // 用户名就是 /qwq/<用户名>/ 这段路径，注册时必须定下来
  const checkedUsername = checkUsername(body.username);
  if (!checkedUsername.ok) {
    sendJson(res, 400, { ok: false, message: checkedUsername.reason });
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
  if (await findUserByLogin(email)) {
    sendJson(res, 409, { ok: false, message: '这个邮箱已经注册过了' });
    return;
  }
  if (await findUserByLogin(checkedUsername.name)) {
    sendJson(res, 409, { ok: false, message: '这个用户名已经被使用了' });
    return;
  }

  const verified = await consumeCode(email, 'register', code);
  if (!verified.ok) {
    sendJson(res, 400, { ok: false, message: verified.message });
    return;
  }

  let user;
  try {
    user = await createUser({ email, username: checkedUsername.name, password });
  } catch (err) {
    if (err.code === 'NAME_TAKEN' || err.code === 'BAD_NAME') {
      sendJson(res, 409, { ok: false, message: err.message });
      return;
    }
    throw err;
  }
  const token = await createSession(user.id);
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

  if (await findUserByLogin(email)) {
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

  const user = await findUserByLogin(email);
  if (!user) {
    sendJson(res, 400, { ok: false, message: '验证码不对或已过期' });
    return;
  }

  const verified = await consumeCode(email, 'reset', code);
  if (!verified.ok) {
    sendJson(res, 400, { ok: false, message: verified.message });
    return;
  }

  await updateUserPassword(user.id, password);
  await deleteOtherSessions(user.id);
  sendJson(res, 200, { ok: true });
}

/**
 * 登录用户改密码（设置页）：当前密码 + 邮箱验证码 + 新密码。
 * 成功后踢掉其他设备的会话，保留当前这一个。
 */
async function handleChangePassword(req, res) {
  const session = await currentUser(req);
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

  const row = await findUserById(session.id);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    sendJson(res, 400, { ok: false, message: '当前密码不对' });
    return;
  }

  if (!CODE_PATTERN.test(code)) {
    sendJson(res, 400, { ok: false, message: '请输入 6 位邮箱验证码' });
    return;
  }
  const verified = await consumeCode(row.email, 'change', code);
  if (!verified.ok) {
    sendJson(res, 400, { ok: false, message: verified.message });
    return;
  }

  await updateUserPassword(row.id, newPassword);
  await deleteOtherSessions(row.id, sessionToken(req));
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 账号自助设置接口

async function handleAccountUsername(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  try {
    const username = await setUsername(user.id, body.username);
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
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  try {
    await changePassword(user.id, body.currentPassword, body.newPassword);
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
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  try {
    const bio = await setBio(user.id, body.bio ?? null);
    sendJson(res, 200, { ok: true, bio });
  } catch (err) {
    if (err.code === 'BIO_TOO_LONG') {
      sendJson(res, 400, { ok: false, message: err.message });
      return;
    }
    throw err;
  }
}

/**
 * 注销账号：确认密码后删号。
 * sites / site_files / 社交数据 / 会话 / MCP 密钥全部由外键级联清空，
 * 用户空间 /qwq/<用户名>/ 下的一切随之消失。
 */
async function handleAccountDelete(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const row = await findUserById(user.id);
  if (!row || !verifyPassword(String(body.password ?? ''), row.password_hash)) {
    sendJson(res, 400, { ok: false, message: '密码不对' });
    return;
  }
  if (row.is_admin === 1) {
    sendJson(res, 400, { ok: false, message: '管理员账号不能自助注销' });
    return;
  }

  await deleteAccount(user.id);
  setSessionCookie(res, '', 0);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 站点接口

async function handleMySites(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const sites = (await listSitesByOwner(user.id)).map((s) => ({
    id: s.id,
    name: s.name,
    url: urlForSite(user.username, s.name),
    viewUrl: urlForView(user.username, s.name),
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

  sendJson(res, 200, {
    ok: true,
    username: user.username,
    prefix: USER_SPACE_PREFIX,
    quota: MAX_SITES_PER_USER,
    published: sites.filter((s) => s.status !== 'draft').length,
    maxDrafts: MAX_DRAFTS_PER_USER,
    sites,
  });
}

async function handleUpload(req, res) {
  const user = await requireLogin(req, res);
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
    const site = await createSite({ name: checked.name, html, ownerId: user.id });
    sendJson(res, 201, {
      ok: true,
      name: site.name,
      size: site.size,
      url: absoluteUrlForSite(originOf(req), user.username, site.name),
    });
  } catch (err) {
    if (err.code === 'NAME_TAKEN' || err.code === 'QUOTA_EXCEEDED') {
      sendJson(res, err.code === 'NAME_TAKEN' ? 409 : 429, { ok: false, message: err.message });
      return;
    }
    console.error('[upload]', err);
    sendJson(res, 500, { ok: false, message: '服务器出错了，稍后再试' });
  }
}

// ---------------------------------------------------------------- 站点多文件接口

/** 上传/覆盖站点里的一个文件。站点不存在时自动创建（入口页待补 index.html）。 */
async function handleSiteFileUpload(req, res, [username, name]) {
  const user = await requireLogin(req, res);
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

  let site = await findSiteHeaderByUsername(username, checked.name);
  if (!site) {
    // 建站只能建在自己名下：路径里的用户名必须就是自己，
    // 否则站点会建到自己的 id 上、地址却挂在别人名下
    if (username !== user.username) {
      sendJson(res, 403, { ok: false, message: '只能往自己的用户名下建站点' });
      return;
    }
    try {
      await createSite({ name: checked.name, html: '', ownerId: user.id });
      site = await findSiteHeaderByUsername(username, checked.name);
    } catch (err) {
      if (err.code === 'NAME_TAKEN' || err.code === 'QUOTA_EXCEEDED') {
        sendJson(res, err.code === 'NAME_TAKEN' ? 409 : 429, { ok: false, message: err.message });
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

  const isNew = await getSiteFile(site.id, filePath) === null;
  if (isNew && await countSiteFiles(site.id) >= MAX_FILES_PER_SITE) {
    sendJson(res, 409, { ok: false, message: `站点文件太多啦，上限 ${MAX_FILES_PER_SITE} 个` });
    return;
  }
  // 单站总容量：把被覆盖文件的旧体积扣掉只算增量，超上限拒收
  const usedBytes = await totalSiteFileSize(site.id, filePath);
  if (usedBytes + content.length > MAX_SITE_TOTAL_BYTES) {
    sendJson(res, 413, {
      ok: false,
      message: `站点总容量超限，单站上限 ${Math.round(MAX_SITE_TOTAL_BYTES / 1024 / 1024)} MB`,
    });
    return;
  }

  const saved = await upsertSiteFile(site.id, filePath, content);
  sendJson(res, isNew ? 201 : 200, { ok: true, path: saved.path, size: saved.size });
}

/**
 * POST /api/sites/:用户名/:站名/zip：zip 直传整包发布（Netlify Drop 式交互）。
 * body 是 zip 字节流（≤ MAX_ZIP_BYTES），服务端零依赖解压后逐个入库：
 * 路径过滤（非法/垃圾/隐藏文件）→ 文件数与总容量校验 → upsert。
 * 跳过的条目在响应里列出前 20 条，方便前端提示「这些没进来」。
 */
async function handleSiteZipUpload(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const checked = checkName(name);
  if (!checked.ok) {
    sendJson(res, 400, { ok: false, message: checked.reason });
    return;
  }

  const zipBuf = await readFileBody(req, res, MAX_ZIP_BYTES);
  if (!zipBuf) return;

  const site = await findSiteHeaderByUsername(username, checked.name);
  if (site && (site.owner_id !== user.id || username !== user.username) && !user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '只能操作自己的站点' });
    return;
  }
  // 建站只能建在自己名下：路径里的用户名必须就是自己
  if (!site && username !== user.username) {
    sendJson(res, 403, { ok: false, message: '只能往自己的用户名下建站点' });
    return;
  }

  let parsed;
  try {
    parsed = parseZip(zipBuf, {
      maxEntries: MAX_FILES_PER_SITE,
      maxEntryBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_SITE_TOTAL_BYTES,
    });
  } catch (err) {
    sendJson(res, 400, { ok: false, message: 'zip 解不开：' + err.message });
    return;
  }

  try {
    const { saved, skipped, totalBytes } = await publishSiteZip({
      name: checked.name,
      ownerId: user.id,
      isAdmin: user.isAdmin,
      entries: parsed.entries,
      skipped: parsed.skipped,
    });
    sendJson(res, 201, {
      ok: true,
      saved,
      skipped: skipped.length,
      skipList: skipped.slice(0, 20),
      totalBytes,
    });
  } catch (err) {
    if (err.code === 'NO_FILES') {
      sendJson(res, 400, {
        ok: false,
        message: 'zip 里没有可发布的文件' + (err.skipped.length ? `（${err.skipped.length} 个条目被跳过）` : ''),
        skipped: err.skipped.slice(0, 20),
      });
      return;
    }
    if (err.code === 'FORBIDDEN' || err.code === 'NAME_TAKEN' || err.code === 'QUOTA_EXCEEDED') {
      const status = err.code === 'FORBIDDEN' ? 403 : (err.code === 'NAME_TAKEN' ? 409 : 429);
      sendJson(res, status, { ok: false, message: err.message });
      return;
    }
    console.error('[site-zip-upload]', err);
    sendJson(res, 500, { ok: false, message: '服务器出错了，稍后再试' });
  }
}

/** 列出站点里的全部文件（不含内容）。站点的主人或管理员可看。 */
async function handleSiteFilesList(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await findSiteHeaderByUsername(username, name);
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
    total: await countSiteFiles(site.id),
    files: await listSiteFiles(site.id),
  });
}

// ---------------------------------------------------------------- 站点管理接口（个人中心 / 编辑页用）

/** 取一个站点（含 html），归属或管理员才放行；失败时已回响应并返回 null。 */
async function ownSiteOrRespond(req, res, user, username, name) {
  const site = await findSiteByUsername(username, name);
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
async function handleSiteDetail(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownSiteOrRespond(req, res, user, username, name);
  if (!site) return;

  const fileCount = await countSiteFiles(site.id);
  sendJson(res, 200, {
    ok: true,
    site: {
      id: site.id,
      name: site.name,
      url: urlForSite(user.username, site.name),
      viewUrl: urlForView(user.username, site.name),
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
async function handleSiteSaveMeta(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownSiteOrRespond(req, res, user, username, name);
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

  await updateSiteMeta(site.id, { title, description, tag });
  sendJson(res, 200, { ok: true, title, description, tag, tagLabel: siteTagLabel(tag) });
}

/** 保存单页站的 HTML（编辑页的「保存」按钮）。 */
async function handleSiteSaveHtml(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownSiteOrRespond(req, res, user, username, name);
  if (!site) return;

  if (await countSiteFiles(site.id) > 0) {
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

  const size = await updateSiteHtml(site.id, html);
  sendJson(res, 200, { ok: true, size });
}

/** 删除整个站点（site_files 由外键级联清掉）。 */
async function handleSiteDelete(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownSiteOrRespond(req, res, user, username, name);
  if (!site) return;

  await deleteSite(site.id);
  sendJson(res, 200, { ok: true });
}

/** 取一个站点文件的内容（文本文件才能在编辑页里编辑）。 */
async function handleSiteFileContent(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownSiteOrRespond(req, res, user, username, name);
  if (!site) return;

  const filePath = new URL(req.url, 'http://internal').searchParams.get('path');
  if (!filePath || !isValidSitePath(filePath)) {
    sendJson(res, 400, { ok: false, message: '文件路径不合法' });
    return;
  }

  const content = await getSiteFile(site.id, filePath);
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
async function handleSiteFileDelete(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownSiteOrRespond(req, res, user, username, name);
  if (!site) return;

  const filePath = new URL(req.url, 'http://internal').searchParams.get('path');
  if (!filePath || !isValidSitePath(filePath)) {
    sendJson(res, 400, { ok: false, message: '文件路径不合法' });
    return;
  }

  const changes = await removeSiteFile(site.id, filePath);
  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '站点里没有这个文件' });
    return;
  }

  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 创作工作区（草稿 / 对话）

/** 新建草稿时给一个能直接预览的占位页，省得工作区一打开就是 404。 */
const STARTER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>还没有内容</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#0f1115;color:#e8eaed;
       font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  .tip{text-align:center;max-width:28rem;padding:2rem}
  .tip h1{font-size:22px;margin:0 0 .6rem}
  .tip p{margin:0;color:#9aa0a8;font-size:14px}
</style>
</head>
<body>
<div class="tip">
  <h1>空白草稿</h1>
  <p>在左侧告诉 agent 你想要什么，或切到「代码」直接写。</p>
</div>
</body>
</html>`;

/**
 * POST /api/studio/drafts：建一张草稿站（status='draft'，不占站点配额）。
 * body {name?}：带了就用它当站名，没带就按时间戳生成一个。
 * 草稿统一走多文件模式，先落一个 index.html，预览 / 代码都有东西可看。
 */
async function handleStudioDraftCreate(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const wanted = body.name === undefined || body.name === null
    ? ''
    : String(body.name).trim().toLowerCase();

  const name = wanted || `page-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const checked = checkName(name);
  if (!checked.ok) {
    sendJson(res, 400, { ok: false, message: checked.reason });
    return;
  }

  try {
    const site = await createSite({
      name: checked.name,
      html: '',
      ownerId: user.id,
      status: 'draft',
    });
    await upsertSiteFile(site.id, 'index.html', Buffer.from(STARTER_HTML, 'utf8'));
    sendJson(res, 201, {
      ok: true,
      site: { id: site.id, name: site.name, status: site.status, url: urlForSite(user.username, site.name) },
      drafts: await countDraftsByOwner(user.id),
      maxDrafts: MAX_DRAFTS_PER_USER,
    });
  } catch (err) {
    if (err.code === 'NAME_TAKEN') {
      sendJson(res, 409, { ok: false, message: err.message });
      return;
    }
    if (err.code === 'DRAFT_QUOTA_EXCEEDED') {
      sendJson(res, 429, { ok: false, message: err.message });
      return;
    }
    console.error('[studio-draft-create]', err);
    sendJson(res, 500, { ok: false, message: '服务器出错了，稍后再试' });
  }
}

/** POST /api/sites/:用户名/:站名/publish：把草稿发布成一张全新的正式站（草稿保留）。 */
async function handleSitePublishDraft(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await findSiteHeaderByUsername(username, name);
  if (!site) {
    sendJson(res, 404, { ok: false, message: '没有这个站点' });
    return;
  }
  if (site.owner_id !== user.id && !user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '只能发布自己的草稿' });
    return;
  }

  const body = await readBody(req, res);
  if (!body) return;

  const targetName = String(body.name ?? '').trim().toLowerCase();
  const checked = checkName(targetName);
  if (!checked.ok) {
    sendJson(res, 400, { ok: false, message: checked.reason });
    return;
  }

  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim();
  const tag = String(body.tag ?? '').trim();

  if (title.length > SITE_TITLE_MAX) {
    sendJson(res, 400, { ok: false, message: `标题最多 ${SITE_TITLE_MAX} 字` });
    return;
  }
  if (description.length > SITE_DESC_MAX) {
    sendJson(res, 400, { ok: false, message: `简介最多 ${SITE_DESC_MAX} 字` });
    return;
  }
  if (!isValidSiteTag(tag)) {
    sendJson(res, 400, { ok: false, message: '内容标签不对' });
    return;
  }

  try {
    const created = await publishDraft({
      draftSiteId: site.id,
      ownerId: user.id,
      name: checked.name,
      title,
      description,
      tag,
    });
    sendJson(res, 201, {
      ok: true,
      site: {
        id: created.id,
        name: created.name,
        url: absoluteUrlForSite(originOf(req), user.username, created.name),
        viewUrl: urlForView(user.username, created.name),
      },
      fileCount: created.fileCount,
    });
  } catch (err) {
    if (err.code === 'NAME_TAKEN') {
      sendJson(res, 409, { ok: false, message: err.message });
      return;
    }
    if (err.code === 'QUOTA_EXCEEDED') {
      sendJson(res, 429, { ok: false, message: err.message });
      return;
    }
    if (err.code === 'NOT_DRAFT' || err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN') {
      sendJson(res, 400, { ok: false, message: err.message });
      return;
    }
    console.error('[site-publish]', err);
    sendJson(res, 500, { ok: false, message: '服务器出错了，稍后再试' });
  }
}

/** 只允许操作自己名下的站点（草稿 / 对话都走这一层）。 */
async function ownDraftOrRespond(req, res, user, username, name) {
  const site = await findSiteHeaderByUsername(username, name);
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

/** GET /api/sites/:用户名/:站名/messages：工作区对话记录。 */
async function handleSiteMessagesList(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownDraftOrRespond(req, res, user, username, name);
  if (!site) return;

  sendJson(res, 200, {
    ok: true,
    messages: await listSiteMessages(site.id, SITE_MESSAGES_KEEP),
  });
}

/**
 * POST /api/sites/:用户名/:站名/messages：追加一条用户消息。
 * 本轮 agent 只回一句占位话（不接模型），一起入库，刷新后对话还在。
 */
async function handleSiteMessageAdd(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await ownDraftOrRespond(req, res, user, username, name);
  if (!site) return;

  const body = await readBody(req, res);
  if (!body) return;

  const content = String(body.content ?? '').trim();
  if (!content) {
    sendJson(res, 400, { ok: false, message: '说点什么再发送' });
    return;
  }
  if (content.length > SITE_MESSAGE_MAX) {
    sendJson(res, 413, { ok: false, message: `一条消息最多 ${SITE_MESSAGE_MAX} 字` });
    return;
  }

  const mine = await addSiteMessage(site.id, 'user', content);
  const reply = await addSiteMessage(
    site.id,
    'agent',
    '（占位回复）已开始生成…',
  );

  sendJson(res, 201, { ok: true, user: mine, agent: reply });
}

// ---------------------------------------------------------------- 社区互动接口（阶段 1 数据层）

/** 按「作者用户名 + 站名」取站点头部，不存在时已回 404 并返回 null。 */
async function siteHeaderOrRespond(res, username, name) {
  const site = await findSiteHeaderByUsername(username, name);
  if (!site) {
    sendJson(res, 404, { ok: false, message: '没有这个站点' });
    return null;
  }
  return site;
}

/** 已下线的站点不再接受新的互动（看统计和评论列表没关系）。 */
function activeSiteOrRespond(res, site) {
  if (site.status !== 'active') {
    sendJson(res, 451, { ok: false, message: '站点已下线，暂停互动' });
    return null;
  }
  return site;
}

/** 互动数字汇总。公开接口，登录后附带「我是否赞过 / 藏过」。 */
async function handleSiteStats(req, res, [username, name]) {
  const site = await siteHeaderOrRespond(res, username, name);
  if (!site) return;

  const viewer = await currentUser(req);
  // 附带站点与作者信息，观看包装页一次请求全拿到
  const authorRow = await findUserById(site.owner_id);
  sendJson(res, 200, {
    ok: true,
    stats: await siteStats(site.id, viewer?.id ?? null),
    site: {
      name: site.name,
      title: site.title || site.name,
      description: site.description,
      tag: site.tag,
      tagLabel: tagLabelOf(site.tag),
      ownerId: site.owner_id,
      status: site.status,
      author: authorRow
        ? {
            id: authorRow.id,
            name: authorRow.username,
            username: authorRow.username,
          }
        : null,
    },
  });
}

async function handleSiteLike(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await siteHeaderOrRespond(res, username, name);
  if (!site || !activeSiteOrRespond(res, site)) return;

  await likeSite(site.id, user.id);
  sendJson(res, 200, { ok: true, liked: true, likes: await countLikes(site.id) });
}

async function handleSiteUnlike(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await siteHeaderOrRespond(res, username, name);
  if (!site) return;

  await unlikeSite(site.id, user.id);
  sendJson(res, 200, { ok: true, liked: false, likes: await countLikes(site.id) });
}

async function handleSiteCommentsList(req, res, [username, name]) {
  const site = await siteHeaderOrRespond(res, username, name);
  if (!site) return;

  sendJson(res, 200, { ok: true, total: await countComments(site.id), comments: await listComments(site.id) });
}

async function handleSiteCommentAdd(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await siteHeaderOrRespond(res, username, name);
  if (!site || !activeSiteOrRespond(res, site)) return;

  const body = await readBody(req, res);
  if (!body) return;

  const content = String(body.content ?? '').trim();
  if (content === '') {
    sendJson(res, 400, { ok: false, message: '评论不能是空的' });
    return;
  }
  if (content.length > COMMENT_MAX) {
    sendJson(res, 400, { ok: false, message: `评论最多 ${COMMENT_MAX} 字` });
    return;
  }

  // 一级回复：被回复的评论必须存在且属于同一站点
  let replyTo = null;
  if (body.replyTo !== undefined && body.replyTo !== null) {
    const parent = await getComment(Number(body.replyTo));
    if (!parent || parent.site_id !== site.id) {
      sendJson(res, 400, { ok: false, message: '要回复的评论不存在' });
      return;
    }
    replyTo = parent.id;
  }

  const id = await addComment({ siteId: site.id, userId: user.id, replyTo, content });
  sendJson(res, 201, {
    ok: true,
    comment: {
      id,
      replyTo,
      content,
      createdAt: new Date().toISOString(),
      author: { id: user.id, name: user.username, username: user.username },
    },
    total: await countComments(site.id),
  });
}

/** 删评论：作者本人或管理员。删掉的评论若有回复，回复一并级联删除。 */
async function handleSiteCommentDelete(req, res, [username, name, id]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await siteHeaderOrRespond(res, username, name);
  if (!site) return;

  const comment = await getComment(Number(id));
  if (!comment || comment.site_id !== site.id) {
    sendJson(res, 404, { ok: false, message: '没有这条评论' });
    return;
  }
  if (comment.user_id !== user.id && !user.isAdmin) {
    sendJson(res, 403, { ok: false, message: '只能删除自己的评论' });
    return;
  }

  await deleteComment(comment.id);
  sendJson(res, 200, { ok: true, total: await countComments(site.id) });
}

/** 收藏夹名字：去空白后必须 1..FOLDER_NAME_MAX 字，不合法返回 null。 */
function normalizeFolderName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > FOLDER_NAME_MAX) return null;
  return name;
}

async function handleSiteFavorite(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await siteHeaderOrRespond(res, username, name);
  if (!site || !activeSiteOrRespond(res, site)) return;

  const body = await readBody(req, res);
  if (!body) return;

  // 收藏夹用简单版：只存一个名字，不传就是「默认收藏夹」
  const folder = String(body.folder ?? '').trim() || '默认收藏夹';
  if (folder.length > FOLDER_NAME_MAX) {
    sendJson(res, 400, { ok: false, message: `收藏夹名字最多 ${FOLDER_NAME_MAX} 字` });
    return;
  }

  await favoriteSite(site.id, user.id, folder);
  sendJson(res, 200, {
    ok: true,
    favorited: true,
    folder,
    favorites: await countFavorites(site.id),
  });
}

async function handleSiteUnfavorite(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await siteHeaderOrRespond(res, username, name);
  if (!site) return;

  await unfavoriteSite(site.id, user.id);
  sendJson(res, 200, { ok: true, favorited: false, favorites: await countFavorites(site.id) });
}

/** 关注 / 取关一个用户（按用户 id）。不能关注自己。 */
async function handleUserFollow(req, res, [id]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const targetId = Number(id);
  if (targetId === user.id) {
    sendJson(res, 400, { ok: false, message: '不能关注自己' });
    return;
  }
  if (!(await findUserById(targetId))) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }

  await followUser(user.id, targetId);
  sendJson(res, 200, { ok: true, following: true, followers: (await socialProfile(targetId)).followers });
}

async function handleUserUnfollow(req, res, [id]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const targetId = Number(id);
  if ((await unfollowUser(user.id, targetId)) === 0 && !(await findUserById(targetId))) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }

  sendJson(res, 200, { ok: true, following: false, followers: (await socialProfile(targetId)).followers });
}

/** 粉丝数 / 关注数 / 我是否已关注。公开接口。 */
async function handleUserSocial(req, res, [id]) {
  const target = await findUserById(Number(id));
  if (!target) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }

  const viewer = await currentUser(req);
  const profile = await socialProfile(target.id);
  sendJson(res, 200, {
    ok: true,
    followers: profile.followers,
    following: profile.following,
    isFollowing: await isFollowing(viewer?.id ?? null, target.id),
  });
}

/** 某用户的粉丝 / 关注列表。?type=followers|following，默认 followers。公开接口。 */
async function handleFollowList(req, res, [id]) {
  const target = await findUserById(Number(id));
  if (!target) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const type = url.searchParams.get('type') === 'following' ? 'following' : 'followers';
  const viewer = await currentUser(req);
  const users = await listFollows(target.id, type, viewer?.id ?? null);
  sendJson(res, 200, { ok: true, type, users });
}

/** tag key -> 中文标签。 */
const tagLabelOf = (key) => SITE_TAGS.find((t) => t.key === key)?.label ?? '';

/** 社区发现流：公开上线站点 + 互动数字。?q= 模糊搜索，?tag= 标签筛选，?sort= 排序。 */
async function handleDiscover(req, res) {
  const viewer = await currentUser(req);
  const url = new URL(req.url, 'http://localhost');
  const q = String(url.searchParams.get('q') ?? '').slice(0, 50);
  const tagParam = String(url.searchParams.get('tag') ?? '');
  const tag = SITE_TAGS.some((t) => t.key === tagParam) ? tagParam : '';
  const sort = String(url.searchParams.get('sort') ?? '');

  const size = Math.min(50, Math.max(1, Number(url.searchParams.get('size')) || 10));
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);

  const { total, sites } = await discoverSites({ q, tag, sort, limit: size, offset: (page - 1) * size });

  sendJson(res, 200, {
    ok: true,
    total,
    page,
    size,
    pages: Math.max(1, Math.ceil(total / size)),
    sites: (await withViewerFlags(sites, viewer?.id)).map((s) => ({ ...s, tagLabel: tagLabelOf(s.tag) })),
  });
}

// ---------------------------------------------------------------- 创作者主页（阶段 3）

/**
 * /qwq/:用户名 创作者公开主页。
 *
 * 没有另设 /u/:用户名：用户空间入口就是这一个地址，少一次跳转，
 * 也让「用户的所有东西都挂在 /qwq/<用户名> 下」这条规则没有例外。
 * 用户空间下恰好两段时是主页，三段时是站点（见 handleRequest 末尾）。
 */
async function handleUserPage(req, res) {
  await sendPage(res, 'user.html');
}

/** 创作者主页数据：资料 + 社交数字 + TA 的公开站点列表。 */
async function handleCreatorProfile(req, res, [username]) {
  const page = await creatorPage(username);
  if (!page) {
    sendJson(res, 404, { ok: false, message: '没有这个创作者' });
    return;
  }

  const viewer = await currentUser(req);
  sendJson(res, 200, {
    ok: true,
    user: page.user,
    stats: page.stats,
    isFollowing: await isFollowing(viewer?.id ?? null, page.user.id),
    isOwn: viewer?.id === page.user.id,
    sites: (await withViewerFlags(page.sites, viewer?.id)).map((s) => ({
      ...s,
      tagLabel: tagLabelOf(s.tag),
      // 卡片上的作者区、访问 / 编辑 / 删除按钮都要靠这个拼地址
      author: { id: page.user.id, name: page.user.username, username: page.user.username },
    })),
  });
}

// ---------------------------------------------------------------- 观看包装页与通知（阶段 4）

/** /view/:站名 观看包装页：平台导航条 + iframe 嵌用户站点 + 评论区。 */
async function handleViewPage(req, res) {
  await sendPage(res, 'view.html');
}

/** 通知列表页。 */
async function handleNotificationsPage(req, res) {
  await sendPage(res, 'notifications.html');
}

/** 我的收藏页。 */
async function handleFavoritesPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'favorites.html');
}

/** 浏览历史页。 */
async function handleHistoryPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'history.html');
}

/** 私信页。 */
async function handleMessagesPage(req, res) {
  if (!(await currentUser(req))) {
    sendLoginRedirect(req, res);
    return;
  }
  await sendPage(res, 'messages.html');
}

/** 通知列表：谁赞 / 评 / 藏 / 关注了我。 */
async function handleNotificationsList(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  sendJson(res, 200, {
    ok: true,
    items: await listNotifications(user.id),
  });
}

/** 标记通知已读：把已读时间戳推进到当前时刻。 */
async function handleNotificationsSeen(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  await markNotificationsSeen(user.id);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 浏览历史 / 收藏夹 / 用户搜索 / 私信

/** 列表统一补 tagLabel。 */
const withTagLabel = (sites) => sites.map((s) => ({ ...s, tagLabel: tagLabelOf(s.tag) }));

/** 我的浏览历史列表。 */
async function handleHistoryList(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  sendJson(res, 200, { ok: true, sites: withTagLabel(await listHistory(user.id)) });
}

/** 记录浏览历史（观看页打开时调用）。body: { username, site } */
async function handleHistoryRecord(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const site = await findSiteHeaderByUsername(String(body.username ?? ''), String(body.site ?? ''));
  if (!site) {
    sendJson(res, 404, { ok: false, message: '没有这个站点' });
    return;
  }

  await recordView(user.id, site.id);
  sendJson(res, 200, { ok: true });
}

/** 删除单条浏览历史（/api/history/:用户名/:站名）。 */
async function handleHistoryDelete(req, res, [username, name]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const site = await findSiteHeaderByUsername(username, name);
  if (site) await removeHistory(user.id, site.id);
  sendJson(res, 200, { ok: true });
}

/** 清空浏览历史。 */
async function handleHistoryClear(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  await clearHistory(user.id);
  sendJson(res, 200, { ok: true });
}

/** 我的收藏列表（平铺，前端按收藏夹分组）。 */
async function handleFavoritesList(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  sendJson(res, 200, {
    ok: true,
    sites: withTagLabel(await withViewerFlags(await listFavorites(user.id), user.id)),
    folders: await listFavoriteFolders(user.id),
  });
}

/** 收藏夹清单（我的收藏页左侧分类、观看页收藏选择器共用）。 */
async function handleFavoriteFolders(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  sendJson(res, 200, { ok: true, folders: await listFavoriteFolders(user.id) });
}

/** 新建收藏夹。 */
async function handleFavoriteFolderCreate(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const name = normalizeFolderName(body.name);
  if (!name) {
    sendJson(res, 400, { ok: false, message: `收藏夹名字不能为空，最多 ${FOLDER_NAME_MAX} 字` });
    return;
  }
  if (await favoriteFolderExists(user.id, name)) {
    sendJson(res, 409, { ok: false, message: '已经有同名收藏夹了' });
    return;
  }

  await createFavoriteFolder(user.id, name);
  sendJson(res, 200, { ok: true, name, folders: await listFavoriteFolders(user.id) });
}

/** 重命名收藏夹：夹子名和夹内收藏一起改。 */
async function handleFavoriteFolderRename(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const from = normalizeFolderName(body.from);
  const to = normalizeFolderName(body.to);
  if (!from || !to) {
    sendJson(res, 400, { ok: false, message: `收藏夹名字不能为空，最多 ${FOLDER_NAME_MAX} 字` });
    return;
  }
  if (from === to) {
    sendJson(res, 200, { ok: true, name: to, folders: await listFavoriteFolders(user.id) });
    return;
  }
  if (!(await favoriteFolderExists(user.id, from))) {
    sendJson(res, 404, { ok: false, message: '没有这个收藏夹' });
    return;
  }
  if (await favoriteFolderExists(user.id, to)) {
    sendJson(res, 409, { ok: false, message: '已经有同名收藏夹了' });
    return;
  }

  await renameFavoriteFolder(user.id, from, to);
  sendJson(res, 200, { ok: true, name: to, folders: await listFavoriteFolders(user.id) });
}

/** 删除收藏夹：只允许删空夹子，且至少保留一个。 */
async function handleFavoriteFolderDelete(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const name = normalizeFolderName(body.name);
  if (!name) {
    sendJson(res, 400, { ok: false, message: '收藏夹名字不能为空' });
    return;
  }

  const folders = await listFavoriteFolders(user.id);
  const target = folders.find((f) => f.name === name);
  if (!target) {
    sendJson(res, 404, { ok: false, message: '没有这个收藏夹' });
    return;
  }
  if (target.count > 0) {
    sendJson(res, 400, { ok: false, message: '收藏夹里还有页面，先移走或取消收藏再删' });
    return;
  }
  if (folders.length <= 1) {
    sendJson(res, 400, { ok: false, message: '至少保留一个收藏夹' });
    return;
  }

  await deleteFavoriteFolder(user.id, name);
  sendJson(res, 200, { ok: true, folders: await listFavoriteFolders(user.id) });
}

/** 批量操作：把选中的收藏移到某个收藏夹（不存在就建），或批量取消收藏。 */
async function handleFavoritesBatch(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  const action = String(body.action ?? '');
  const names = Array.isArray(body.sites) ? body.sites.map((n) => String(n)).slice(0, 200) : [];
  if (!names.length) {
    sendJson(res, 400, { ok: false, message: '先选中要操作的页面' });
    return;
  }

  const siteIds = await favoriteSiteIds(user.id, names);
  if (!siteIds.length) {
    sendJson(res, 404, { ok: false, message: '选中的页面已经不在收藏里了' });
    return;
  }

  if (action === 'move') {
    const folder = normalizeFolderName(body.folder);
    if (!folder) {
      sendJson(res, 400, { ok: false, message: `收藏夹名字不能为空，最多 ${FOLDER_NAME_MAX} 字` });
      return;
    }
    if (!(await favoriteFolderExists(user.id, folder))) await createFavoriteFolder(user.id, folder);
    const moved = await moveFavorites(user.id, siteIds, folder);
    sendJson(res, 200, {
      ok: true,
      moved,
      folder,
      sites: withTagLabel(await listFavorites(user.id)),
      folders: await listFavoriteFolders(user.id),
    });
    return;
  }

  if (action === 'remove') {
    const removed = await removeFavorites(user.id, siteIds);
    sendJson(res, 200, {
      ok: true,
      removed,
      sites: withTagLabel(await listFavorites(user.id)),
      folders: await listFavoriteFolders(user.id),
    });
    return;
  }

  sendJson(res, 400, { ok: false, message: '不认识的批量操作' });
}

/** 用户搜索（搜索下拉的「用户」分区用）。 */
async function handleUserSearch(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = String(url.searchParams.get('q') ?? '').slice(0, 50);
  sendJson(res, 200, { ok: true, users: await searchUsers(q) });
}

/** 私信会话列表。 */
async function handleConversations(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  sendJson(res, 200, { ok: true, conversations: await listConversations(user.id) });
}

/** 与某人的消息往来，顺手把对方发来的标为已读。 */
async function handleMessagesWith(req, res, [id]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const otherId = Number(id);
  if (otherId === user.id) {
    sendJson(res, 400, { ok: false, message: '不能和自己私信' });
    return;
  }
  const other = await findUserById(otherId);
  if (!other) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }

  const messages = await listMessagesWith(user.id, otherId);
  await markConversationRead(user.id, otherId);
  sendJson(res, 200, {
    ok: true,
    user: {
      id: other.id,
      name: other.username,
      username: other.username,
      bio: other.bio ?? '',
    },
    messages,
  });
}

/** 发私信。 */
async function handleMessageSend(req, res, [id]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const otherId = Number(id);
  if (otherId === user.id) {
    sendJson(res, 400, { ok: false, message: '不能和自己私信' });
    return;
  }
  const other = await findUserById(otherId);
  if (!other) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }
  if (other.status !== 'active') {
    sendJson(res, 403, { ok: false, message: '对方账号当前不可用' });
    return;
  }

  const body = await readBody(req, res);
  if (!body) return;

  const content = String(body.content ?? '').trim();
  if (content === '') {
    sendJson(res, 400, { ok: false, message: '私信不能是空的' });
    return;
  }
  if (content.length > COMMENT_MAX) {
    sendJson(res, 400, { ok: false, message: `私信最多 ${COMMENT_MAX} 字` });
    return;
  }

  const mid = await sendMessage(user.id, otherId, content);
  sendJson(res, 201, { ok: true, id: mid, at: new Date().toISOString() });
}

// ---------------------------------------------------------------- MCP

/**
 * MCP 的 HTTP 入口。协议本身在 lib/mcp/server.js 里，这里只做路由。
 * 密钥走 Authorization: Bearer / ?key= / /mcp/<key> 三选一，与登录 Cookie 无关。
 */
async function handleMcpPost(req, res) {
  await handleMcp(req, res, '');
}

async function handleMcpPostWithKey(req, res, [key]) {
  await handleMcp(req, res, key);
}

/** 密钥管理：走登录态，和 MCP 运行时那条 API key 路径互不相交。 */
async function handleMcpTokenList(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  sendJson(res, 200, { ok: true, tokens: await listMcpTokens(user.id) });
}

async function handleMcpTokenCreate(req, res) {
  const user = await requireLogin(req, res);
  if (!user) return;

  const body = await readBody(req, res);
  if (!body) return;

  try {
    const { token, record } = await createMcpToken(user.id, body.label);
    // 明文只在这里出现一次，库里存的是 sha256
    sendJson(res, 201, { ok: true, token, record });
  } catch (err) {
    if (err.code === 'BAD_LABEL') {
      sendJson(res, 400, { ok: false, message: err.message });
      return;
    }
    if (err.code === 'TOO_MANY_TOKENS') {
      sendJson(res, 409, { ok: false, message: err.message });
      return;
    }
    throw err;
  }
}

async function handleMcpTokenRevoke(req, res, [id]) {
  const user = await requireLogin(req, res);
  if (!user) return;

  if (await revokeMcpToken(user.id, id) === 0) {
    sendJson(res, 404, { ok: false, message: '没有这把密钥' });
    return;
  }

  sendJson(res, 200, { ok: true, id: Number(id) });
}

// ---------------------------------------------------------------- 管理接口

async function handleAdminUsers(req, res) {
  if (!(await requireAdmin(req, res))) return;

  sendJson(res, 200, {
    ok: true,
    total: await countUsers(),
    users: (await listUsers()).map(publicUser),
  });
}

async function handleAdminUserStatus(req, res, [id]) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const targetId = Number(id);
  if (targetId === admin.id) {
    sendJson(res, 400, { ok: false, message: '不能封禁自己' });
    return;
  }

  const body = await readBody(req, res);
  if (!body) return;

  const status = body.status === 'banned' ? 'banned' : 'active';
  const changes = await setUserStatus(targetId, status);

  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个用户' });
    return;
  }

  sendJson(res, 200, { ok: true, id: targetId, status });
}

async function handleAdminSites(req, res) {
  if (!(await requireAdmin(req, res))) return;

  sendJson(res, 200, {
    ok: true,
    total: await countSites(),
    sites: await listAllSites(),
  });
}

async function handleAdminSiteStatus(req, res, [id]) {
  if (!(await requireAdmin(req, res))) return;

  const body = await readBody(req, res);
  if (!body) return;

  const status = body.status === 'offline' ? 'offline' : 'active';
  const changes = await setSiteStatus(Number(id), status);

  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个页面' });
    return;
  }

  sendJson(res, 200, { ok: true, id: Number(id), status });
}

async function handleAdminDeleteSite(req, res, [id]) {
  if (!(await requireAdmin(req, res))) return;

  const changes = await deleteSite(Number(id));
  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个页面' });
    return;
  }

  sendJson(res, 200, { ok: true, id: Number(id) });
}

// ---------------------------------------------------------------- 首页轮播位

/** 首页轮播数据：公开接口，只回启用中且站点在线的。 */
async function handleBannersPublic(req, res) {
  sendJson(res, 200, { ok: true, banners: await listPublicBanners() });
}

/** 后台：全部轮播位（含停用），连同可选的站点清单一起给，方便下拉选。 */
async function handleAdminBanners(req, res) {
  if (!(await requireAdmin(req, res))) return;

  sendJson(res, 200, {
    ok: true,
    max: MAX_BANNERS,
    banners: await listAllBanners(),
    // 可选的站点：只列在线的，按作者名+站名排，下拉里好找
    sites: (await listAllSites({ limit: 500 }))
      .filter((s) => s.status === 'active')
      .map((s) => ({
        id: s.id,
        name: s.name,
        owner: s.owner_username ?? '',
        label: `/${s.owner_username ?? '?'}/${s.name}`,
      })),
  });
}

/** 解析一条轮播位的请求体；不合法时已回响应并返回 null。 */
function parseBannerBody(body) {
  const siteId = Number(body.siteId);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return { error: '先选一个页面' };
  }

  const title = String(body.title ?? '').trim();
  const subtitle = String(body.subtitle ?? '').trim();
  if (title.length > 120) return { error: '标题最多 120 字' };
  if (subtitle.length > 200) return { error: '副标题最多 200 字' };

  const sortOrder = Number(body.sortOrder);
  return {
    value: {
      siteId,
      title,
      subtitle,
      sortOrder: Number.isFinite(sortOrder) ? Math.trunc(sortOrder) : 0,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    },
  };
}

async function handleAdminBannerCreate(req, res) {
  if (!(await requireAdmin(req, res))) return;

  const body = await readBody(req, res);
  if (!body) return;

  const parsed = parseBannerBody(body);
  if (parsed.error) {
    sendJson(res, 400, { ok: false, message: parsed.error });
    return;
  }
  if (!(await findSiteHeaderById(parsed.value.siteId))) {
    sendJson(res, 404, { ok: false, message: '没有这个页面' });
    return;
  }

  try {
    const banner = await createBanner(parsed.value);
    sendJson(res, 201, { ok: true, banner });
  } catch (err) {
    if (err.code === 'TOO_MANY_BANNERS') {
      sendJson(res, 409, { ok: false, message: err.message });
      return;
    }
    throw err;
  }
}

async function handleAdminBannerUpdate(req, res, [id]) {
  if (!(await requireAdmin(req, res))) return;

  const body = await readBody(req, res);
  if (!body) return;

  const parsed = parseBannerBody(body);
  if (parsed.error) {
    sendJson(res, 400, { ok: false, message: parsed.error });
    return;
  }
  if (!(await findSiteHeaderById(parsed.value.siteId))) {
    sendJson(res, 404, { ok: false, message: '没有这个页面' });
    return;
  }

  const changes = await updateBanner(Number(id), parsed.value);
  if (changes === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个轮播位' });
    return;
  }

  sendJson(res, 200, { ok: true, banner: await findBannerById(Number(id)) });
}

async function handleAdminBannerDelete(req, res, [id]) {
  if (!(await requireAdmin(req, res))) return;

  if (await deleteBanner(Number(id)) === 0) {
    sendJson(res, 404, { ok: false, message: '没有这个轮播位' });
    return;
  }

  sendJson(res, 200, { ok: true, id: Number(id) });
}

function serveSiteFile(req, res, filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  // html / svg / xml 都是可以带脚本的文档类型，必须一起关进沙箱
  const isDoc = ext === '.html' || ext === '.htm' || ext === '.svg' || ext === '.xml';

  const headers = {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    // HTML 入口保持 no-cache（随时能拿到最新版本，且体积小）；
    // 其余静态资源（css/js/图片/字体/svg/json）给 1 小时浏览器缓存：
    // 翻页、回访、多看几个封面时不再重复下载，是"封面慢"的主要缓解手段。
    'Cache-Control': (ext === '.html' || ext === '.htm') ? 'no-cache' : 'public, max-age=3600',
    // 宣告支持 Range：视频/音频拖进度条走 206，不会每次整包重下
    'Accept-Ranges': 'bytes',
    // 沙箱 CSP 下页面是 opaque origin，字体等子资源请求属跨域，必须带 CORS 头才不报 ERR_FAILED
    'Access-Control-Allow-Origin': '*',
    ...(isDoc ? { 'Content-Security-Policy': SANDBOX_CSP } : {}),
  };

  // 解析单段 Range（bytes=start-end / bytes=start- / bytes=-suffix）。
  // 多段（含逗号）不支持，按无 Range 处理回整包 200。
  let start = 0;
  let end = content.length - 1;
  const range = req.headers.range;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') {
      // 尾段：bytes=-N，取末尾 N 字节
      const suffix = Number(m[2]);
      start = Math.max(0, content.length - suffix);
      end = content.length - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? content.length - 1 : Number(m[2]);
    }

    if (start >= content.length || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${content.length}` });
      res.end();
      return;
    }
    if (end >= content.length) end = content.length - 1;

    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${content.length}`,
      'Content-Length': end - start + 1,
    });
    res.end(content.subarray(start, end + 1));
    return;
  }

  sendWithGzip(req, res, 200, headers, content, ext);
}

/**
 * 入口页识别：index.html → index.htm → default.html → 路径最浅的 html → 兜底 index.html。
 * 没带根 index.html 的模板包（如整包源码，首页散在子目录里）靠它落位；
 * 一次 listSiteFiles 把整站路径拉出来挑，不逐个试读 BLOB。
 */
async function pickEntryPath(siteId) {
  const files = await listSiteFiles(siteId);
  const names = new Set(files.map((f) => f.path));
  for (const c of ['index.html', 'index.htm', 'default.html']) {
    if (names.has(c)) return c;
  }

  let best = null;
  for (const f of files) {
    if (!/\.html?$/i.test(f.path)) continue;
    const depth = f.path.split('/').length;
    if (!best || depth < best.depth || (depth === best.depth && f.path < best.path)) {
      best = { path: f.path, depth };
    }
  }
  return best ? best.path : 'index.html';
}

async function handleSite(req, res, [username, name, rest = '']) {
  const site = await findSiteHeaderByUsername(username, name);

  if (!site) {
    sendHtml(res, 404, messagePage('404', `没有找到 /${username}/${name} 这个页面。`));
    return;
  }
  const isDraft = site.status === 'draft';

  if (site.status !== 'active') {
    if (!isDraft) {
      sendHtml(res, 451, messagePage('已下线', '这个页面已被管理员下线。'));
      return;
    }

    // 草稿只有作者本人（带自己的登录态）能看：工作区预览、封面都靠这条通道；
    // 对其他人一律当成「不存在」，别让草稿地址泄露出去。
    //
    // 但「作者」只能靠登录 Cookie 认，而站点是在沙箱 iframe 里跑的：沙箱文档的源
    // 是不透明的，它发出的请求（css / js / 图片 / 字体，以及站内跳转）会被算成跨站，
    // 浏览器按 SameSite=Lax 根本不会带 Cookie（实测 Sec-Fetch-Site: cross-site）。
    // 之前这里对每个请求都校验归属，导致草稿的每张 css / js / 图片都拿到 404，
    // 再被 ORB 拦成 ERR_BLOCKED_BY_ORB —— 用户看到的就是「样式和图片全没了」。
    //
    // 所以只在「有人直接拿地址访问这个草稿」时校验：顶层文档请求（地址栏 / 打开草稿）。
    // iframe 里的一切放行，子页面也才能正常点开；草稿站名是随机生成的（page-xxxxxxxx），
    // 外人本来就猜不到。
    const dest = req.headers['sec-fetch-dest'];
    const directOpen = dest === 'document' || (dest === undefined && (rest === '' || rest === '/'));
    if (directOpen && (await isSiteOwner(req, site)) === false) {
      sendHtml(res, 404, messagePage('404', `没有找到 /${username}/${name} 这个页面。`));
      return;
    }
  }

  // 让浏览器的最终 URL 与入口文件所在目录一致，相对 CSS/JS/图片才能正确解析。
  // 根目录入口需要结尾斜杠；子目录入口直接跳到真实文件路径。
  const url = new URL(req.url, 'http://internal');
  const isRoot = !rest || rest === '/';
  const entryPath = isRoot ? await pickEntryPath(site.id) : null;
  const filePath = isRoot ? entryPath : rest.slice(1);
  if (isRoot && (!url.pathname.endsWith('/') || filePath.includes('/'))) {
    // 子目录入口要跳到「/前缀/用户名/站名/实际入口路径」，别把站点那一段弄丢
    const target = filePath.includes('/')
      ? `/${USER_SPACE_PREFIX}/${username}/${name}/${filePath}`
      : `/${USER_SPACE_PREFIX}/${username}/${name}/`;
    sendRedirect(res, target + url.search);
    return;
  }

  // 子目录入口经过重定向后是文件 URL，直接访问或刷新它仍算一次浏览。
  // 非根请求也要把入口找回来（isRoot 分支里已经算过，不重复查库）。
  const isEntryRequest = isRoot
    || (/\.html?$/i.test(filePath) && filePath === await pickEntryPath(site.id));

  // 广场迷你封面专用（?mpcover=1）：给入口 HTML 注入滚动代理脚本，
  // 父页面才能 postMessage 驱动内部下翻；/view/ 等直接访问不带参，不受影响
  const forCover = isEntryRequest && url.searchParams.get('mpcover') === '1';

  const content = await getSiteFile(site.id, filePath);
  if (content) {
    // 浏览量简单版：只有入口页 +1，站内 css / js 等子资源不算；草稿不算浏览
    if (isEntryRequest && !isDraft) await incrementViews(site.id);
    serveSiteFile(req, res, filePath, forCover && /\.html?$/i.test(filePath) ? injectPeekProxy(content) : content);
    return;
  }

  // 老的「单 HTML 文件」站点：内容存在 sites.html 里，只兜入口页
  if (isRoot) {
    const legacy = await findSiteByUsername(username, name);
    if (legacy && legacy.html && legacy.html.trim() !== '') {
      if (!isDraft) await incrementViews(site.id);
      sendHtml(res, 200, forCover ? injectPeekProxy(legacy.html) : legacy.html, {
        'Content-Security-Policy': SANDBOX_CSP,
        'Cache-Control': 'no-cache',
      });
      return;
    }
  }

  sendHtml(res, 404, messagePage('404', `站点里没有这个文件：${filePath}`));
}

// ---------------------------------------------------------------- 路由表

// 用户空间前缀来自配置，路由用字符串拼出来，避免两处各写一遍 qwq
const P = USER_SPACE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ROUTES = [
  ['GET', /^\/$/, handleRoot],
  ['GET', /^\/upload$/, handleUploadPage],
  ['GET', new RegExp(`^\\/view\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/?$`), handleViewPage],
  ['GET', /^\/notifications$/, handleNotificationsPage],
  ['GET', /^\/favorites$/, handleFavoritesPage],
  ['GET', /^\/history$/, handleHistoryPage],
  ['GET', /^\/messages$/, handleMessagesPage],
  ['GET', /^\/login$/, handleLoginPage],
  ['GET', /^\/account$/, handleAccountPage],
  ['GET', /^\/sites$/, handleSitesPage],
  ['GET', /^\/new$/, handleStudioNewPage],
  ['GET', /^\/workspace\/([a-z0-9-]+)$/, handleWorkspacePage],
  ['GET', /^\/edit\/([a-z0-9-]+)$/, handleSiteEditPage],
  ['GET', /^\/admin$/, handleAdminPage],
  ['GET', /^\/settings$/, handleSettingsPage],
  ['GET', /^\/forgot$/, handleForgotPage],
  ['GET', /^\/_assets\/([a-zA-Z0-9._-]+)$/, handleAsset],

  ['GET', /^\/api\/me$/, handleMe],
  ['GET', /^\/api\/discover$/, handleDiscover],
  ['GET', /^\/api\/banners$/, handleBannersPublic],
  ['GET', new RegExp(`^\\/api\\/u\\/([a-z0-9-]+)\\/profile$`), handleCreatorProfile],
  ['GET', /^\/api\/notifications$/, handleNotificationsList],
  ['POST', /^\/api\/notifications\/seen$/, handleNotificationsSeen],
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
  ['POST', /^\/api\/account\/delete$/, handleAccountDelete],

  ['GET', /^\/api\/sites$/, handleMySites],
  ['POST', /^\/api\/upload$/, handleUpload],
  ['POST', /^\/api\/studio\/drafts$/, handleStudioDraftCreate],
  // 管理接口也带用户名：站名只在作者名下唯一，光凭站名定位不了
  ['GET', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)$`), handleSiteDetail],
  ['PUT', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)$`), handleSiteSaveHtml],
  ['PUT', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/meta$`), handleSiteSaveMeta],
  ['DELETE', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)$`), handleSiteDelete],
  ['GET', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/files$`), handleSiteFilesList],
  ['POST', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/files$`), handleSiteFileUpload],
  ['POST', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/zip$`), handleSiteZipUpload],
  ['GET', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/files\\/content$`), handleSiteFileContent],
  ['DELETE', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/files$`), handleSiteFileDelete],
  ['POST', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/publish$`), handleSitePublishDraft],
  ['GET', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/messages$`), handleSiteMessagesList],
  ['POST', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/messages$`), handleSiteMessageAdd],

  // 社区互动：站名只在作者名下唯一，所以公开接口一律带用户名
  ['GET', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/stats$`), handleSiteStats],
  ['POST', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/like$`), handleSiteLike],
  ['DELETE', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/like$`), handleSiteUnlike],
  ['GET', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/comments$`), handleSiteCommentsList],
  ['POST', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/comments$`), handleSiteCommentAdd],
  ['DELETE', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/comments\\/(\\d+)$`), handleSiteCommentDelete],
  ['POST', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/favorite$`), handleSiteFavorite],
  ['DELETE', new RegExp(`^\\/api\\/sites\\/([a-z0-9-]+)\\/([a-z0-9-]+)\\/favorite$`), handleSiteUnfavorite],
  ['POST', /^\/api\/users\/(\d+)\/follow$/, handleUserFollow],
  ['DELETE', /^\/api\/users\/(\d+)\/follow$/, handleUserUnfollow],
  ['GET', /^\/api\/users\/(\d+)\/social$/, handleUserSocial],
  ['GET', /^\/api\/users\/(\d+)\/follow-list$/, handleFollowList],
  ['GET', /^\/api\/users\/search$/, handleUserSearch],

  // 浏览历史 / 收藏夹 / 私信
  ['GET', /^\/api\/history$/, handleHistoryList],
  ['POST', /^\/api\/history$/, handleHistoryRecord],
  ['DELETE', /^\/api\/history$/, handleHistoryClear],
  ['DELETE', /^\/api\/history\/([a-z0-9-]+)\/([a-z0-9-]+)$/, handleHistoryDelete],
  ['GET', /^\/api\/favorites$/, handleFavoritesList],
  ['POST', /^\/api\/favorites\/batch$/, handleFavoritesBatch],
  ['GET', /^\/api\/favorite-folders$/, handleFavoriteFolders],
  ['POST', /^\/api\/favorite-folders$/, handleFavoriteFolderCreate],
  ['POST', /^\/api\/favorite-folders\/rename$/, handleFavoriteFolderRename],
  ['DELETE', /^\/api\/favorite-folders$/, handleFavoriteFolderDelete],
  ['GET', /^\/api\/messages$/, handleConversations],
  ['GET', /^\/api\/messages\/(\d+)$/, handleMessagesWith],
  ['POST', /^\/api\/messages\/(\d+)$/, handleMessageSend],

  ['GET', /^\/api\/admin\/users$/, handleAdminUsers],
  ['POST', /^\/api\/admin\/users\/(\d+)\/status$/, handleAdminUserStatus],
  ['GET', /^\/api\/admin\/sites$/, handleAdminSites],
  ['POST', /^\/api\/admin\/sites\/(\d+)\/status$/, handleAdminSiteStatus],
  ['DELETE', /^\/api\/admin\/sites\/(\d+)$/, handleAdminDeleteSite],
  ['GET', /^\/api\/admin\/banners$/, handleAdminBanners],
  ['POST', /^\/api\/admin\/banners$/, handleAdminBannerCreate],
  ['PUT', /^\/api\/admin\/banners\/(\d+)$/, handleAdminBannerUpdate],
  ['DELETE', /^\/api\/admin\/banners\/(\d+)$/, handleAdminBannerDelete],

  // MCP：运行时用密钥，管理用登录态，两条路互不相交
  ['POST', /^\/mcp$/, handleMcpPost],
  ['POST', /^\/mcp\/([A-Za-z0-9_-]+)$/, handleMcpPostWithKey],
  ['GET', /^\/api\/mcp\/tokens$/, handleMcpTokenList],
  ['POST', /^\/api\/mcp\/tokens$/, handleMcpTokenCreate],
  ['POST', /^\/api\/mcp\/tokens\/(\d+)\/revoke$/, handleMcpTokenRevoke],
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

  // MCP 只收 POST：其余方法明确回 405，免得掉进「用户站点」那条路变成误导性的 404
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    res.writeHead(405, {
      Allow: 'POST',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  // 平台自己的路由都没命中，最后才考虑用户空间
  if (req.method === 'GET') {
    // /<前缀>/<用户名> → 创作者主页（两段即主页，三段起是站点）
    const userSpace = pathname.match(new RegExp(`^\\/${P}\\/([a-z0-9-]+)\\/?$`));
    if (userSpace) {
      await handleUserPage(req, res);
      return;
    }

    // /<前缀>/<用户名>/<站名> 或 …/站内/相对/路径.css
    const m = pathname.match(new RegExp(`^\\/${P}\\/([a-z0-9-]+)\\/([a-z0-9-]+)(\\/.*)?$`));
    if (m) {
      await handleSite(req, res, [m[1], m[2], m[3] ?? '']);
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

server.listen(PORT, HOST, async () => {
  try {
    const removed = await deleteExpiredSessions();
    if (removed > 0) console.log(`清理了 ${removed} 条过期会话`);

    const created = await ensureAdminAccount();

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
  } catch (err) {
    console.error(`\n启动失败：数据库连不上或初始化出错（${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}）`);
    console.error(err?.message ?? err);
    process.exit(1);
  }
});
