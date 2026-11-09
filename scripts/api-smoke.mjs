// 全站接口冒烟测试（不含 MCP 协议层，那部分在 mcp-smoke.mjs）。
//
// 自己拉起一个临时服务来跑，用独立的冒烟库（MYSQL_DATABASE 指定，默认 minepage_smoke），
// 开跑前会清空库里的表，不碰生产库：
//
//   node scripts/api-smoke.mjs                  # 需要能连上 MySQL（读 MYSQL_* 环境变量）
//   node scripts/api-smoke.mjs --json           # 末尾多打印一段 JSON，便于两种库对比
//   BASE_URL=http://127.0.0.1:3100 node scripts/api-smoke.mjs   # 只跑测试，不拉服务
//
// 服务端的发信在开发模式下会把验证码打印到控制台，脚本从子进程输出里捞。

import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wantJson = args.includes('--json');

const PORT = Number(process.env.SMOKE_PORT ?? 3211);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;

// 管理员用环境变量指定，避免依赖种子账号 admin/123
const ADMIN_LOGIN = process.env.ADMIN_USERNAME ?? 'smokeadmin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'smoke-admin-pass';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'smoke-admin@test.local';

const A_EMAIL = 'smoke-a@test.local';
const B_EMAIL = 'smoke-b@test.local';
const C_EMAIL = 'smoke-c@test.local';
const PASS = 'smoke-pass-1';
const SITE = 'smoke-site';
const A_NAME = 'smoke-a';
const B_NAME = 'smoke-b';
const C_NAME = 'smoke-c';

// 站点地址现在挂在用户名下面：/qwq/<用户名>/<站名>
const pageUrl = (name = SITE, owner = A_NAME) => `/qwq/${owner}/${name}`;
const apiSite = (suffix = '', name = SITE, owner = A_NAME) => `/api/sites/${owner}/${name}${suffix}`;

// 每人站点配额，压小一点方便测到上限
const QUOTA = 4;

let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ detail: String(detail).slice(0, 200), name, ok: Boolean(ok) });
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { cookie, method = 'GET', body, raw, type, redirect } = {}) {
  const res = await fetch(BASE + pathname, {
    body:
      raw !== undefined
        ? raw
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    headers: {
      ...(raw === undefined && body === undefined ? {} : { 'Content-Type': type ?? 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method,
    redirect: redirect ?? 'follow',
  });
  if (redirect === 'manual') return { body: null, res, text: '' };
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { body: parsed, res, text };
}

function cookiesOf(res) {
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.map((c) => c.split(';')[0]).join('; ');
}

/** 取二进制响应（封面这类图片接口）。api() 会把 body 读成文本，不能走它。 */
async function apiBytes(pathname, { cookie, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    redirect: 'follow',
  });
  return { bytes: Buffer.from(await res.arrayBuffer()), res };
}

/** 直连冒烟库查一眼接口断言看不到的库内状态（比如外键级联是否真的清干净）。 */
async function dbQuery(sql, params = []) {
  const conn = await mysql.createConnection({
    database: smokeDb,
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    password: process.env.MYSQL_PASSWORD ?? '',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'minepage',
  });
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

async function login(loginValue, passwordValue) {
  const { body, res } = await api('/api/auth/login', {
    body: { login: loginValue, password: passwordValue },
    method: 'POST',
  });
  if (!body?.ok) throw new Error(`登录失败 ${loginValue}：${body?.message ?? res.status}`);
  return { cookie: cookiesOf(res), user: body.user };
}

// ---------------------------------------------------------------- 拉起服务

let child = null;
let output = '';
let codeCursor = 0;
let smokeDb = process.env.MYSQL_DATABASE ?? 'minepage_smoke';

async function boot() {
  if (process.env.BASE_URL) {
    console.log(`跑在已有服务上：${BASE}\n`);
    return;
  }

  // 清空冒烟库：把表全删掉，让服务端自己重建。关掉外键检查省得按顺序删。
  const conn = await mysql.createConnection({
    database: smokeDb,
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    password: process.env.MYSQL_PASSWORD ?? '',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'minepage',
  });
  const [tables] = await conn.query('SHOW TABLES');
  if (tables.length > 0) {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const row of tables) {
      const table = Object.values(row)[0];
      await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  await conn.end();

  const env = {
    ...process.env,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    ADMIN_USERNAME: ADMIN_LOGIN,
    HOST: '127.0.0.1',
    // 配额调小，冒烟里几次请求就能撞到上限
    MAX_SITES_PER_USER: String(QUOTA),
    // 热搜榜的生产默认缓存 5 分钟；冒烟要立刻看到写入结果，关掉缓存（0 = 每次重新算）
    HOT_CACHE_MS: '0',
    PORT: String(PORT),
    SMTP_HOST: '',
  };

  console.log(`拉起临时服务：PORT=${PORT} 库=${smokeDb}\n`);
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => {
    output += d.toString();
  });
  child.stderr.on('data', (d) => {
    output += d.toString();
  });

  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  for (let i = 0; i < 100; i += 1) {
    if (exited !== null) throw new Error(`服务启动就退出了（exit ${exited}）：\n${output.slice(-2000)}`);
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error(`等服务起来超时：\n${output.slice(-2000)}`);
}

async function shutdown() {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    // Windows 上进程没退干净时句柄还占着，等一下再收尾
    await Promise.race([exited, sleep(3000)]);
  }
}

/** 从服务端控制台输出里捞开发模式打印的验证码。 */
async function waitForCode(email, timeoutMs = 10000) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`收件人\\s+${escaped}[\\s\\S]*?你的验证码是 (\\d{6})`);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = output.slice(codeCursor).match(re);
    if (hit) {
      codeCursor += hit.index + hit[0].length;
      return hit[1];
    }
    await sleep(120);
  }
  throw new Error(`等不到 ${email} 的验证码`);
}

/** 发验证码 + 捞码 + 注册，返回登录态。 */
async function registerUser(email, username) {
  const sent = await api('/api/auth/send-code', { body: { email, purpose: 'register' }, method: 'POST' });
  if (sent.body?.ok !== true) throw new Error(`send-code 失败：${JSON.stringify(sent.body)}`);
  const code = await waitForCode(email);
  const reg = await api('/api/auth/register', { body: { code, email, password: PASS, username }, method: 'POST' });
  if (reg.body?.ok !== true) throw new Error(`注册失败：${JSON.stringify(reg.body)}`);
  return login(email, PASS);
}

// ---------------------------------------------------------------- 测试主体

