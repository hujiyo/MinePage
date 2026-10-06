// 全站接口冒烟测试（不含 MCP 协议层，那部分在 mcp-smoke.mjs）。
//
// 自己拉起一个临时服务来跑，默认用临时 SQLite 库，不碰你的开发库和线上库：
//
//   node scripts/api-smoke.mjs                  # 临时 SQLite 库
//   node scripts/api-smoke.mjs --json           # 末尾多打印一段 JSON，便于两者对比
//   BASE_URL=http://127.0.0.1:3100 node scripts/api-smoke.mjs   # 只跑测试，不拉服务
//
// 换 MySQL 之后，同一套脚本要能跑出同样的结果，这就是「行为没变」的证据。
// 服务端的发信在开发模式下会把验证码打印到控制台，脚本从子进程输出里捞。

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
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
const PASS = 'smoke-pass-1';
const SITE = 'smoke-site';

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
let tmpDb = '';

async function boot() {
  if (process.env.BASE_URL) {
    console.log(`跑在已有服务上：${BASE}\n`);
    return;
  }

  // 相对项目根目录（DB_FILE 就是按根目录解析的），data/ 已被 .gitignore 排除
  tmpDb = path.join('data', `smoke-${process.pid}.db`);
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) rmSync(path.resolve(ROOT, f), { force: true });

  const env = {
    ...process.env,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    ADMIN_USERNAME: ADMIN_LOGIN,
    DB_FILE: tmpDb,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    SMTP_HOST: '',
  };

  console.log(`拉起临时服务：PORT=${PORT} DB=${tmpDb}\n`);
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
    // Windows 上进程没退干净时删文件会 EPERM，等一下再删
    await Promise.race([exited, sleep(3000)]);
  }
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    if (!f) continue;
    try {
      rmSync(path.resolve(ROOT, f), { force: true });
    } catch {
      /* 删不掉就算了，反正 data/ 不进版本库 */
    }
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
async function registerUser(email) {
  const sent = await api('/api/auth/send-code', { body: { email, purpose: 'register' }, method: 'POST' });
  if (sent.body?.ok !== true) throw new Error(`send-code 失败：${JSON.stringify(sent.body)}`);
  const code = await waitForCode(email);
  const reg = await api('/api/auth/register', { body: { code, email, password: PASS }, method: 'POST' });
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
    'GET /sites 未登录跳登录页',
    sitesAnon.res.status === 302 && sitesAnon.res.headers.get('location') === '/login',
    `status=${sitesAnon.res.status} loc=${sitesAnon.res.headers.get('location')}`,
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
  const badCode = await api('/api/auth/register', {
    body: { code: '000000', email: A_EMAIL, password: PASS },
    method: 'POST',
  });
  check('验证码错 → 400', badCode.res.status === 400, `status=${badCode.res.status}`);

  const weak = await api('/api/auth/register', {
    body: { code: codeA, email: A_EMAIL, password: '123' },
    method: 'POST',
  });
  check('密码太短 → 400', weak.res.status === 400, `status=${weak.res.status}`);

  const registerA = await api('/api/auth/register', {
    body: { code: codeA, email: A_EMAIL, password: PASS },
    method: 'POST',
  });
  check('注册成功', registerA.body?.ok === true, JSON.stringify(registerA.body));
  check('注册响应里不含 password_hash', !JSON.stringify(registerA.body).includes('password_hash'));

  const dupe = await api('/api/auth/send-code', { body: { email: A_EMAIL, purpose: 'register' }, method: 'POST' });
  check('已注册邮箱再发码 → 409', dupe.res.status === 409, `status=${dupe.res.status}`);

  const a = await login(A_EMAIL, PASS);
  const me = await api('/api/me', { cookie: a.cookie });
  check('GET /api/me 是刚注册的账号', me.body?.user?.email === A_EMAIL, JSON.stringify(me.body?.user));
  check('新账号默认不是管理员', me.body?.user?.isAdmin === false, JSON.stringify(me.body?.user));
  check('GET /api/me 不含 password_hash', !JSON.stringify(me.body).includes('password_hash'));

  const b = await registerUser(B_EMAIL);
  check('第二个账号注册成功', Boolean(b.cookie), B_EMAIL);

  const badLogin = await api('/api/auth/login', { body: { login: A_EMAIL, password: 'wrong-pass' }, method: 'POST' });
  check('密码错 → 401', badLogin.res.status === 401, `status=${badLogin.res.status}`);

  // ---------------------------------------------------------- 3. 用户名与资料
  console.log('\n用户名与资料');

  const shortName = await api('/api/account/username', { body: { username: 'ab' }, cookie: a.cookie, method: 'POST' });
  check('用户名太短 → 400', shortName.res.status === 400, `status=${shortName.res.status}`);

  const reservedName = await api('/api/account/username', { body: { username: ADMIN_LOGIN }, cookie: a.cookie, method: 'POST' });
  check('用户名被占用 → 409', reservedName.res.status === 409, `status=${reservedName.res.status}`);

  const setName = await api('/api/account/username', { body: { username: 'smoke-a' }, cookie: a.cookie, method: 'POST' });
  check('设置用户名成功', setName.body?.ok === true, JSON.stringify(setName.body));

  const setBio = await api('/api/account/bio', { body: { bio: '我是冒烟测试账号' }, cookie: a.cookie, method: 'POST' });
  check('设置简介成功', setBio.body?.ok === true, JSON.stringify(setBio.body));

  const meAfter = await api('/api/me', { cookie: a.cookie });
  check('用户名与简介读回一致', meAfter.body?.user?.username === 'smoke-a' && meAfter.body?.user?.bio === '我是冒烟测试账号', JSON.stringify(meAfter.body?.user));

  const profile = await api('/api/u/smoke-a/profile');
  check('创作者主页接口 200', profile.res.status === 200, `status=${profile.res.status}`);

  // ---------------------------------------------------------- 4. 站点与文件
  console.log('\n站点与文件');

  const shortSite = await api('/api/upload', { body: { html: '<p>x</p>', name: 'ab' }, cookie: a.cookie, method: 'POST' });
  check('站名太短 → 400', shortSite.res.status === 400, `status=${shortSite.res.status}`);

  const reservedSite = await api('/api/upload', { body: { html: '<p>x</p>', name: 'admin' }, cookie: a.cookie, method: 'POST' });
  check('站名是保留字 → 400', reservedSite.res.status === 400, `status=${reservedSite.res.status}`);

  const anonUpload = await api('/api/upload', { body: { html: '<p>x</p>', name: 'nobody-site' }, method: 'POST' });
  check('未登录上传 → 401', anonUpload.res.status === 401, `status=${anonUpload.res.status}`);

  const html1 = '<!doctype html><meta charset="utf-8"><title>冒烟</title><h1>第一版</h1>';
  const upload = await api('/api/upload', { body: { html: html1, name: SITE }, cookie: a.cookie, method: 'POST' });
  check('上传站点 201', upload.res.status === 201, `status=${upload.res.status} ${JSON.stringify(upload.body)}`);
  check('返回可访问地址', typeof upload.body?.url === 'string' && upload.body.url.endsWith(`/${SITE}`), upload.body?.url);

  const dupeSite = await api('/api/upload', { body: { html: html1, name: SITE }, cookie: a.cookie, method: 'POST' });
  check('同名重传 → 409', dupeSite.res.status === 409, `status=${dupeSite.res.status}`);

  const page = await api(`/${SITE}`);
  check('站点页面 200', page.res.status === 200, `status=${page.res.status}`);
  check('站点页面内容正确', page.text.includes('第一版'));
  const csp = page.res.headers.get('content-security-policy') ?? '';
  check('站点页面带 sandbox CSP', csp.includes('sandbox'), csp);
  check('CSP 不含 allow-same-origin', !csp.includes('allow-same-origin'), csp);

  const mySites = await api('/api/sites', { cookie: a.cookie });
  check('我的站点列表里有它', mySites.body?.sites?.some((s) => s.name === SITE), JSON.stringify(mySites.body?.sites?.map((s) => s.name)));

  const detail = await api(`/api/sites/${SITE}`, { cookie: a.cookie });
  check('站点详情 200', detail.res.status === 200, `status=${detail.res.status}`);

  const html2 = '<!doctype html><meta charset="utf-8"><title>冒烟</title><h1>第二版</h1>';
  const saveHtml = await api(`/api/sites/${SITE}`, { body: { html: html2 }, cookie: a.cookie, method: 'PUT' });
  check('保存单页 HTML 成功', saveHtml.body?.ok === true, JSON.stringify(saveHtml.body));
  const page2 = await api(`/${SITE}`);
  check('重新访问看到第二版', page2.text.includes('第二版'));

  const saveMeta = await api(`/api/sites/${SITE}/meta`, {
    body: { description: '冒烟测试用的站点', tag: 'docs', title: '冒烟站点' },
    cookie: a.cookie,
    method: 'PUT',
  });
  check('保存站点信息成功', saveMeta.body?.ok === true, JSON.stringify(saveMeta.body));

  const badTag = await api(`/api/sites/${SITE}/meta`, {
    body: { description: 'x', tag: '随便写的标签', title: 'x' },
    cookie: a.cookie,
    method: 'PUT',
  });
  check('非法内容标签 → 400', badTag.body?.ok === false && badTag.res.status === 400, `status=${badTag.res.status} ${JSON.stringify(badTag.body)}`);

  const detail2 = await api(`/api/sites/${SITE}`, { cookie: a.cookie });
  const metaOk =
    detail2.body?.site?.title === '冒烟站点' &&
    detail2.body?.site?.description === '冒烟测试用的站点' &&
    detail2.body?.site?.tag === 'docs' &&
    detail2.body?.site?.tagLabel === '学习笔记';
  check('站点信息读回一致（含 tagLabel）', metaOk, JSON.stringify(detail2.body?.site));

  const fileHtml = '<!doctype html><meta charset="utf-8"><title>子页</title><p>子页面内容</p>';
  const putIndex = await api(`/api/sites/${SITE}/files?path=index.html`, {
    cookie: a.cookie,
    method: 'POST',
    raw: fileHtml,
    type: 'text/html; charset=utf-8',
  });
  check('上传 index.html 成功', putIndex.res.status === 201 || putIndex.res.status === 200, `status=${putIndex.res.status}`);

  const css = 'body { color: rgb(1, 2, 3); }';
  const putCss = await api(`/api/sites/${SITE}/files?path=assets/a.css`, {
    cookie: a.cookie,
    method: 'POST',
    raw: css,
    type: 'text/css; charset=utf-8',
  });
  check('上传子目录文件成功', putCss.res.status === 201 || putCss.res.status === 200, `status=${putCss.res.status}`);

  const files = await api(`/api/sites/${SITE}/files`, { cookie: a.cookie });
  const fileList = files.body?.files ?? [];
  check('文件列表 2 个', fileList.length === 2, JSON.stringify(fileList.map((f) => f.path)));
  check('文件带大小字段', fileList.every((f) => typeof f.size === 'number' && f.size > 0), JSON.stringify(fileList));

  const content = await api(`/api/sites/${SITE}/files/content?path=index.html`, { cookie: a.cookie });
  check('读回文件内容一致', content.body?.content === fileHtml, JSON.stringify(content.body?.content?.slice(0, 60)));

  const serveIndex = await api(`/${SITE}/index.html`);
  check('子页面可访问且内容一致', serveIndex.res.status === 200 && serveIndex.text === fileHtml, `status=${serveIndex.res.status}`);
  const serveCss = await api(`/${SITE}/assets/a.css`);
  check('子目录静态文件可访问', serveCss.res.status === 200 && serveCss.text === css, `status=${serveCss.res.status}`);
  check('CSS 这类非文档资源不套沙箱头（不必要）', !serveCss.res.headers.get('content-security-policy'), serveCss.res.headers.get('content-security-policy') ?? '');

  // svg 能带脚本，必须和 html 一样关进沙箱
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
  await api(`/api/sites/${SITE}/files?path=assets/icon.svg`, {
    cookie: a.cookie,
    method: 'POST',
    raw: svg,
    type: 'image/svg+xml',
  });
  const serveSvg = await api(`/${SITE}/assets/icon.svg`);
  const svgCsp = serveSvg.res.headers.get('content-security-policy') ?? '';
  check('svg 也带 sandbox CSP', serveSvg.res.status === 200 && svgCsp.includes('sandbox'), `status=${serveSvg.res.status} ${svgCsp}`);
  check('svg 的 CSP 同样不含 allow-same-origin', !svgCsp.includes('allow-same-origin'), svgCsp);

  const traversal = await api(`/api/sites/${SITE}/files?path=../evil.html`, {
    cookie: a.cookie,
    method: 'POST',
    raw: 'x',
    type: 'text/html',
  });
  check('路径穿越被拒', traversal.res.status >= 400, `status=${traversal.res.status}`);

  const bigHtml = `<p>${'x'.repeat(2 * 1024 * 1024)}</p>`;
  const tooBig = await api('/api/upload', { body: { html: bigHtml, name: 'smoke-too-big' }, cookie: a.cookie, method: 'POST' });
  check('单页上传超过 2MB → 413', tooBig.res.status === 413, `status=${tooBig.res.status}`);

  const hugeFile = `<p>${'y'.repeat(10 * 1024 * 1024)}</p>`;
  const huge = await api(`/api/sites/${SITE}/files?path=huge.html`, {
    cookie: a.cookie,
    method: 'POST',
    raw: hugeFile,
    type: 'text/html',
  });
  check('多文件站点单文件超过 10MB → 413', huge.res.status === 413, `status=${huge.res.status}`);

  // 浏览计数：连续访问两次
  await api(`/${SITE}`);
  await api(`/${SITE}`);
  const stats = await api(`/api/sites/${SITE}/stats`, { cookie: a.cookie });
  check('浏览计数是数字', typeof stats.body?.stats?.views === 'number', JSON.stringify(stats.body?.stats));
  check('浏览计数累计到 2 以上', (stats.body?.stats?.views ?? 0) >= 2, JSON.stringify(stats.body?.stats));

  // ---------------------------------------------------------- 5. 社交
  console.log('\n社交互动');

  const like = await api(`/api/sites/${SITE}/like`, { cookie: b.cookie, method: 'POST' });
  check('点赞成功', like.body?.ok === true, JSON.stringify(like.body));
  const likeAgain = await api(`/api/sites/${SITE}/like`, { cookie: b.cookie, method: 'POST' });
  check('重复点赞幂等', likeAgain.body?.ok === true, JSON.stringify(likeAgain.body));
  const statLiked = await api(`/api/sites/${SITE}/stats`, { cookie: a.cookie });
  check('点赞数 = 1（数字）', statLiked.body?.stats?.likes === 1, JSON.stringify(statLiked.body?.stats));
  const unlike = await api(`/api/sites/${SITE}/like`, { cookie: b.cookie, method: 'DELETE' });
  check('取消点赞成功', unlike.body?.ok === true, JSON.stringify(unlike.body));
  const statUnliked = await api(`/api/sites/${SITE}/stats`, { cookie: a.cookie });
  check('点赞数回到 0', statUnliked.body?.stats?.likes === 0, JSON.stringify(statUnliked.body?.stats));

  const comment = await api(`/api/sites/${SITE}/comments`, { body: { content: '这是 b 的评论' }, cookie: b.cookie, method: 'POST' });
  check('发表评论成功', comment.body?.ok === true, JSON.stringify(comment.body));
  const comments = await api(`/api/sites/${SITE}/comments`);
  check('评论列表 1 条', comments.body?.comments?.length === 1, JSON.stringify(comments.body?.comments?.length));
  check('评论带作者（JOIN users）', comments.body?.comments?.[0]?.author?.id === b.user.id, JSON.stringify(comments.body?.comments?.[0]?.author));
  const parentId = comments.body?.comments?.[0]?.id;

  const reply = await api(`/api/sites/${SITE}/comments`, { body: { content: '这是回复', replyTo: parentId }, cookie: a.cookie, method: 'POST' });
  check('回复评论成功', reply.body?.ok === true, JSON.stringify(reply.body));
  const comments2 = await api(`/api/sites/${SITE}/comments`);
  check('评论列表 2 条（含回复）', comments2.body?.comments?.length === 2, JSON.stringify(comments2.body?.comments?.length));

  const delComment = await api(`/api/sites/${SITE}/comments/${parentId}`, { cookie: b.cookie, method: 'DELETE' });
  check('删除自己的评论成功', delComment.body?.ok === true, JSON.stringify(delComment.body));

  const fav = await api(`/api/sites/${SITE}/favorite`, { body: { folder: '冒烟收藏夹' }, cookie: b.cookie, method: 'POST' });
  check('收藏成功', fav.body?.ok === true, JSON.stringify(fav.body));
  const favs = await api('/api/favorites', { cookie: b.cookie });
  check(
    '收藏列表里有它',
    favs.body?.sites?.some((f) => f.name === SITE),
    `status=${favs.res.status} ${JSON.stringify(favs.body?.sites?.map((f) => f.name))}`,
  );
  const unfav = await api(`/api/sites/${SITE}/favorite`, { cookie: b.cookie, method: 'DELETE' });
  check('取消收藏成功', unfav.body?.ok === true, JSON.stringify(unfav.body));

  const follow = await api(`/api/users/${a.user.id}/follow`, { cookie: b.cookie, method: 'POST' });
  check('关注成功', follow.body?.ok === true, JSON.stringify(follow.body));
  const followers = await api(`/api/users/${a.user.id}/follow-list?type=followers`);
  check(
    '粉丝列表 1 人（JOIN users）',
    followers.body?.users?.length === 1,
    `status=${followers.res.status} ${JSON.stringify(followers.body)?.slice(0, 160)}`,
  );
  const unfollow = await api(`/api/users/${a.user.id}/follow`, { cookie: b.cookie, method: 'DELETE' });
  check('取消关注成功', unfollow.body?.ok === true, JSON.stringify(unfollow.body));

  const history = await api('/api/history', { body: { site: SITE }, cookie: b.cookie, method: 'POST' });
  check('记录浏览历史成功', history.body?.ok === true, JSON.stringify(history.body));
  await api('/api/history', { body: { site: SITE }, cookie: b.cookie, method: 'POST' });
  const historyList = await api('/api/history', { cookie: b.cookie });
  check(
    '重复浏览同站仍只有 1 条（upsert 生效）',
    historyList.body?.sites?.length === 1,
    `status=${historyList.res.status} ${JSON.stringify(historyList.body)?.slice(0, 160)}`,
  );

  const send = await api(`/api/messages/${a.user.id}`, { body: { content: '你好，这是私信' }, cookie: b.cookie, method: 'POST' });
  check('发私信成功', send.body?.ok === true, JSON.stringify(send.body));
  const convs = await api('/api/messages', { cookie: a.cookie });
  check('会话列表 1 条（JOIN users）', convs.body?.conversations?.length === 1, JSON.stringify(convs.body?.conversations));
  const thread = await api(`/api/messages/${b.user.id}`, { cookie: a.cookie });
  check('私信内容读回一致', thread.body?.messages?.[0]?.content === '你好，这是私信', JSON.stringify(thread.body?.messages?.[0]?.content));

  // 通知是「按当前互动数据算出来的」（没有事件表），所以先把互动补上再看
  await api(`/api/sites/${SITE}/like`, { cookie: b.cookie, method: 'POST' });
  const notifications = await api('/api/notifications', { cookie: a.cookie });
  check(
    'a 收到互动通知',
    (notifications.body?.items?.length ?? 0) > 0,
    `status=${notifications.res.status} ${JSON.stringify(notifications.body)?.slice(0, 200)}`,
  );
  const seen = await api('/api/notifications/seen', { cookie: a.cookie, method: 'POST' });
  check('标记通知已读成功', seen.body?.ok === true, JSON.stringify(seen.body));
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

  // ---------------------------------------------------------- 6. 权限边界
  console.log('\n权限边界');

  const anonSites = await api('/api/sites');
  check('未登录看我的站点 → 401', anonSites.res.status === 401, `status=${anonSites.res.status}`);

  const stealHtml = await api(`/api/sites/${SITE}`, { body: { html: '<p>篡改</p>' }, cookie: b.cookie, method: 'PUT' });
  check('改别人的站点被拒', stealHtml.res.status === 403 || stealHtml.res.status === 404, `status=${stealHtml.res.status}`);

  const stealDelete = await api(`/api/sites/${SITE}`, { cookie: b.cookie, method: 'DELETE' });
  check('删别人的站点被拒', stealDelete.res.status === 403 || stealDelete.res.status === 404, `status=${stealDelete.res.status}`);

  const stealFiles = await api(`/api/sites/${SITE}/files`, { cookie: b.cookie });
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
  check('用户列表含 3 个账号', (users.body?.users?.length ?? 0) === 3, JSON.stringify(users.body?.users?.map((u) => u.email)));
  check('用户列表不含 password_hash', !JSON.stringify(users.body).includes('password_hash'));

  const adminSites = await api('/api/admin/sites', { cookie: admin.cookie });
  check('后台站点列表含冒烟站点', adminSites.body?.sites?.some((s) => s.name === SITE), JSON.stringify(adminSites.body?.sites?.map((s) => s.name)));
  const siteId = adminSites.body?.sites?.find((s) => s.name === SITE)?.id;

  const ban = await api(`/api/admin/users/${b.user.id}/status`, { body: { status: 'banned' }, cookie: admin.cookie, method: 'POST' });
  check('封禁用户成功', ban.body?.ok === true, JSON.stringify(ban.body));
  const bannedLogin = await api('/api/auth/login', { body: { login: B_EMAIL, password: PASS }, method: 'POST' });
  check('被封账号登录 → 403', bannedLogin.res.status === 403, `status=${bannedLogin.res.status}`);
  const unban = await api(`/api/admin/users/${b.user.id}/status`, { body: { status: 'active' }, cookie: admin.cookie, method: 'POST' });
  check('解封成功', unban.body?.ok === true, JSON.stringify(unban.body));

  const offline = await api(`/api/admin/sites/${siteId}/status`, { body: { status: 'offline' }, cookie: admin.cookie, method: 'POST' });
  check('下线站点成功', offline.body?.ok === true, `status=${offline.res.status} ${JSON.stringify(offline.body)}`);
  const offlineView = await api(`/${SITE}`);
  check('下线后匿名访问 451', offlineView.res.status === 451, `status=${offlineView.res.status}`);
  const backOnline = await api(`/api/admin/sites/${siteId}/status`, { body: { status: 'active' }, cookie: admin.cookie, method: 'POST' });
  check('恢复站点成功', backOnline.body?.ok === true, `status=${backOnline.res.status} ${JSON.stringify(backOnline.body)}`);
  const onlineView = await api(`/${SITE}`);
  check('恢复后可访问', onlineView.res.status === 200, `status=${onlineView.res.status}`);

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

  // ---------------------------------------------------------- 10. 删除与级联
  console.log('\n删除与级联');

  const delFile = await api(`/api/sites/${SITE}/files?path=assets/a.css`, { cookie: aCookie, method: 'DELETE' });
  check('删除子文件成功', delFile.body?.ok === true, JSON.stringify(delFile.body));
  const files3 = await api(`/api/sites/${SITE}/files`, { cookie: aCookie });
  check('删除后文件列表剩 2 个', files3.body?.files?.length === 2, JSON.stringify(files3.body?.files?.map((f) => f.path)));

  const delSite = await api(`/api/sites/${SITE}`, { cookie: aCookie, method: 'DELETE' });
  check('删除站点成功', delSite.body?.ok === true, JSON.stringify(delSite.body));
  const afterDel = await api(`/${SITE}`);
  check('删除后访问 404', afterDel.res.status === 404, `status=${afterDel.res.status}`);
  const filesAfter = await api(`/api/sites/${SITE}/files`, { cookie: aCookie });
  check('删除后文件接口 404/403', filesAfter.res.status === 404 || filesAfter.res.status === 403, `status=${filesAfter.res.status}`);
  const mySites2 = await api('/api/sites', { cookie: aCookie });
  check('删除后我的站点列表为空', (mySites2.body?.sites?.length ?? -1) === 0, JSON.stringify(mySites2.body?.sites?.length));
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