async function run() {
  // ---------------------------------------------------------- 1. 页面与路由
  console.log('页面与路由');

  const home = await api('/');
  check('GET / 200', home.res.status === 200, `status=${home.res.status}`);

  const loginPage = await api('/login');
  check('GET /login 200', loginPage.res.status === 200, `status=${loginPage.res.status}`);

  const forgot = await api('/forgot');
  check('GET /forgot 200', forgot.res.status === 200, `status=${forgot.res.status}`);

  const sitesAnon = await api('/sites', { redirect: 'manual' });
  check(
    'GET /sites 未登录跳登录页并带回跳地址',
    sitesAnon.res.status === 302
    && sitesAnon.res.headers.get('location') === `/login?next=${encodeURIComponent('/sites')}`,
    `status=${sitesAnon.res.status} loc=${sitesAnon.res.headers.get('location')}`,
  );

  const favAnon = await api('/favorites', { redirect: 'manual' });
  check(
    'GET /favorites 未登录跳登录页且 next 指回原页面',
    favAnon.res.status === 302
    && favAnon.res.headers.get('location') === `/login?next=${encodeURIComponent('/favorites')}`,
    `status=${favAnon.res.status} loc=${favAnon.res.headers.get('location')}`,
  );

  const adminAnon = await api('/admin', { redirect: 'manual' });
  check('GET /admin 未登录跳登录页', adminAnon.res.status === 302, `status=${adminAnon.res.status}`);

  const uploadOld = await api('/upload', { redirect: 'manual' });
  check(
    'GET /upload 跳创作页投稿标签',
    uploadOld.res.status === 302 && uploadOld.res.headers.get('location') === '/sites?tab=upload',
    `status=${uploadOld.res.status} loc=${uploadOld.res.headers.get('location')}`,
  );

  const asset = await api('/_assets/style.css');
  check('GET /_assets/style.css 200', asset.res.status === 200, `status=${asset.res.status}`);

  const notFound = await api('/no-such-page-xyz');
  check('GET 不存在的路径 404', notFound.res.status === 404, `status=${notFound.res.status}`);

  // ---------------------------------------------------------- 2. 注册与验证码
  console.log('\n注册与验证码');

  const shortPass = await api('/api/auth/send-code', { body: { email: A_EMAIL, purpose: 'register' }, method: 'POST' });
  check('register 发码成功', shortPass.body?.ok === true, JSON.stringify(shortPass.body));
  check('register 发码在开发模式下带 dev 标记', shortPass.body?.dev === true, JSON.stringify(shortPass.body));

  const cooldown = await api('/api/auth/send-code', { body: { email: A_EMAIL, purpose: 'register' }, method: 'POST' });
  check('同邮箱 60 秒内重发被拒 429', cooldown.res.status === 429, `status=${cooldown.res.status}`);

  const codeA = await waitForCode(A_EMAIL);

  const noName = await api('/api/auth/register', {
    body: { code: codeA, email: A_EMAIL, password: PASS },
    method: 'POST',
  });
  check('注册不带用户名 → 400', noName.res.status === 400, `status=${noName.res.status}`);

  const badCode = await api('/api/auth/register', {
    body: { code: '000000', email: A_EMAIL, password: PASS, username: A_NAME },
    method: 'POST',
  });
  check('验证码错 → 400', badCode.res.status === 400, `status=${badCode.res.status}`);

  const weak = await api('/api/auth/register', {
    body: { code: codeA, email: A_EMAIL, password: '123', username: A_NAME },
    method: 'POST',
  });
  check('密码太短 → 400', weak.res.status === 400, `status=${weak.res.status}`);

  const registerA = await api('/api/auth/register', {
    body: { code: codeA, email: A_EMAIL, password: PASS, username: A_NAME },
    method: 'POST',
  });
  check('注册成功', registerA.body?.ok === true, JSON.stringify(registerA.body));
  check('注册响应里不含 password_hash', !JSON.stringify(registerA.body).includes('password_hash'));
  check('注册后用户名已定', registerA.body?.user?.username === A_NAME, JSON.stringify(registerA.body?.user));

  const dupe = await api('/api/auth/send-code', { body: { email: A_EMAIL, purpose: 'register' }, method: 'POST' });
  check('已注册邮箱再发码 → 409', dupe.res.status === 409, `status=${dupe.res.status}`);

  const a = await login(A_EMAIL, PASS);
  const me = await api('/api/me', { cookie: a.cookie });
  check('GET /api/me 是刚注册的账号', me.body?.user?.email === A_EMAIL, JSON.stringify(me.body?.user));
  check('新账号默认不是管理员', me.body?.user?.isAdmin === false, JSON.stringify(me.body?.user));
  check('GET /api/me 不含 password_hash', !JSON.stringify(me.body).includes('password_hash'));

  const b = await registerUser(B_EMAIL, B_NAME);
  check('第二个账号注册成功', Boolean(b.cookie), B_EMAIL);

  const badLogin = await api('/api/auth/login', { body: { login: A_EMAIL, password: 'wrong-pass' }, method: 'POST' });
  check('密码错 → 401', badLogin.res.status === 401, `status=${badLogin.res.status}`);

  // ---------------------------------------------------------- 3. 用户名与资料
  console.log('\n用户名与资料');

  const shortName = await api('/api/account/username', { body: { username: 'ab' }, cookie: a.cookie, method: 'POST' });
  check('用户名太短 → 400', shortName.res.status === 400, `status=${shortName.res.status}`);

  const emptyName = await api('/api/account/username', { body: { username: '' }, cookie: a.cookie, method: 'POST' });
  check('用户名不能清空 → 400', emptyName.res.status === 400, `status=${emptyName.res.status}`);

  const reservedName = await api('/api/account/username', { body: { username: ADMIN_LOGIN }, cookie: a.cookie, method: 'POST' });
  check('用户名被占用 → 409', reservedName.res.status === 409, `status=${reservedName.res.status}`);

  const setBio = await api('/api/account/bio', { body: { bio: '我是冒烟测试账号' }, cookie: a.cookie, method: 'POST' });
  check('设置简介成功', setBio.body?.ok === true, JSON.stringify(setBio.body));

  const meAfter = await api('/api/me', { cookie: a.cookie });
  check('用户名与简介读回一致', meAfter.body?.user?.username === A_NAME && meAfter.body?.user?.bio === '我是冒烟测试账号', JSON.stringify(meAfter.body?.user));

  const profile = await api('/api/u/smoke-a/profile');
  check('创作者主页接口 200', profile.res.status === 200, `status=${profile.res.status}`);

  const userSpace = await api(`/qwq/${A_NAME}`);
  check('用户空间入口直接返回主页（不再 302 到 /u/）', userSpace.res.status === 200, `status=${userSpace.res.status}`);
  check(
    '旧的 /u/ 地址已不再单独存在',
    (await api(`/u/${A_NAME}`)).res.status === 404,
  );

  // ---------------------------------------------------------- 4. 站点与文件
  console.log('\n站点与文件');

  const shortSite = await api('/api/upload', { body: { html: '<p>x</p>', name: 'ab' }, cookie: a.cookie, method: 'POST' });
  check('站名太短 → 400', shortSite.res.status === 400, `status=${shortSite.res.status}`);

  const anonUpload = await api('/api/upload', { body: { html: '<p>x</p>', name: 'nobody-site' }, method: 'POST' });
  check('未登录上传 → 401', anonUpload.res.status === 401, `status=${anonUpload.res.status}`);

  // ZIP 整包发布：解压 → 事务内建站 + 写文件，任何一步失败都不留半个站点
  const badZip = await api(apiSite(`/zip`, 'smoke-zip-invalid'), {
    cookie: a.cookie, method: 'POST', raw: Buffer.from('not a zip'), type: 'application/zip',
  });
  check('无效 ZIP 返回 400', badZip.res.status === 400, `status=${badZip.res.status}`);
  const missingBadZip = await api(apiSite('', 'smoke-zip-invalid'), { cookie: a.cookie });
  check('无效 ZIP 不创建站点', missingBadZip.res.status === 404, `status=${missingBadZip.res.status}`);

  // 只有 .DS_Store 这类垃圾条目 → 一个可用文件都没有
  const skippedZip = Buffer.from('UEsDBBQAAAAAAJKrS105nPsGBAAAAAQAAAAJAAAALkRTX1N0b3JlanVua1BLAQIUABQAAAAAAJKrS105nPsGBAAAAAQAAAAJAAAAAAAAAAAAAACAAQAAAAAuRFNfU3RvcmVQSwUGAAAAAAEAAQA3AAAAKwAAAAAA', 'base64');
  const noFiles = await api(apiSite(`/zip`, 'smoke-zip-empty'), {
    cookie: a.cookie, method: 'POST', raw: skippedZip, type: 'application/zip',
  });
  check('全被跳过的 ZIP 返回 400', noFiles.res.status === 400, `status=${noFiles.res.status}`);
  const missingEmptyZip = await api(apiSite('', 'smoke-zip-empty'), { cookie: a.cookie });
  check('全被跳过的 ZIP 不创建站点', missingEmptyZip.res.status === 404, `status=${missingEmptyZip.res.status}`);

  // index.html + assets/a.css 两个条目
  const goodZip = Buffer.from('UEsDBBQAAAAAAI2rS10Zc+inDwAAAA8AAAAKAAAAaW5kZXguaHRtbDxoMT56aXAtb2s8L2gxPlBLAwQUAAAAAACNq0tdWXGH4gYAAAAGAAAADAAAAGFzc2V0cy9hLmNzc2JvZHl7fVBLAQIUABQAAAAAAI2rS10Zc+inDwAAAA8AAAAKAAAAAAAAAAAAAACAAQAAAABpbmRleC5odG1sUEsBAhQAFAAAAAAAjatLXVlxh+IGAAAABgAAAAwAAAAAAAAAAAAAAIABNwAAAGFzc2V0cy9hLmNzc1BLBQYAAAAAAgACAHIAAABnAAAAAAA=', 'base64');
  const goodZipUpload = await api(apiSite(`/zip`, 'smoke-zip-good'), {
    cookie: a.cookie, method: 'POST', raw: goodZip, type: 'application/zip',
  });
  check('有效 ZIP 发布 2 个文件', goodZipUpload.res.status === 201 && goodZipUpload.body?.saved === 2,
    `status=${goodZipUpload.res.status} ${JSON.stringify(goodZipUpload.body)}`);
  const goodZipPage = await api(pageUrl('smoke-zip-good'));
  check('ZIP 首页可访问', goodZipPage.res.status === 200 && goodZipPage.text.includes('zip-ok'));
  await api(apiSite('', 'smoke-zip-good'), { cookie: a.cookie, method: 'DELETE' });

  // 子目录入口：根地址要跳到真实入口文件，相对资源与封面代理都跟着走
  const nestedName = 'smoke-nested-entry';
  const nestedHtml = '<!doctype html><head><link rel="stylesheet" href="assets/a.css"></head><h1>nested-ok</h1>';
  const nestedIndex = await api(apiSite(`/files?path=dist/index.html`, nestedName), {
    cookie: a.cookie, method: 'POST', raw: nestedHtml, type: 'application/octet-stream',
  });
  const nestedCss = await api(apiSite(`/files?path=dist/assets/a.css`, nestedName), {
    cookie: a.cookie, method: 'POST', raw: 'body{color:red}', type: 'application/octet-stream',
  });
  check('子目录入口与资源上传成功', nestedIndex.res.status === 201 && nestedCss.res.status === 201,
    `index=${nestedIndex.res.status} css=${nestedCss.res.status}`);
  const nestedRedirect = await api(`${pageUrl(nestedName)}/?mpcover=1`, { redirect: 'manual' });
  check('根地址跳转到真实入口且保留封面参数',
    nestedRedirect.res.status === 302
    && nestedRedirect.res.headers.get('location') === `${pageUrl(nestedName)}/dist/index.html?mpcover=1`,
    nestedRedirect.res.headers.get('location'));
  const nestedNoSlash = await api(pageUrl(nestedName), { redirect: 'manual' });
  check('无斜杠地址也跳转到真实入口',
    nestedNoSlash.res.status === 302
    && nestedNoSlash.res.headers.get('location') === `${pageUrl(nestedName)}/dist/index.html`,
    nestedNoSlash.res.headers.get('location'));
  const nestedPage = await api(`${pageUrl(nestedName)}/`);
  check('子目录首页可访问且最终地址正确', nestedPage.res.status === 200
    && nestedPage.text.includes('nested-ok')
    && new URL(nestedPage.res.url).pathname === `${pageUrl(nestedName)}/dist/index.html`);
  const nestedCssPath = new URL('assets/a.css', nestedPage.res.url).pathname;
  const resolvedCss = await api(nestedCssPath);
  check('子目录首页的相对 CSS 可访问', nestedCssPath === `${pageUrl(nestedName)}/dist/assets/a.css`
    && resolvedCss.res.status === 200 && resolvedCss.text === 'body{color:red}');
  const nestedCover = await api(`${pageUrl(nestedName)}/?mpcover=1`);
  check('子目录封面仍注入滚动代理', nestedCover.res.status === 200 && nestedCover.text.includes('mpReady'));
  const nestedViews = await api(apiSite('/stats', nestedName));
  check('两次入口请求各只增加一次浏览', nestedViews.body?.stats?.views === 2,
    JSON.stringify(nestedViews.body?.stats));
  await api(`${pageUrl(nestedName)}/dist/index.html`);
  const refreshedViews = await api(apiSite('/stats', nestedName));
  check('直接刷新子目录入口仍计一次浏览', refreshedViews.body?.stats?.views === 3,
    JSON.stringify(refreshedViews.body?.stats));
  await api(apiSite('', nestedName), { cookie: a.cookie, method: 'DELETE' });

  const html1 = '<!doctype html><meta charset="utf-8"><title>冒烟</title><h1>第一版</h1>';
  const upload = await api('/api/upload', { body: { html: html1, name: SITE }, cookie: a.cookie, method: 'POST' });
  check('上传站点 201', upload.res.status === 201, `status=${upload.res.status} ${JSON.stringify(upload.body)}`);
  check('返回可访问地址', upload.body?.url === `http://127.0.0.1:${PORT}${pageUrl()}`, upload.body?.url);
  check('旧式 /站名 地址不再可用', (await api(`/${SITE}`)).res.status === 404);

  const dupeSite = await api('/api/upload', { body: { html: html1, name: SITE }, cookie: a.cookie, method: 'POST' });
  check('同名重传 → 409', dupeSite.res.status === 409, `status=${dupeSite.res.status}`);

  // 站名只在用户名下面唯一：换个作者能用同一个站名
  const sameNameOther = await api('/api/upload', { body: { html: '<h1>b 的同一站名</h1>', name: SITE }, cookie: b.cookie, method: 'POST' });
  check('别人可以用同一个站名', sameNameOther.res.status === 201, `status=${sameNameOther.res.status} ${JSON.stringify(sameNameOther.body)}`);
  check('两人的同名站各走各的地址', (await api(pageUrl(SITE, B_NAME))).text.includes('b 的同一站名'));

  const page = await api(pageUrl());
  check('站点页面 200', page.res.status === 200, `status=${page.res.status}`);
  check('站点页面内容正确', page.text.includes('第一版'));
  const csp = page.res.headers.get('content-security-policy') ?? '';
  check('站点页面带 sandbox CSP', csp.includes('sandbox'), csp);
  check('CSP 不含 allow-same-origin', !csp.includes('allow-same-origin'), csp);

  const mySites = await api('/api/sites', { cookie: a.cookie });
  check('我的站点列表里有它', mySites.body?.sites?.some((s) => s.name === SITE), JSON.stringify(mySites.body?.sites?.map((s) => s.name)));

  // 投稿页在站点还不存在的时候就要能选内容标签，所以词表跟着「我的站点」一起下发：
  // 只给登录用户，未登录的 401 响应里不能漏出来。
  const SITE_TAG_KEYS = ['resume', 'portfolio', 'social', 'blog', 'event', 'opensource', 'docs', 'other'];
  const myTags = mySites.body?.tags;
  check(
    '我的站点列表带 tags 且是 8 项',
    Array.isArray(myTags) && myTags.length === SITE_TAG_KEYS.length,
    `type=${Array.isArray(myTags) ? 'array' : typeof myTags} len=${myTags?.length}`,
  );
  check(
    'tags 每项都有非空字符串 key 与 label',
    Array.isArray(myTags)
    && myTags.every((t) => typeof t?.key === 'string' && t.key !== '' && typeof t?.label === 'string' && t.label !== ''),
    JSON.stringify(myTags),
  );
  check(
    'tags 里没有前端伪标签 hot',
    Array.isArray(myTags) && !myTags.some((t) => t.key === 'hot'),
    JSON.stringify(myTags?.map((t) => t.key)),
  );
  check(
    'tags 的 key 集合与 SITE_TAGS 完全一致',
    Array.isArray(myTags) && new Set(myTags.map((t) => t.key)).size === SITE_TAG_KEYS.length
    && SITE_TAG_KEYS.every((k) => myTags.some((t) => t.key === k)),
    JSON.stringify(myTags?.map((t) => t.key)),
  );
  const anonMySites = await api('/api/sites');
  check(
    '未登录 GET /api/sites 仍是 401 且不带 tags',
    anonMySites.res.status === 401 && !Object.hasOwn(anonMySites.body ?? {}, 'tags'),
    `status=${anonMySites.res.status} keys=${JSON.stringify(Object.keys(anonMySites.body ?? {}))}`,
  );

  const detail = await api(apiSite(), { cookie: a.cookie });
  check('站点详情 200', detail.res.status === 200, `status=${detail.res.status}`);

  const html2 = '<!doctype html><meta charset="utf-8"><title>冒烟</title><h1>第二版</h1>';
  const saveHtml = await api(apiSite(), { body: { html: html2 }, cookie: a.cookie, method: 'PUT' });
  check('保存单页 HTML 成功', saveHtml.body?.ok === true, JSON.stringify(saveHtml.body));
  const page2 = await api(pageUrl());
  check('重新访问看到第二版', page2.text.includes('第二版'));

  const saveMeta = await api(apiSite(`/meta`), {
    body: { description: '冒烟测试用的站点', tag: 'docs', title: '冒烟站点' },
    cookie: a.cookie,
    method: 'PUT',
  });
  check('保存站点信息成功', saveMeta.body?.ok === true, JSON.stringify(saveMeta.body));

  const badTag = await api(apiSite(`/meta`), {
    body: { description: 'x', tag: '随便写的标签', title: 'x' },
    cookie: a.cookie,
    method: 'PUT',
  });
  check('非法内容标签 → 400', badTag.body?.ok === false && badTag.res.status === 400, `status=${badTag.res.status} ${JSON.stringify(badTag.body)}`);

  const detail2 = await api(apiSite(), { cookie: a.cookie });
  const metaOk =
    detail2.body?.site?.title === '冒烟站点' &&
    detail2.body?.site?.description === '冒烟测试用的站点' &&
    detail2.body?.site?.tag === 'docs' &&
    detail2.body?.site?.tagLabel === '学习笔记';
  check('站点信息读回一致（含 tagLabel）', metaOk, JSON.stringify(detail2.body?.site));

  const fileHtml = '<!doctype html><meta charset="utf-8"><title>子页</title><p>子页面内容</p>';
  const putIndex = await api(apiSite(`/files?path=index.html`), {
    cookie: a.cookie,
    method: 'POST',
    raw: fileHtml,
    type: 'text/html; charset=utf-8',
  });
  check('上传 index.html 成功', putIndex.res.status === 201 || putIndex.res.status === 200, `status=${putIndex.res.status}`);

  const css = 'body { color: rgb(1, 2, 3); }';
  const putCss = await api(apiSite(`/files?path=assets/a.css`), {
    cookie: a.cookie,
    method: 'POST',
    raw: css,
    type: 'text/css; charset=utf-8',
  });
  check('上传子目录文件成功', putCss.res.status === 201 || putCss.res.status === 200, `status=${putCss.res.status}`);

  const files = await api(apiSite(`/files`), { cookie: a.cookie });
  const fileList = files.body?.files ?? [];
  check('文件列表 2 个', fileList.length === 2, JSON.stringify(fileList.map((f) => f.path)));
  check('文件带大小字段', fileList.every((f) => typeof f.size === 'number' && f.size > 0), JSON.stringify(fileList));

  const content = await api(apiSite(`/files/content?path=index.html`), { cookie: a.cookie });
  check('读回文件内容一致', content.body?.content === fileHtml, JSON.stringify(content.body?.content?.slice(0, 60)));

  const serveIndex = await api(`${pageUrl()}/index.html`);
  check('子页面可访问且内容一致', serveIndex.res.status === 200 && serveIndex.text === fileHtml, `status=${serveIndex.res.status}`);
  const serveCss = await api(`${pageUrl()}/assets/a.css`);
  check('子目录静态文件可访问', serveCss.res.status === 200 && serveCss.text === css, `status=${serveCss.res.status}`);
  check('CSS 这类非文档资源不套沙箱头（不必要）', !serveCss.res.headers.get('content-security-policy'), serveCss.res.headers.get('content-security-policy') ?? '');

  // svg 能带脚本，必须和 html 一样关进沙箱
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
  await api(apiSite(`/files?path=assets/icon.svg`), {
    cookie: a.cookie,
    method: 'POST',
    raw: svg,
    type: 'image/svg+xml',
  });
  const serveSvg = await api(`${pageUrl()}/assets/icon.svg`);
  const svgCsp = serveSvg.res.headers.get('content-security-policy') ?? '';
  check('svg 也带 sandbox CSP', serveSvg.res.status === 200 && svgCsp.includes('sandbox'), `status=${serveSvg.res.status} ${svgCsp}`);
  check('svg 的 CSP 同样不含 allow-same-origin', !svgCsp.includes('allow-same-origin'), svgCsp);

  const traversal = await api(apiSite(`/files?path=../evil.html`), {
    cookie: a.cookie,
    method: 'POST',
    raw: 'x',
    type: 'text/html',
  });
  check('路径穿越被拒', traversal.res.status >= 400, `status=${traversal.res.status}`);

  // 单页 HTML 上限 5 MB（对应用户看到的「单页 ≤ 5 MB」）
  const bigHtml = `<p>${'x'.repeat(5 * 1024 * 1024)}</p>`;
  const tooBig = await api('/api/upload', { body: { html: bigHtml, name: 'smoke-too-big' }, cookie: a.cookie, method: 'POST' });
  check('单页上传超过 5MB → 413', tooBig.res.status === 413, `status=${tooBig.res.status}`);

  // 多页单文件上限 10 MB：9 MB 合法，11 MB 必须被拒（MEDIUMBLOB 的 16 MB 硬顶之内）
  const hugeFile = `<p>${'y'.repeat(9 * 1024 * 1024)}</p>`;
  const huge = await api(apiSite(`/files?path=huge.html`), {
    cookie: a.cookie,
    method: 'POST',
    raw: hugeFile,
    type: 'text/html',
  });
  check('多文件站点 9MB 文件可上传（上限 10MB）', huge.res.status === 201, `status=${huge.res.status}`);
  const removeHuge = await api(apiSite(`/files?path=huge.html`), { cookie: a.cookie, method: 'DELETE' });
  check('大文件可删除以恢复文件列表', removeHuge.body?.ok === true, JSON.stringify(removeHuge.body));

  const overFile = `<p>${'z'.repeat(11 * 1024 * 1024)}</p>`;
  const overFileRes = await api(apiSite(`/files?path=over.html`), {
    cookie: a.cookie,
    method: 'POST',
    raw: overFile,
    type: 'text/html',
  });
  check('多文件站点 11MB 文件被拒 → 413', overFileRes.res.status === 413, `status=${overFileRes.res.status}`);

  // 单站总量 50 MB：拿 10 MB 的文件刷到超限，第 5 个必被拒（4×10 + 已有内容 ≈ 40 MB 起）
  const chunk = 'w'.repeat(10 * 1024 * 1024 - 16);
  let siteFilled = 0;
  for (let i = 1; i <= 4; i += 1) {
    const fill = await api(apiSite(`/files?path=fill-${i}.html`), {
      cookie: a.cookie, method: 'POST', raw: chunk, type: 'text/html',
    });
    if (fill.res.status === 201) siteFilled += 1;
  }
  check('单站容量填充 4 个 10MB 文件成功', siteFilled === 4, `filled=${siteFilled}`);
  const overSite = await api(apiSite(`/files?path=fill-5.html`), {
    cookie: a.cookie, method: 'POST', raw: chunk, type: 'text/html',
  });
  check(
    '单站总量超过 50MB → 413 且提示站点上限',
    overSite.res.status === 413 && String(overSite.body?.message).includes('站点总容量'),
    `status=${overSite.res.status} ${JSON.stringify(overSite.body)}`,
  );
  for (let i = 1; i <= 4; i += 1) {
    await api(apiSite(`/files?path=fill-${i}.html`), { cookie: a.cookie, method: 'DELETE' });
  }

  // 上限随接口下发，前端文案和预检都靠它（别再让页面各写一份数字）
  const limitsPayload = (await api('/api/sites', { cookie: a.cookie })).body?.limits;
  check(
    'GET /api/sites 下发 limits',
    limitsPayload?.htmlBytes === 5 * 1024 * 1024
    && limitsPayload?.fileBytes === 10 * 1024 * 1024
    && limitsPayload?.filesPerSite === 200
    && limitsPayload?.siteTotalBytes === 50 * 1024 * 1024
    && limitsPayload?.userTotalBytes === 100 * 1024 * 1024
    && typeof limitsPayload?.storageUsedBytes === 'number',
    JSON.stringify(limitsPayload),
  );

  // 浏览计数：连续访问两次
  await api(pageUrl());
  await api(pageUrl());
  const stats = await api(apiSite(`/stats`), { cookie: a.cookie });
  check('浏览计数是数字', typeof stats.body?.stats?.views === 'number', JSON.stringify(stats.body?.stats));
  check('浏览计数累计到 2 以上', (stats.body?.stats?.views ?? 0) >= 2, JSON.stringify(stats.body?.stats));

  // 卡片自定义封面：一站一张图，读公开 / 写要作者，换图后 ETag 跟着变。
  // 图片字节必须是常量，别去读 public/ 里的资产（那些以后可能被换掉）。
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const coverApi = (name = SITE, owner = A_NAME) => apiSite('/cover', name, owner);

  const coverDetailBefore = await api(apiSite(), { cookie: a.cookie });
  const coverSiteId = coverDetailBefore.body?.site?.id;
  check(
    '站点详情初始 hasCover=false',
    coverDetailBefore.body?.site?.hasCover === false,
    `id=${coverSiteId} hasCover=${JSON.stringify(coverDetailBefore.body?.site?.hasCover)}`,
  );

  const coverAnonPut = await api(coverApi(), { method: 'PUT', raw: PNG_1X1, type: 'image/png' });
  check('未登录上传封面 → 401', coverAnonPut.res.status === 401, `status=${coverAnonPut.res.status}`);

  const coverOtherPut = await api(coverApi(), { cookie: b.cookie, method: 'PUT', raw: PNG_1X1, type: 'image/png' });
  check('别人上传封面 → 403', coverOtherPut.res.status === 403, `status=${coverOtherPut.res.status}`);

  // 内容类型由文件头决定：声明 image/png 但内容不是图片，照样要拒
  const coverTextPut = await api(coverApi(), {
    cookie: a.cookie, method: 'PUT', raw: Buffer.from('这不是图片'), type: 'image/png',
  });
  check(
    '纯文本冒充 PNG 上传 → 400',
    coverTextPut.res.status === 400,
    `status=${coverTextPut.res.status} ${JSON.stringify(coverTextPut.body)}`,
  );

  const coverPut = await api(coverApi(), { cookie: a.cookie, method: 'PUT', raw: PNG_1X1, type: 'image/png' });
  check(
    '上传 1×1 PNG 封面成功且 size 正确',
    coverPut.res.status === 200 && coverPut.body?.ok === true && coverPut.body?.size === PNG_1X1.length,
    `status=${coverPut.res.status} ${JSON.stringify(coverPut.body)} 期望 size=${PNG_1X1.length}`,
  );

  const coverGet = await apiBytes(coverApi());
  check(
    'GET 封面 200 且类型是 image/png',
    coverGet.res.status === 200 && coverGet.res.headers.get('content-type') === 'image/png',
    `status=${coverGet.res.status} ct=${coverGet.res.headers.get('content-type')}`,
  );
  check(
    'GET 封面字节与原图一致（比 Buffer）',
    coverGet.bytes.length === PNG_1X1.length && coverGet.bytes.equals(PNG_1X1),
    `len=${coverGet.bytes.length}/${PNG_1X1.length} 前 8 字节=${coverGet.bytes.subarray(0, 8).toString('hex')}`,
  );

  const coverEtag = coverGet.res.headers.get('etag') ?? '';
  check(
    '封面带 ETag + no-cache + nosniff + Content-Length',
    Boolean(coverEtag)
    && coverGet.res.headers.get('cache-control') === 'no-cache'
    && coverGet.res.headers.get('x-content-type-options') === 'nosniff'
    && coverGet.res.headers.get('content-length') === String(PNG_1X1.length),
    `etag=${coverEtag} cc=${coverGet.res.headers.get('cache-control')}`
    + ` nosniff=${coverGet.res.headers.get('x-content-type-options')}`
    + ` len=${coverGet.res.headers.get('content-length')}`,
  );

  const coverNotModified = await apiBytes(coverApi(), { headers: { 'If-None-Match': coverEtag } });
  check('If-None-Match 命中回 304', coverNotModified.res.status === 304, `status=${coverNotModified.res.status} etag=${coverEtag}`);

  const coverDetailAfter = await api(apiSite(), { cookie: a.cookie });
  check(
    '上传后站点详情 hasCover=true',
    coverDetailAfter.body?.site?.hasCover === true,
    `hasCover=${JSON.stringify(coverDetailAfter.body?.site?.hasCover)}`,
  );

  const coverDiscover = await api('/api/discover');
  // 站名可以被不同作者复用，所以要按 author.username 一起挑，别只按 name 撞运气
  const coverDiscoverCard = coverDiscover.body?.sites?.find(
    (s) => s.name === SITE && s.author?.username === A_NAME,
  );
  check(
    '发现流卡片 hasCover=true',
    coverDiscoverCard?.hasCover === true,
    `card=${JSON.stringify(coverDiscoverCard && { author: coverDiscoverCard.author?.username, hasCover: coverDiscoverCard.hasCover })}`,
  );

  const coverProfile = await api(`/api/u/${A_NAME}/profile`);
  check(
    '创作者主页卡片 hasCover=true',
    coverProfile.body?.sites?.find((s) => s.name === SITE)?.hasCover === true,
    JSON.stringify(coverProfile.body?.sites?.find((s) => s.name === SITE)?.hasCover),
  );

  // 每人总量 100 MB：单站上限是 50 MB，所以要用两个站才撞得到账号这道闸。
  const quotaAccount = await registerUser('smoke-storage@test.local', 'smoke-storage');
  const storageChunk = 'q'.repeat(10 * 1024 * 1024 - 16);

  const fillSite = async (siteName) => {
    let saved = 0;
    for (let i = 1; i <= 5; i += 1) {
      const put = await api(apiSite(`/files?path=bulk-${i}.html`, siteName, 'smoke-storage'), {
        cookie: quotaAccount.cookie, method: 'POST', raw: storageChunk, type: 'text/html',
      });
      if (put.res.status === 201 || put.res.status === 200) saved += 1;
    }
    return saved;
  };

  check('第一个站灌满 5 × 10MB', await fillSite('storage-a') === 5);
  check('第二个站灌满 5 × 10MB（账号共约 100MB）', await fillSite('storage-b') === 5);

  const overUser = await api(apiSite(`/files?path=bulk-1.html`, 'storage-c', 'smoke-storage'), {
    cookie: quotaAccount.cookie, method: 'POST', raw: storageChunk, type: 'text/html',
  });
  check(
    '账号总量超过 100MB → 413 且提示账号上限',
    overUser.res.status === 413 && String(overUser.body?.message).includes('账号总容量'),
    `status=${overUser.res.status} ${JSON.stringify(overUser.body)}`,
  );

  // 把文件换成更小的版本永远允许（日常维护不能被打断）
  const shrink = await api(apiSite(`/files?path=bulk-1.html`, 'storage-a', 'smoke-storage'), {
    cookie: quotaAccount.cookie, method: 'POST', raw: '<h1>shrink</h1>', type: 'text/html',
  });
  check('把文件换成更小版本仍然成功', shrink.res.status === 200, `status=${shrink.res.status}`);

  // 存量超限的例外：API 进不来（本来就挡），所以直接往库里造一条「已经 110MB」的旧状态
  // （模拟模板导入的站），验证它仍能把文件换成更小的版本。
  // 必须超过 100MB 的账号上限才落在那条分支上；60MB 还在单站 50MB 之内，撞不到。
  await dbQuery(
    `INSERT INTO sites (name, owner_id, html, size, status, created_at, updated_at)
     SELECT 'legacy-big', id, '', 0, 'active', ?, ? FROM users WHERE username = 'smoke-storage'`,
    [new Date().toISOString(), new Date().toISOString()],
  );
  await dbQuery(
    `INSERT INTO site_files (site_id, path, content, size, updated_at)
     SELECT s.id, 'big.bin', '', 110 * 1024 * 1024, ? FROM sites s WHERE s.name = 'legacy-big'`,
    [new Date().toISOString()],
  );
  // 先测「再增内容被拒」：换小文件会让这个站不再超限，顺序反过来就测不到存量超限的状态了。
  const legacyGrow = await api(apiSite(`/files?path=more.html`, 'legacy-big', 'smoke-storage'), {
    cookie: quotaAccount.cookie, method: 'POST', raw: storageChunk, type: 'text/html',
  });
  check('存量已超限的站点再增内容 → 413', legacyGrow.res.status === 413, `status=${legacyGrow.res.status} ${JSON.stringify(legacyGrow.body)}`);
  const legacyShrink = await api(apiSite(`/files?path=big.bin`, 'legacy-big', 'smoke-storage'), {
    cookie: quotaAccount.cookie, method: 'POST', raw: '<h1>small</h1>', type: 'text/html',
  });
  check('存量已超限的站点仍可把文件换成更小的版本', legacyShrink.res.status === 200, `status=${legacyShrink.res.status}`);

  // 回归：账号已用量必须逐站聚合 —— 单页站的 sites.size 和多页站的文件不能「取大」了事。
  // 造一个同时有单页站和多页站的账号，确认 storageUsedBytes 把两者都算进去。
  const mixedAccount = await registerUser('smoke-mixed@test.local', 'smoke-mixed');
  const singleHtml = `<p>${'s'.repeat(3 * 1024 * 1024)}</p>`;
  await api('/api/upload', { body: { html: singleHtml, name: 'mixed-single' }, cookie: mixedAccount.cookie, method: 'POST' });
  await api(apiSite(`/files?path=index.html`, 'mixed-multi', 'smoke-mixed'), {
    cookie: mixedAccount.cookie, method: 'POST', raw: storageChunk, type: 'text/html',
  });
  const mixedUsed = (await api('/api/sites', { cookie: mixedAccount.cookie })).body?.limits?.storageUsedBytes ?? 0;
  check(
    '账号已用量逐站聚合（单页 3MB + 多页 10MB ≈ 13MB，不能被取大吞掉）',
    mixedUsed > 12 * 1024 * 1024 && mixedUsed < 14 * 1024 * 1024,
    `used=${mixedUsed} (${(mixedUsed / 1024 / 1024).toFixed(1)}MB)`,
  );

  const coverMySites = await api('/api/sites', { cookie: a.cookie });
  check(
    '我的站点列表 hasCover=true',
    coverMySites.body?.sites?.find((s) => s.name === SITE)?.hasCover === true,
    JSON.stringify(coverMySites.body?.sites?.find((s) => s.name === SITE)?.hasCover),
  );

  // 2MB 上限：多一个字节就该被 readFileBody 挡在 413（不会走到类型嗅探）
  const coverTooBigBytes = Buffer.concat([PNG_1X1, Buffer.alloc(2 * 1024 * 1024)]);
  const coverTooBig = await api(coverApi(), {
    cookie: a.cookie, method: 'PUT', raw: coverTooBigBytes, type: 'image/png',
  });
  check(
    '封面超过 2MB → 413',
    coverTooBig.res.status === 413,
    `status=${coverTooBig.res.status} len=${coverTooBigBytes.length}`,
  );

  // 下线站点要用管理员接口：这里自己拿一次管理员 cookie，别依赖后面第 7 节
  const coverAdmin = await login(ADMIN_LOGIN, ADMIN_PASSWORD);
  const coverOffline = await api(`/api/admin/sites/${coverSiteId}/status`, {
    body: { status: 'offline' }, cookie: coverAdmin.cookie, method: 'POST',
  });
  check('下线站点成功（封面用）', coverOffline.body?.ok === true, `status=${coverOffline.res.status} ${JSON.stringify(coverOffline.body)}`);

  const coverGetOffline = await apiBytes(coverApi());
  check(
    '站点下线后封面 404',
    coverGetOffline.res.status === 404,
    `status=${coverGetOffline.res.status} siteId=${coverSiteId}`,
  );

  const coverOnline = await api(`/api/admin/sites/${coverSiteId}/status`, {
    body: { status: 'active' }, cookie: coverAdmin.cookie, method: 'POST',
  });
  const coverGetOnline = await apiBytes(coverApi());
  check(
    '恢复上线后封面又能取到且字节一致',
    coverOnline.body?.ok === true
    && coverGetOnline.res.status === 200
    && coverGetOnline.bytes.equals(PNG_1X1),
    `online=${JSON.stringify(coverOnline.body)} status=${coverGetOnline.res.status} len=${coverGetOnline.bytes.length}`,
  );

  // 删图后就该彻底没有：详情 hasCover 回落，GET 直接 404
  const coverDel = await api(coverApi(), { cookie: a.cookie, method: 'DELETE' });
  check('删除封面成功', coverDel.body?.ok === true, JSON.stringify(coverDel.body));

  const coverGone = await apiBytes(coverApi());
  check('删除后 GET 封面 404', coverGone.res.status === 404, `status=${coverGone.res.status}`);

  const coverDetailSans = await api(apiSite(), { cookie: a.cookie });
  check(
    '删除后详情 hasCover=false',
    coverDetailSans.body?.site?.hasCover === false,
    `hasCover=${JSON.stringify(coverDetailSans.body?.site?.hasCover)}`,
  );

  // 外键级联：拿一个临时站先存图，删站后 site_covers 里的行必须跟着消失
  const cascadeName = 'smoke-cover-cascade';
  const cascadeUpload = await api('/api/upload', {
    body: { html: '<p>cascade</p>', name: cascadeName }, cookie: a.cookie, method: 'POST',
  });
  const cascadeDetail = await api(apiSite('', cascadeName), { cookie: a.cookie });
  const cascadeId = cascadeDetail.body?.site?.id;
  check(
    '创建临时站点（级联用）',
    cascadeUpload.res.status === 201 && Number.isInteger(cascadeId),
    `status=${cascadeUpload.res.status} id=${cascadeId} ${JSON.stringify(cascadeUpload.body)}`,
  );

  await api(apiSite('/cover', cascadeName), { cookie: a.cookie, method: 'PUT', raw: PNG_1X1, type: 'image/png' });
  const cascadeRowsBefore = await dbQuery('SELECT COUNT(*) AS c FROM site_covers WHERE site_id = ?', [cascadeId]);
  check(
    '临时站点封面已写进 site_covers',
    Number(cascadeRowsBefore[0]?.c) === 1,
    `id=${cascadeId} rows=${JSON.stringify(cascadeRowsBefore)}`,
  );

  const cascadeDel = await api(apiSite('', cascadeName), { cookie: a.cookie, method: 'DELETE' });
  const cascadeRowsAfter = await dbQuery('SELECT COUNT(*) AS c FROM site_covers WHERE site_id = ?', [cascadeId]);
  check(
    '删除站点后封面行被级联清掉',
    cascadeDel.body?.ok === true && Number(cascadeRowsAfter[0]?.c) === 0,
    `ok=${JSON.stringify(cascadeDel.body)} id=${cascadeId} rows=${JSON.stringify(cascadeRowsAfter)}`,
  );

  // ---------------------------------------------------------- 5. 社交
  console.log('\n社交互动');

  const like = await api(apiSite(`/like`), { cookie: b.cookie, method: 'POST' });
  check('点赞成功', like.body?.ok === true, JSON.stringify(like.body));
  const likeAgain = await api(apiSite(`/like`), { cookie: b.cookie, method: 'POST' });
  check('重复点赞幂等', likeAgain.body?.ok === true, JSON.stringify(likeAgain.body));
  const statLiked = await api(apiSite(`/stats`), { cookie: a.cookie });
  check('点赞数 = 1（数字）', statLiked.body?.stats?.likes === 1, JSON.stringify(statLiked.body?.stats));
  const unlike = await api(apiSite(`/like`), { cookie: b.cookie, method: 'DELETE' });
  check('取消点赞成功', unlike.body?.ok === true, JSON.stringify(unlike.body));
  const statUnliked = await api(apiSite(`/stats`), { cookie: a.cookie });
  check('点赞数回到 0', statUnliked.body?.stats?.likes === 0, JSON.stringify(statUnliked.body?.stats));

  // 卡片列表要带回「当前用户对这个站点的状态」，前端靠它点亮赞/藏按钮
  await api(apiSite(`/like`), { cookie: b.cookie, method: 'POST' });
  const likedCards = await api('/api/discover', { cookie: b.cookie });
  check('发现流卡片读回我的点赞状态',
    likedCards.body?.sites?.find((s) => s.name === SITE)?.liked === true,
    JSON.stringify(likedCards.body?.sites?.find((s) => s.name === SITE)?.liked));
  const creatorLikedCards = await api('/api/u/smoke-a/profile', { cookie: b.cookie });
  check('创作者卡片读回我的点赞状态',
    creatorLikedCards.body?.sites?.find((s) => s.name === SITE)?.liked === true,
    JSON.stringify(creatorLikedCards.body?.sites?.find((s) => s.name === SITE)?.liked));
  await api(apiSite(`/like`), { cookie: b.cookie, method: 'DELETE' });
  const unlikedCards = await api('/api/discover', { cookie: b.cookie });
  check('取消点赞后卡片状态归零',
    unlikedCards.body?.sites?.find((s) => s.name === SITE)?.liked === false,
    JSON.stringify(unlikedCards.body?.sites?.find((s) => s.name === SITE)?.liked));

  const comment = await api(apiSite(`/comments`), { body: { content: '这是 b 的评论' }, cookie: b.cookie, method: 'POST' });
  check('发表评论成功', comment.body?.ok === true, JSON.stringify(comment.body));
  const comments = await api(apiSite(`/comments`));
  check('评论列表 1 条', comments.body?.comments?.length === 1, JSON.stringify(comments.body?.comments?.length));
  check('评论带作者（JOIN users）', comments.body?.comments?.[0]?.author?.id === b.user.id, JSON.stringify(comments.body?.comments?.[0]?.author));
  const parentId = comments.body?.comments?.[0]?.id;

  const reply = await api(apiSite(`/comments`), { body: { content: '这是回复', replyTo: parentId }, cookie: a.cookie, method: 'POST' });
  check('回复评论成功', reply.body?.ok === true, JSON.stringify(reply.body));
  const comments2 = await api(apiSite(`/comments`));
  check('评论列表 2 条（含回复）', comments2.body?.comments?.length === 2, JSON.stringify(comments2.body?.comments?.length));

  const delComment = await api(apiSite(`/comments/${parentId}`), { cookie: b.cookie, method: 'DELETE' });
  check('删除自己的评论成功', delComment.body?.ok === true, JSON.stringify(delComment.body));
  const afterDeleteComments = await api(apiSite(`/comments`));
  check('删除顶层评论后回复也从数据库删除',
    afterDeleteComments.body?.comments?.length === 0,
    JSON.stringify(afterDeleteComments.body?.comments?.length));

  const fav = await api(apiSite(`/favorite`), { body: { folder: '冒烟收藏夹' }, cookie: b.cookie, method: 'POST' });
  check('收藏成功', fav.body?.ok === true, JSON.stringify(fav.body));
  const favs = await api('/api/favorites', { cookie: b.cookie });
  check(
    '收藏列表里有它',
    favs.body?.sites?.some((f) => f.name === SITE),
    `status=${favs.res.status} ${JSON.stringify(favs.body?.sites?.map((f) => f.name))}`,
  );
  check('收藏夹卡片带真实收藏状态',
    favs.body?.sites?.find((s) => s.name === SITE)?.favorited === true,
    JSON.stringify(favs.body?.sites?.find((s) => s.name === SITE)?.favorited));
  const unfav = await api(apiSite(`/favorite`), { cookie: b.cookie, method: 'DELETE' });
  check('取消收藏成功', unfav.body?.ok === true, JSON.stringify(unfav.body));
  const unfavedCards = await api('/api/discover', { cookie: b.cookie });
  check('取消收藏后卡片状态归零',
    unfavedCards.body?.sites?.find((s) => s.name === SITE)?.favorited === false,
    JSON.stringify(unfavedCards.body?.sites?.find((s) => s.name === SITE)?.favorited));

  const follow = await api(`/api/users/${a.user.id}/follow`, { cookie: b.cookie, method: 'POST' });
  check('关注成功', follow.body?.ok === true, JSON.stringify(follow.body));
  const followedSocial = await api(`/api/users/${a.user.id}/social`, { cookie: b.cookie });
  check('作品页关注状态接口读回已关注', followedSocial.body?.isFollowing === true, JSON.stringify(followedSocial.body));
  const followedProfile = await api('/api/u/smoke-a/profile', { cookie: b.cookie });
  check('关注状态与粉丝数从数据库读回',
    followedProfile.body?.isFollowing === true && followedProfile.body?.stats?.followers === 1,
    JSON.stringify(followedProfile.body?.stats));
  const followers = await api(`/api/users/${a.user.id}/follow-list?type=followers`);
  check(
    '粉丝列表 1 人（JOIN users）',
    followers.body?.users?.length === 1,
    `status=${followers.res.status} ${JSON.stringify(followers.body)?.slice(0, 160)}`,
  );
  const unfollow = await api(`/api/users/${a.user.id}/follow`, { cookie: b.cookie, method: 'DELETE' });
  check('取消关注成功', unfollow.body?.ok === true, JSON.stringify(unfollow.body));
  const unfollowedProfile = await api('/api/u/smoke-a/profile', { cookie: b.cookie });
  check('取消关注后主页状态与粉丝数归零',
    unfollowedProfile.body?.isFollowing === false && unfollowedProfile.body?.stats?.followers === 0,
    JSON.stringify(unfollowedProfile.body?.stats));

  const history = await api('/api/history', { body: { site: SITE, username: A_NAME }, cookie: b.cookie, method: 'POST' });
  check('记录浏览历史成功', history.body?.ok === true, JSON.stringify(history.body));
  await api('/api/history', { body: { site: SITE, username: A_NAME }, cookie: b.cookie, method: 'POST' });
  const historyList = await api('/api/history', { cookie: b.cookie });
  check(
    '重复浏览同站仍只有 1 条（upsert 生效）',
    historyList.body?.sites?.length === 1,
    `status=${historyList.res.status} ${JSON.stringify(historyList.body)?.slice(0, 160)}`,
  );

  const send = await api(`/api/messages/${a.user.id}`, { body: { content: '你好，这是私信' }, cookie: b.cookie, method: 'POST' });
  check('发私信成功', send.body?.ok === true, JSON.stringify(send.body));
  const convsBefore = await api('/api/messages', { cookie: a.cookie });
  check('收到私信前会话标记未读',
    (convsBefore.body?.conversations?.[0]?.unread ?? 0) >= 1,
    JSON.stringify(convsBefore.body?.conversations?.[0]?.unread));
  const convs = await api('/api/messages', { cookie: a.cookie });
  check('会话列表 1 条（JOIN users）', convs.body?.conversations?.length === 1, JSON.stringify(convs.body?.conversations));
  const thread = await api(`/api/messages/${b.user.id}`, { cookie: a.cookie });
  check('私信内容读回一致', thread.body?.messages?.[0]?.content === '你好，这是私信', JSON.stringify(thread.body?.messages?.[0]?.content));
  const convsAfter = await api('/api/messages', { cookie: a.cookie });
  check('打开会话后未读数归零',
    convsAfter.body?.conversations?.[0]?.unread === 0,
    JSON.stringify(convsAfter.body?.conversations?.[0]?.unread));

  // 通知是「按当前互动数据算出来的」（没有事件表），所以先把互动补上再看
  await api(apiSite(`/like`), { cookie: b.cookie, method: 'POST' });
  const notificationsAnon = await api('/api/notifications');
  check('未登录不能读取通知', notificationsAnon.res.status === 401, `status=${notificationsAnon.res.status}`);
  const notifications = await api('/api/notifications', { cookie: a.cookie });
  check(
    'a 收到互动通知',
    (notifications.body?.items?.length ?? 0) > 0,
    `status=${notifications.res.status} ${JSON.stringify(notifications.body)?.slice(0, 200)}`,
  );
  check('新通知带未读状态', notifications.body?.items?.some((item) => item.unread === true));
  const seen = await api('/api/notifications/seen', { cookie: a.cookie, method: 'POST' });
  check('标记通知已读成功', seen.body?.ok === true, JSON.stringify(seen.body));
  const seenAgain = await api('/api/notifications', { cookie: a.cookie });
  check('已读状态从数据库读回', seenAgain.body?.items?.every((item) => item.unread === false));
  const meUnread = await api('/api/me', { cookie: a.cookie });
  check('未读数归零', meUnread.body?.unread === 0, JSON.stringify(meUnread.body?.unread));

  const search = await api('/api/users/search?q=smoke');
  check('搜索用户能命中', (search.body?.users?.length ?? 0) >= 1, JSON.stringify(search.body?.users?.map((u) => u.username)));

  const discover = await api('/api/discover');
  check('发现流 200 且带站点', discover.res.status === 200 && (discover.body?.sites?.length ?? 0) >= 1, JSON.stringify(discover.body?.sites?.length));

  const creator = await api('/api/u/smoke-a/profile');
  const creatorStats = creator.body?.stats;
  check(
    '创作者主页的站点数与浏览量是数字（SUM 不能变字符串）',
    typeof creatorStats?.sites === 'number' && typeof creatorStats?.views === 'number',
    `status=${creator.res.status} ${JSON.stringify(creatorStats)}`,
  );
  check('创作者主页带自己的站点', creator.body?.sites?.some((s) => s.name === SITE), JSON.stringify(creator.body?.sites?.map((s) => s.name)));

  // ---------------------------------------------------------- 5b. 硬币投币
  console.log('\n硬币投币');

  // 注册赠币：b 是新注册账号，应该已经拿到注册币
  const bCoins = await api('/api/coins', { cookie: b.cookie });
  check('注册赠币已入账', bCoins.body?.balance >= 3, JSON.stringify(bCoins.body));
  check(
    '赠币有流水记录',
    (bCoins.body?.ledger ?? []).some((row) => row.reason === 'register'),
    JSON.stringify(bCoins.body?.ledger),
  );

  // 每日签到：/api/me 会发一次，同一天重复调不再发
  const meFirst = await api('/api/me', { cookie: b.cookie });
  const balanceAfterFirst = meFirst.body?.user?.coins ?? 0;
  const meSecond = await api('/api/me', { cookie: b.cookie });
  check(
    '同一天重复访问不再发币',
    meSecond.body?.user?.coins === balanceAfterFirst,
    `${balanceAfterFirst} → ${meSecond.body?.user?.coins}`,
  );

  // 投币：b 给 a 的站点投 1 枚，币 1:1 进作者余额
  const coin1 = await api(apiSite(`/coin`), { cookie: b.cookie, method: 'POST', body: { count: 1 } });
  check('投币成功', coin1.body?.ok === true, JSON.stringify(coin1.body));
  check(
    '投币后投币者余额 -1',
    coin1.body?.balance === balanceAfterFirst - 1,
    `balance=${coin1.body?.balance} 期望=${balanceAfterFirst - 1}`,
  );
  const aMeAfterCoin = await api('/api/me', { cookie: a.cookie });
  check('作者余额等额增加', (aMeAfterCoin.body?.user?.coins ?? 0) >= 1, JSON.stringify(aMeAfterCoin.body?.user?.coins));

  const statAfterCoin = await api(apiSite('/stats'), { cookie: b.cookie });
  check('站点收到硬币数 = 1', statAfterCoin.body?.stats?.coins === 1, JSON.stringify(statAfterCoin.body?.stats));
  check('我投了几枚回显正确', statAfterCoin.body?.stats?.coined === 1, JSON.stringify(statAfterCoin.body?.stats));

  // 每人每站上限 2 枚
  const coin2 = await api(apiSite(`/coin`), { cookie: b.cookie, method: 'POST', body: { count: 1 } });
  check('第二次投币成功', coin2.body?.ok === true, JSON.stringify(coin2.body));
  const coin3 = await api(apiSite(`/coin`), { cookie: b.cookie, method: 'POST', body: { count: 1 } });
  check('超过每人每站 2 枚 → 409', coin3.res.status === 409, `status=${coin3.res.status} ${JSON.stringify(coin3.body)}`);

  // 数量校验：只接受 1..MAX_COINS_PER_SITE
  const badCount = await api(apiSite(`/coin`), { cookie: b.cookie, method: 'POST', body: { count: 3 } });
  check('一次投超过上限 → 400', badCount.res.status === 400, `status=${badCount.res.status}`);
  const zeroCount = await api(apiSite(`/coin`), { cookie: b.cookie, method: 'POST', body: { count: 0 } });
  check('投 0 枚 → 400', zeroCount.res.status === 400, `status=${zeroCount.res.status}`);

  // 不能给自己投币
  const selfCoin = await api(apiSite(`/coin`), { cookie: a.cookie, method: 'POST', body: { count: 1 } });
  check('给自己投币 → 400', selfCoin.res.status === 400, `status=${selfCoin.res.status} ${JSON.stringify(selfCoin.body)}`);

  // 未登录不能投
  const anonCoin = await api(apiSite(`/coin`), { method: 'POST', body: { count: 1 } });
  check('未登录投币 → 401', anonCoin.res.status === 401, `status=${anonCoin.res.status}`);

  // 投币不可撤回：和点赞不同，没有 DELETE 接口
  const undoCoin = await api(apiSite(`/coin`), { cookie: b.cookie, method: 'DELETE' });
  check('投币不能撤回（DELETE 不存在）→ 404', undoCoin.res.status === 404, `status=${undoCoin.res.status}`);

  // 通知：a 收到投币事件
  const coinNotifs = await api('/api/notifications', { cookie: a.cookie });
  check(
    '投币事件进通知流',
    (coinNotifs.body?.items ?? []).some((it) => it.type === 'coin'),
    JSON.stringify((coinNotifs.body?.items ?? []).map((it) => it.type)),
  );

  // 创作者主页带「收到的硬币」
  const creatorCoins = await api('/api/u/smoke-a/profile');
  check(
    '创作者主页带收到的硬币数',
    typeof creatorCoins.body?.stats?.coinsReceived === 'number' && creatorCoins.body.stats.coinsReceived >= 2,
    JSON.stringify(creatorCoins.body?.stats),
  );

  // ---------------------------------------------------------- 6. 权限边界
  console.log('\n权限边界');

  const anonSites = await api('/api/sites');
  check('未登录看我的站点 → 401', anonSites.res.status === 401, `status=${anonSites.res.status}`);

  const stealHtml = await api(apiSite(), { body: { html: '<p>篡改</p>' }, cookie: b.cookie, method: 'PUT' });
  check('改别人的站点被拒', stealHtml.res.status === 403 || stealHtml.res.status === 404, `status=${stealHtml.res.status}`);

  const stealDelete = await api(apiSite(), { cookie: b.cookie, method: 'DELETE' });
  check('删别人的站点被拒', stealDelete.res.status === 403 || stealDelete.res.status === 404, `status=${stealDelete.res.status}`);

  const stealFiles = await api(apiSite(`/files`), { cookie: b.cookie });
  check('看别人的文件列表被拒', stealFiles.res.status === 403 || stealFiles.res.status === 404, `status=${stealFiles.res.status}`);

  const notAdmin = await api('/api/admin/users', { cookie: b.cookie });
  check('非管理员访问后台接口 → 403', notAdmin.res.status === 403, `status=${notAdmin.res.status}`);

  const notAdminPage = await api('/admin', { cookie: b.cookie });
  check('非管理员访问 /admin → 403', notAdminPage.res.status === 403, `status=${notAdminPage.res.status}`);

  // ---------------------------------------------------------- 7. 管理后台
  console.log('\n管理后台');

  const admin = await login(ADMIN_LOGIN, ADMIN_PASSWORD);
  check('管理员登录成功', Boolean(admin.cookie));

  const adminPage = await api('/admin', { cookie: admin.cookie });
  check('GET /admin 200', adminPage.res.status === 200, `status=${adminPage.res.status}`);

  const users = await api('/api/admin/users', { cookie: admin.cookie });
  // A/B/管理员 + 存储上限用例新开的 smoke-storage / smoke-mixed
  check('用户列表含 5 个账号', (users.body?.users?.length ?? 0) === 5, JSON.stringify(users.body?.users?.map((u) => u.email)));
  check('用户列表不含 password_hash', !JSON.stringify(users.body).includes('password_hash'));

  const adminSites = await api('/api/admin/sites', { cookie: admin.cookie });
  check(
    '后台站点列表含冒烟站点（名字可重复，按作者区分）',
    adminSites.body?.sites?.some((s) => s.name === SITE && s.owner_username === A_NAME),
    JSON.stringify(adminSites.body?.sites?.map((s) => `${s.owner_username}/${s.name}`)),
  );
  const siteId = adminSites.body?.sites?.find((s) => s.name === SITE && s.owner_username === A_NAME)?.id;

  const ban = await api(`/api/admin/users/${b.user.id}/status`, { body: { status: 'banned' }, cookie: admin.cookie, method: 'POST' });
  check('封禁用户成功', ban.body?.ok === true, JSON.stringify(ban.body));
  const bannedLogin = await api('/api/auth/login', { body: { login: B_EMAIL, password: PASS }, method: 'POST' });
  check('被封账号登录 → 403', bannedLogin.res.status === 403, `status=${bannedLogin.res.status}`);
  const unban = await api(`/api/admin/users/${b.user.id}/status`, { body: { status: 'active' }, cookie: admin.cookie, method: 'POST' });
  check('解封成功', unban.body?.ok === true, JSON.stringify(unban.body));

  const offline = await api(`/api/admin/sites/${siteId}/status`, { body: { status: 'offline' }, cookie: admin.cookie, method: 'POST' });
  check('下线站点成功', offline.body?.ok === true, `status=${offline.res.status} ${JSON.stringify(offline.body)}`);
  const offlineView = await api(pageUrl());
  check('下线后匿名访问 451', offlineView.res.status === 451, `status=${offlineView.res.status}`);
  const backOnline = await api(`/api/admin/sites/${siteId}/status`, { body: { status: 'active' }, cookie: admin.cookie, method: 'POST' });
  check('恢复站点成功', backOnline.body?.ok === true, `status=${backOnline.res.status} ${JSON.stringify(backOnline.body)}`);
  const onlineView = await api(pageUrl());
  check('恢复后可访问', onlineView.res.status === 200, `status=${onlineView.res.status}`);

  // ---------------------------------------------------------- 7b. 热门搜索
  console.log('\n热门搜索');

  const hotWord = '冒烟热词';

  // 还没人搜过：榜是空的，而不是拿标签冒充
  const hotEmpty = await api('/api/hot');
  check('没人搜过时热搜为空', (hotEmpty.body?.words?.length ?? 0) === 0, JSON.stringify(hotEmpty.body));

  // 一个人搜了不算热门（阈值是「不同的人」，不是次数）
  await api('/api/discover?q=' + encodeURIComponent(hotWord), { cookie: a.cookie });
  const hotOne = await api('/api/hot');
  check(
    '一个人搜不算热门',
    !(hotOne.body?.words ?? []).some((w) => w.word === hotWord),
    JSON.stringify(hotOne.body?.words),
  );

  // 同一个人再搜一遍，还不算第二个人
  await api('/api/discover?q=' + encodeURIComponent(hotWord), { cookie: a.cookie });
  const hotOneAgain = await api('/api/hot');
  check(
    '同一个人重复搜不涨人数',
    !(hotOneAgain.body?.words ?? []).some((w) => w.word === hotWord),
    JSON.stringify(hotOneAgain.body?.words),
  );

  // 第二个人也搜了 → 上榜
  await api('/api/discover?q=' + encodeURIComponent(hotWord), { cookie: b.cookie });
  const hotTwo = await api('/api/hot');
  const hotEntry = (hotTwo.body?.words ?? []).find((w) => w.word === hotWord);
  check('两个人搜过就上榜', Boolean(hotEntry), JSON.stringify(hotTwo.body?.words));
  check('榜上人数是 2', hotEntry?.people === 2, JSON.stringify(hotEntry));

  // 翻页不重复计数：带上 page=2 再搜一次，人数不该变
  await api('/api/discover?q=' + encodeURIComponent(hotWord) + '&page=2', { cookie: a.cookie });
  const hotPaged = await api('/api/hot');
  check(
    '翻页不重复记录',
    (hotPaged.body?.words ?? []).find((w) => w.word === hotWord)?.people === 2,
    JSON.stringify(hotPaged.body?.words),
  );

  // 纯数字 / URL 这类不是搜索词的，不入库
  await api('/api/discover?q=12345', { cookie: a.cookie });
  await api('/api/discover?q=' + encodeURIComponent('https://example.com'), { cookie: b.cookie });
  const hotJunk = await api('/api/hot');
  check(
    '垃圾词不进榜',
    !(hotJunk.body?.words ?? []).some((w) => w.word === '12345' || w.word.includes('example.com')),
    JSON.stringify(hotJunk.body?.words),
  );

  // 匿名访客也能凑人数（靠随机 Cookie 区分），但同一次浏览器会话里不会重复计
  const anonA = await api('/api/discover?q=' + encodeURIComponent(hotWord));
  const anonB = await api('/api/discover?q=' + encodeURIComponent(hotWord));
  const hotAnon = await api('/api/hot');
  check(
    '匿名访客的搜索也被记录',
    (hotAnon.body?.words ?? []).find((w) => w.word === hotWord)?.people >= 3,
    JSON.stringify(hotAnon.body?.words?.find((w) => w.word === hotWord)),
  );

  // 后台屏蔽：词从榜上消失，已有记录一起删掉，再搜也不记录
  const block = await api('/api/admin/blocked-words', {
    body: { note: '冒烟测试', word: hotWord }, cookie: admin.cookie, method: 'POST',
  });
  check('后台屏蔽热搜词成功', block.body?.ok === true, JSON.stringify(block.body));

  await api('/api/discover?q=' + encodeURIComponent(hotWord), { cookie: a.cookie });
  await api('/api/discover?q=' + encodeURIComponent(hotWord), { cookie: b.cookie });
  const hotBlocked = await api('/api/hot');
  check(
    '屏蔽后榜上搜不到这个词',
    !(hotBlocked.body?.words ?? []).some((w) => w.word === hotWord),
    JSON.stringify(hotBlocked.body?.words),
  );

  // 屏蔽词在写入侧生效：重新积累了几轮也不会回来
  const hotBlockedAgain = await api('/api/hot');
  check(
    '屏蔽后不再积累记录',
    !(hotBlockedAgain.body?.words ?? []).some((w) => w.word === hotWord),
    JSON.stringify(hotBlockedAgain.body?.words),
  );

  const blockedList = await api('/api/admin/blocked-words', { cookie: admin.cookie });
  check(
    '后台能看到屏蔽词',
    (blockedList.body?.words ?? []).some((w) => w.word === hotWord),
    JSON.stringify(blockedList.body?.words),
  );

  // 解封后重新开始积累（历史数据不会回来）
  const unblock = await api('/api/admin/blocked-words/' + encodeURIComponent(hotWord), {
    cookie: admin.cookie, method: 'DELETE',
  });
  check('解封成功', unblock.body?.ok === true, JSON.stringify(unblock.body));

  const unblockAgain = await api('/api/admin/blocked-words/' + encodeURIComponent(hotWord), {
    cookie: admin.cookie, method: 'DELETE',
  });
  check('解封不存在的词 → 404', unblockAgain.res.status === 404, `status=${unblockAgain.res.status}`);

  await api('/api/discover?q=' + encodeURIComponent(hotWord), { cookie: a.cookie });
  await api('/api/discover?q=' + encodeURIComponent(hotWord), { cookie: b.cookie });
  const hotUnblocked = await api('/api/hot');
  check(
    '解封后重新上榜',
    (hotUnblocked.body?.words ?? []).find((w) => w.word === hotWord)?.people === 2,
    JSON.stringify(hotUnblocked.body?.words?.find((w) => w.word === hotWord)),
  );

  // 权限：非管理员碰不到屏蔽词接口
  const notAdminBlock = await api('/api/admin/blocked-words', { cookie: b.cookie });
  check('非管理员看屏蔽词 → 403', notAdminBlock.res.status === 403, `status=${notAdminBlock.res.status}`);
  const anonBlock = await api('/api/admin/blocked-words');
  check('未登录看屏蔽词 → 401', anonBlock.res.status === 401, `status=${anonBlock.res.status}`);
  const notAdminBlockPost = await api('/api/admin/blocked-words', {
    body: { word: '别人不能加' }, cookie: b.cookie, method: 'POST',
  });
  check('非管理员加屏蔽词 → 403', notAdminBlockPost.res.status === 403, `status=${notAdminBlockPost.res.status}`);

  // 空词拒绝
  const emptyBlock = await api('/api/admin/blocked-words', {
    body: { word: '   ' }, cookie: admin.cookie, method: 'POST',
  });
  check('空词屏蔽 → 400', emptyBlock.res.status === 400, `status=${emptyBlock.res.status}`);

  // ---------------------------------------------------------- 8. 改密码与找回
  console.log('\n改密码与找回');

  const changeSend = await api('/api/auth/send-code', { body: { purpose: 'change' }, cookie: a.cookie, method: 'POST' });
  check('改密码发码成功', changeSend.body?.ok === true, JSON.stringify(changeSend.body));
  const changeCode = await waitForCode(A_EMAIL);

  const wrongChange = await api('/api/auth/password', {
    body: { code: '000000', currentPassword: PASS, newPassword: 'smoke-pass-2' },
    cookie: a.cookie,
    method: 'POST',
  });
  check('改密码验证码错 → 400', wrongChange.res.status === 400, `status=${wrongChange.res.status}`);

  const change = await api('/api/auth/password', {
    body: { code: changeCode, currentPassword: PASS, newPassword: 'smoke-pass-2' },
    cookie: a.cookie,
    method: 'POST',
  });
  check('改密码成功', change.body?.ok === true, JSON.stringify(change.body));
  const oldLogin = await api('/api/auth/login', { body: { login: A_EMAIL, password: PASS }, method: 'POST' });
  check('旧密码登录 → 401', oldLogin.res.status === 401, `status=${oldLogin.res.status}`);
  const newLogin = await api('/api/auth/login', { body: { login: A_EMAIL, password: 'smoke-pass-2' }, method: 'POST' });
  check('新密码登录成功', newLogin.body?.ok === true, JSON.stringify(newLogin.body));

  const probe = await api('/api/auth/send-code', { body: { email: 'nobody-here@test.local', purpose: 'reset' }, method: 'POST' });
  check('找回密码对不存在的邮箱也回 ok（防探测）', probe.body?.ok === true, JSON.stringify(probe.body));

  const resetSend = await api('/api/auth/send-code', { body: { email: A_EMAIL, purpose: 'reset' }, method: 'POST' });
  check('找回密码发码成功', resetSend.body?.ok === true, JSON.stringify(resetSend.body));
  const resetCode = await waitForCode(A_EMAIL);
  const reset = await api('/api/auth/reset-password', {
    body: { code: resetCode, email: A_EMAIL, password: 'smoke-pass-3' },
    method: 'POST',
  });
  check('重置密码成功', reset.body?.ok === true, JSON.stringify(reset.body));
  const afterReset = await api('/api/auth/login', { body: { login: A_EMAIL, password: 'smoke-pass-3' }, method: 'POST' });
  check('重置后的新密码可登录', afterReset.body?.ok === true, JSON.stringify(afterReset.body));
  const aCookie = cookiesOf(afterReset.res);

  // ---------------------------------------------------------- 9. MCP 密钥 CRUD
  console.log('\nMCP 密钥');

  const tokenCreate = await api('/api/mcp/tokens', { body: { label: '冒烟密钥' }, cookie: aCookie, method: 'POST' });
  check('创建 MCP 密钥 201', tokenCreate.res.status === 201, `status=${tokenCreate.res.status}`);
  check('密钥带 mp_mcp_ 前缀', String(tokenCreate.body?.token).startsWith('mp_mcp_'), tokenCreate.body?.token?.slice(0, 12));
  check('创建响应不含 token_hash', !JSON.stringify(tokenCreate.body).includes('token_hash'));

  const tokenList = await api('/api/mcp/tokens', { cookie: aCookie });
  check('密钥列表里能看到它', tokenList.body?.tokens?.some((t) => t.label === '冒烟密钥'), JSON.stringify(tokenList.body?.tokens));

  const mcpNoAuth = await fetch(`${BASE}/mcp`, { body: '{"id":1,"jsonrpc":"2.0","method":"tools/list"}', headers: { 'Content-Type': 'application/json' }, method: 'POST' });
  check('POST /mcp 无密钥 → 401', mcpNoAuth.status === 401, `status=${mcpNoAuth.status}`);

  const mcpGet = await fetch(`${BASE}/mcp`);
  check('GET /mcp → 405', mcpGet.status === 405, `status=${mcpGet.status}`);

  const tokenId = tokenList.body?.tokens?.find((t) => t.label === '冒烟密钥')?.id;
  const revoke = await api(`/api/mcp/tokens/${tokenId}/revoke`, { cookie: aCookie, method: 'POST' });
  check('吊销密钥成功', revoke.body?.ok === true, JSON.stringify(revoke.body));
  const revokeTwice = await api(`/api/mcp/tokens/${tokenId}/revoke`, { cookie: aCookie, method: 'POST' });
  check('重复吊销 → 404', revokeTwice.res.status === 404, `status=${revokeTwice.res.status}`);

  // ---------------------------------------------------------- 10. 配额与改名
  console.log('\n配额与改名');

  const quotaList = await api('/api/sites', { cookie: aCookie });
  const used = quotaList.body?.sites?.length ?? 0;
  check('我的站点列表带配额', quotaList.body?.quota === QUOTA, JSON.stringify(quotaList.body?.quota));

  for (let i = used; i < QUOTA; i += 1) {
    await api('/api/upload', { body: { html: '<p>占位</p>', name: `quota-fill-${i}` }, cookie: aCookie, method: 'POST' });
  }
  const overQuota = await api('/api/upload', { body: { html: '<p>x</p>', name: 'quota-over' }, cookie: aCookie, method: 'POST' });
  check('超过配额 → 429', overQuota.res.status === 429, `status=${overQuota.res.status} ${JSON.stringify(overQuota.body)}`);

  // 清理占位的，留出后面的删除测试
  const fillSites = (await api('/api/sites', { cookie: aCookie })).body?.sites ?? [];
  for (const s of fillSites.filter((x) => x.name.startsWith('quota-fill-'))) {
    await api(apiSite('', s.name), { cookie: aCookie, method: 'DELETE' });
  }

  const renameTaken = await api('/api/account/username', { body: { username: B_NAME }, cookie: aCookie, method: 'POST' });
  check('改名撞别人用户名 → 409', renameTaken.res.status === 409, `status=${renameTaken.res.status}`);

  const renamed = await api('/api/account/username', { body: { username: 'smoke-a2' }, cookie: aCookie, method: 'POST' });
  check('改名成功', renamed.body?.username === 'smoke-a2', JSON.stringify(renamed.body));
  check('改名后旧地址失效', (await api(`/qwq/${A_NAME}/${SITE}`)).res.status === 404);
  check('改名后新地址可访问', (await api(`/qwq/smoke-a2/${SITE}`)).res.status === 200);
  const oldNameFree = await api('/api/account/username', { body: { username: 'smoke-a2' }, cookie: b.cookie, method: 'POST' });
  check('旧用户名已释放（这里撞的是新名）→ 409', oldNameFree.res.status === 409, `status=${oldNameFree.res.status}`);

  const backRenamed = await api('/api/account/username', { body: { username: A_NAME }, cookie: aCookie, method: 'POST' });
  check('改回原用户名', backRenamed.body?.username === A_NAME, JSON.stringify(backRenamed.body));

  // ---------------------------------------------------------- 10b. 硬币换配额
  console.log('\n硬币换配额');

  // a 现在有从 b 那里收到的币，够兑换一份
  const beforeQuota = (await api('/api/sites', { cookie: aCookie })).body?.quota ?? 0;
  const redeem = await api('/api/coins/quota', { cookie: aCookie, method: 'POST' });
  check('兑换配额成功', redeem.body?.ok === true, JSON.stringify(redeem.body));
  check('配额 +1', (redeem.body?.quota ?? 0) === beforeQuota + 1, `before=${beforeQuota} after=${redeem.body?.quota}`);
  const quotaAfterRedeem = (await api('/api/sites', { cookie: aCookie })).body?.quota;
  check('我的站点列表配额同步', quotaAfterRedeem === beforeQuota + 1, JSON.stringify(quotaAfterRedeem));

  // 余额不够兑换就拒绝
  const bRedeem = await api('/api/coins/quota', { cookie: b.cookie, method: 'POST' });
  check('余额不足兑换 → 402', bRedeem.res.status === 402, `status=${bRedeem.res.status} ${JSON.stringify(bRedeem.body)}`);

  // ---------------------------------------------------------- 10c. ZIP 建站也要过配额
  console.log('\nZIP 建站配额');

  // 把 a 的配额占满再试 ZIP 建新站。这条之前是漏洞：ZIP 绕过 createSite 的配额检查。
  const quotaNow = (await api('/api/sites', { cookie: aCookie })).body?.quota ?? QUOTA;
  const existing = (await api('/api/sites', { cookie: aCookie })).body?.sites?.length ?? 0;
  for (let i = existing; i < quotaNow; i += 1) {
    await api('/api/upload', { body: { html: '<p>占位</p>', name: `zip-quota-fill-${i}` }, cookie: aCookie, method: 'POST' });
  }
  const zipOverQuota = await api(apiSite(`/zip`, 'zip-over-quota'), {
    cookie: aCookie, method: 'POST', raw: goodZip, type: 'application/zip',
  });
  check(
    'ZIP 建站超过配额 → 429',
    zipOverQuota.res.status === 429,
    `status=${zipOverQuota.res.status} ${JSON.stringify(zipOverQuota.body)}`,
  );
  const zipOverMissing = await api(apiSite('', 'zip-over-quota'), { cookie: aCookie });
  check('超配额的 ZIP 不留半个站点', zipOverMissing.res.status === 404, `status=${zipOverMissing.res.status}`);
  for (const s of (await api('/api/sites', { cookie: aCookie })).body?.sites ?? []) {
    if (s.name.startsWith('zip-quota-fill-')) await api(apiSite('', s.name), { cookie: aCookie, method: 'DELETE' });
  }

  // ---------------------------------------------------------- 11. 删除与级联
  console.log('\n删除与级联');

  const delFile = await api(apiSite(`/files?path=assets/a.css`), { cookie: aCookie, method: 'DELETE' });
  check('删除子文件成功', delFile.body?.ok === true, JSON.stringify(delFile.body));
  const files3 = await api(apiSite(`/files`), { cookie: aCookie });
  check('删除后文件列表剩 2 个', files3.body?.files?.length === 2, JSON.stringify(files3.body?.files?.map((f) => f.path)));

  // 删站点：coin_charges 跟着级联清掉，但作者余额不回退——币在投出时就已经转手了
  const aBalanceBeforeDel = (await api('/api/coins', { cookie: aCookie })).body?.balance ?? 0;
  const delSite = await api(apiSite(), { cookie: aCookie, method: 'DELETE' });
  check('删除站点成功', delSite.body?.ok === true, JSON.stringify(delSite.body));
  const aBalanceAfterDel = (await api('/api/coins', { cookie: aCookie })).body?.balance ?? 0;
  check(
    '删站点不回退已收到的币',
    aBalanceAfterDel === aBalanceBeforeDel,
    `${aBalanceBeforeDel} → ${aBalanceAfterDel}`,
  );
  const afterDel = await api(pageUrl());
  check('删除后访问 404', afterDel.res.status === 404, `status=${afterDel.res.status}`);
  const filesAfter = await api(apiSite(`/files`), { cookie: aCookie });
  check('删除后文件接口 404/403', filesAfter.res.status === 404 || filesAfter.res.status === 403, `status=${filesAfter.res.status}`);
  const mySites2 = await api('/api/sites', { cookie: aCookie });
  check('删除后我的站点列表为空', (mySites2.body?.sites?.length ?? -1) === 0, JSON.stringify(mySites2.body?.sites?.length));

  // ---------------------------------------------------------- 12. 注销账号
  console.log('\n注销账号');

  const c = await registerUser(C_EMAIL, C_NAME);
  await api('/api/upload', { body: { html: '<h1>c 的站</h1>', name: 'c-site' }, cookie: c.cookie, method: 'POST' });
  check('注销前站点可访问', (await api(`/qwq/${C_NAME}/c-site`)).res.status === 200);

  const wrongPassDelete = await api('/api/account/delete', { body: { password: 'not-my-pass' }, cookie: c.cookie, method: 'POST' });
  check('注销时密码错 → 400', wrongPassDelete.res.status === 400, `status=${wrongPassDelete.res.status}`);

  const del = await api('/api/account/delete', { body: { password: PASS }, cookie: c.cookie, method: 'POST' });
  check('注销成功', del.body?.ok === true, JSON.stringify(del.body));

  check('注销后站点 404', (await api(`/qwq/${C_NAME}/c-site`)).res.status === 404);
  check('注销后网页失效', (await api('/api/sites', { cookie: c.cookie })).res.status === 401);
  const goneLogin = await api('/api/auth/login', { body: { login: C_EMAIL, password: PASS }, method: 'POST' });
  check('注销后无法登录', goneLogin.res.status === 401, `status=${goneLogin.res.status}`);

  // 用户名释放了：别人能改成这个名字
  const reclaim = await api('/api/account/username', { body: { username: C_NAME }, cookie: b.cookie, method: 'POST' });
  check('注销后用户名被释放', reclaim.body?.username === C_NAME, JSON.stringify(reclaim.body));
  await api('/api/account/username', { body: { username: B_NAME }, cookie: b.cookie, method: 'POST' });
}

// ---------------------------------------------------------------- 入口

try {
  await boot();
  await run();
} catch (err) {
  failed += 1;
  results.push({ detail: String(err?.message ?? err).slice(0, 500), name: '测试执行中断', ok: false });
  console.log(`\n执行中断：${err?.stack ?? err}`);
} finally {
  shutdown();
}

console.log(`\n================ ${passed} 项通过 / ${failed} 项失败 ================`);
if (wantJson) {
  console.log(`\nSMOKE_JSON ${JSON.stringify({ failed, passed, results })}`);
}
process.exit(failed === 0 ? 0 : 1);
