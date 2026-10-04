// MCP 冒烟测试。
//
// 用法（先起一个干净的测试服务，别拿常驻的 3000 端口跑）：
//
//   $env:PORT=3100; $env:DB_FILE='data/mcp-smoke.db'; node server.js
//   node scripts/mcp-smoke.mjs
//
// 跨账号隔离（第二个账号拿自己的密钥去碰第一个账号的站点，应当全被拒）：
//
//   node scripts/mcp-smoke.mjs --isolation smoke-friend
//
// 吊销（吊销后密钥立刻失效）：
//
//   node scripts/mcp-smoke.mjs --revoke-check
//
// 封禁联动（账号被封后手里的密钥立刻失效）——以被封用户的身份跑：
//
//   $env:SMOKE_LOGIN='b@smoke.local'; node scripts/mcp-smoke.mjs --ban-check b@smoke.local
//
// 登录身份默认 admin/123（种子管理员），可用 SMOKE_LOGIN / SMOKE_PASSWORD 覆盖；
// 管理员身份用 ADMIN_LOGIN / ADMIN_PASSWORD 覆盖；服务地址用 BASE_URL 覆盖。

// ---------------------------------------------------------------- 为什么要单独起一套服务
//
// 这脚本会真写库：建站、上传和删文件、删站、吊销密钥，--ban-check 那条还会真的把账号封掉
// 再解封。拿常驻的开发服务跑，等于把真实数据当测试数据，所以先按文件头那行命令起一个
// 干净的 PORT + DB_FILE，跑完连库文件一起删。
//
// 断言本身就依赖「库是干净的」：新账户站点列表必须为空、结束时站点数必须正好 2。
// 另外每次运行都会新建一把 label='smoke' 的密钥却不回收，同一个账号攒到
// MCP_TOKENS_PER_USER（10 把）就会被上限挡住，连建密钥都会失败。
// 端口也要独立：和正在跑的 3000 撞上会莫名其妙地打到别的库。

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const LOGIN = process.env.SMOKE_LOGIN ?? 'admin';
const PASSWORD = process.env.SMOKE_PASSWORD ?? '123';

const args = process.argv.slice(2);
const isolationIndex = args.indexOf('--isolation');

let passed = 0;
let failed = 0;

/**
 * 记一条断言结果：通过打 ✓，不通过打 ✗ 并把 detail 附在后面（detail 只在失败时显示）。
 *
 * 只累加 passed / failed，不抛错也不中断——某条挂了后面的检查照跑，
 * 一次运行就能拿到完整清单，最后由退出码统一表态。
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`);
  }
}

/**
 * 薄封装 fetch：body 有值时自动 JSON 序列化并带上 Content-Type，cookie 是整条 Cookie 头。
 *
 * 不抛 HTTP 错误，JSON 解析失败时 body 为 null，所以调用方必须自己看 res.status 或 body?.ok
 * ——这条脚本里既要用状态码断言（401 / 405 / 413），也要用 body.ok 断言，两者都不能省。
 */
async function api(path, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method,
  });
  return { body: await res.json().catch(() => null), res };
}

/**
 * 用网页登录接口换一个 Cookie 会话，返回 { cookie, user }。
 * Set-Cookie 的多个头只取每条的 name=value 拼成一条 Cookie，属性（Path / HttpOnly / Max-Age）丢掉。
 * 登录失败直接抛：后面的接口全靠这个 cookie，继续跑没有意义。
 */
async function login(loginValue = LOGIN, passwordValue = PASSWORD) {
  const { res, body } = await api('/api/auth/login', {
    body: { login: loginValue, password: passwordValue },
    method: 'POST',
  });
  if (!body?.ok) throw new Error(`登录失败：${body?.message ?? res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return { cookie, user: body.user };
}

/** 管理员会话 Cookie 的缓存，第一次调用 adminApi 时登录并填上。 */
let adminCookie = '';

/** 用管理员身份调接口（封禁联动那条要用），登录态懒加载一次。 */
async function adminApi(path, options = {}) {
  if (!adminCookie) {
    const session = await login(
      process.env.ADMIN_LOGIN ?? 'admin',
      process.env.ADMIN_PASSWORD ?? '123',
    );
    adminCookie = session.cookie;
  }
  return api(path, { ...options, cookie: adminCookie });
}

/**
 * 建一把密钥，只拿走明文 token（record 里的 id / 时间这里用不上）。
 * 明文只在创建响应里出现一次，所以后续所有 MCP 调用都靠它。
 */
async function mintToken(cookie, label) {
  const { body } = await api('/api/mcp/tokens', { body: { label }, cookie, method: 'POST' });
  if (!body?.ok) throw new Error(`创建密钥失败：${body?.message}`);
  return body.token;
}

/**
 * 直接往 /mcp 发一条 JSON-RPC 消息，密钥走 Authorization 头。
 * token 为空串时不带 Authorization —— 这是故意留的，用来验证「没密钥就 401」。
 * 只看 body 和 res，不检查状态码：状态码断言留给调用方，这样同一个函数能测 200 / 202 / 401 各分支。
 */
async function rpc(token, method, params, id = 1) {
  const res = await fetch(`${BASE}/mcp`, {
    body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    method: 'POST',
  });
  return { body: await res.json().catch(() => null), res };
}

/** 调一个工具，返回 { isError, text, data }。JSON-RPC 层面的错误直接抛。 */
async function call(token, name, toolArgs = {}) {
  const { body } = await rpc(token, 'tools/call', { arguments: toolArgs, name });
  if (!body?.result) throw new Error(`JSON-RPC error: ${JSON.stringify(body)}`);
  return {
    data: body.result.structuredContent,
    isError: Boolean(body.result.isError),
    text: body.result.content?.[0]?.text ?? '',
  };
}

// ---------------------------------------------------------------- 隔离模式

/** 用「不是站主」的密钥去操作别人的站点，八种操作必须全部被拒。 */
async function runIsolation(token, siteName) {
  if (!siteName) throw new Error('--isolation 后面要跟一个站点名');
  console.log(`\n跨账号隔离：用别人的密钥操作 "${siteName}"，应当全部被拒\n`);

  for (const [tool, toolArgs, label] of [
    ['get_site', { name: siteName }, 'get_site 拒绝'],
    ['list_files', { name: siteName }, 'list_files 拒绝'],
    ['read_file', { name: siteName, path: 'index.html' }, 'read_file 拒绝'],
    ['update_site_html', { name: siteName, html: '<p>x</p>' }, 'update_site_html 拒绝'],
    ['update_site_meta', { name: siteName, title: 'x' }, 'update_site_meta 拒绝'],
    ['write_file', { name: siteName, path: 'evil.html', content: 'x' }, 'write_file 拒绝'],
    ['delete_file', { name: siteName, path: 'index.html' }, 'delete_file 拒绝'],
    ['delete_site', { name: siteName }, 'delete_site 拒绝'],
  ]) {
    const result = await call(token, tool, toolArgs);
    const rejected = result.isError && result.text.includes('不是你自己的站点');
    check(label, rejected, result.text.slice(0, 80));
  }
}

// ---------------------------------------------------------------- 封禁联动

/**
 * 账号被封之后，手里的密钥必须立刻失效——否则「封号」在 MCP 这条路上等于没做。
 * 需要两个身份：SMOKE_LOGIN 是被封的那个普通用户，管理员用 ADMIN_LOGIN 登。
 */
async function runBanCheck(token, email, sessionUser) {
  const users = await adminApi('/api/admin/users');
  const target = users.body?.users?.find((u) => u.email === email);
  if (!target) throw new Error(`管理员用户列表里没有 ${email}`);
  if (target.id !== sessionUser.id) {
    throw new Error(`SMOKE_LOGIN 登的是 ${sessionUser.email}，不是要封的 ${email}`);
  }

  console.log(`\n封禁联动：封掉用户 ${target.id}（${email}）后，它的密钥应当立刻失效\n`);

  const before = await rpc(token, 'tools/list');
  check('封禁前密钥可用', before.res.status === 200, `status=${before.res.status}`);

  const banned = await adminApi(`/api/admin/users/${target.id}/status`, {
    body: { status: 'banned' },
    method: 'POST',
  });
  check('管理员封禁成功', banned.body?.ok === true, JSON.stringify(banned.body));

  const after = await rpc(token, 'tools/list');
  check('封禁后密钥 401', after.res.status === 401, `status=${after.res.status}`);

  const restored = await adminApi(`/api/admin/users/${target.id}/status`, {
    body: { status: 'active' },
    method: 'POST',
  });
  check('解封成功', restored.body?.ok === true, JSON.stringify(restored.body));

  const again = await rpc(token, 'tools/list');
  check('解封后密钥恢复可用', again.res.status === 200, `status=${again.res.status}`);
}

// ---------------------------------------------------------------- 密钥吊销

/**
 * 验证吊销链路：吊销前可用（200）→ 吊销 → 立刻 401 → 再吊销一次 404。
 *
 * 待吊销的那把是按 label='smoke' 去 /api/mcp/tokens 里找的，所以依赖入口用同一个 label 建密钥；
 * 同 label 有多把时列表按 id 倒序，取到的正是本次刚建的那把。
 * 关键在于「吊销后立刻 401」：吊销就是删行，鉴权必须当场查不到，不能有任何缓存兜着。
 */
async function runRevokeCheck(cookie, token) {
  console.log('\n吊销：吊销后密钥立刻失效\n');

  const before = await rpc(token, 'tools/list');
  check('吊销前可用', before.res.status === 200, `status=${before.res.status}`);

  const mine = await api('/api/mcp/tokens', { cookie });
  const created = mine.body.tokens?.find((t) => t.label === 'smoke');
  if (!created) throw new Error('找不到刚创建的 smoke 密钥');

  const revoked = await api(`/api/mcp/tokens/${created.id}/revoke`, { cookie, method: 'POST' });
  check('吊销成功', revoked.body?.ok === true, JSON.stringify(revoked.body));

  const after = await rpc(token, 'tools/list');
  check('吊销后 401', after.res.status === 401, `status=${after.res.status}`);

  const twice = await api(`/api/mcp/tokens/${created.id}/revoke`, { cookie, method: 'POST' });
  check('重复吊销 → 404', twice.res.status === 404, `status=${twice.res.status}`);
}

// ---------------------------------------------------------------- 主流程

/**
 * 主流程回归：密钥管理 → 协议层 → 单页站 → 多页站 → 收尾。
 *
 * 前提是库干净：开头就断言新账户站点列表为空，结尾断言删完清空、站点数正好 2。
 * 副作用：结尾会留下一个 SMOKE_FRIEND（默认 smoke-friend）站点给隔离测试用，
 * 那把 'smoke' 密钥也不回收——所以同一个库反复跑会攒到密钥上限。
 * 这里只打印「接着跑隔离测试」的提示，不自己跑：隔离测试必须换另一个账号的密钥。
 */
async function runMain(cookie, token) {
  // --- 密钥管理 ---
  console.log('密钥管理');

  const badCreate = await api('/api/mcp/tokens', { body: { label: '  ' }, cookie, method: 'POST' });
  check('空名字建密钥被拒', badCreate.res.status === 400, `status=${badCreate.res.status}`);

  check('密钥带 mp_mcp_ 前缀', token.startsWith('mp_mcp_'));

  const list = await api('/api/mcp/tokens', { cookie });
  check('密钥列表里能看到它', list.body.tokens?.some((t) => t.label === 'smoke'));

  const unauth = await rpc('', 'tools/list');
  check('没有密钥 → 401', unauth.res.status === 401, `status=${unauth.res.status}`);

  const wrongToken = await rpc(`mp_mcp_${'a'.repeat(43)}`, 'tools/list');
  check('错密钥 → 401', wrongToken.res.status === 401, `status=${wrongToken.res.status}`);

  const getOnMcp = await fetch(`${BASE}/mcp`);
  check('GET /mcp → 405', getOnMcp.status === 405, `status=${getOnMcp.status}`);

  const pathToken = await fetch(`${BASE}/mcp/${token}`, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  check('密钥走路径段也能用', pathToken.status === 200, `status=${pathToken.status}`);

  // --- 协议层 ---
  console.log('\n协议层');

  const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18' });
  check('initialize 返回 serverInfo', init.body?.result?.serverInfo?.name === 'minepage-mcp');
  check('protocolVersion 回显一致', init.body?.result?.protocolVersion === '2025-06-18');
  check('instructions 非空', (init.body?.result?.instructions ?? '').length > 100);

  const initOld = await rpc(token, 'initialize', { protocolVersion: '2024-11-05' });
  check('旧协议版本被接受', initOld.body?.result?.protocolVersion === '2024-11-05');

  const notif = await rpc(token, 'notifications/initialized');
  check('通知回 202 空体', notif.res.status === 202, `status=${notif.res.status}`);

  const ping = await rpc(token, 'ping');
  check('ping 有响应', ping.res.status === 200 && ping.body?.result !== undefined);

  const unknown = await rpc(token, 'no/such/method');
  check('未知方法 → -32601', unknown.body?.error?.code === -32601);

  const unknownTool = await rpc(token, 'tools/call', { name: 'nope' });
  check('未知工具 → -32602', unknownTool.body?.error?.code === -32602);

  const tools = await rpc(token, 'tools/list');
  const descriptors = tools.body?.result?.tools ?? [];
  check('tools/list 给出 10 个工具', descriptors.length === 10, descriptors.map((t) => t.name).join(','));
  check('读工具标了 readOnly', descriptors.find((t) => t.name === 'list_sites').annotations.readOnlyHint === true);
  check('删站标了 destructive', descriptors.find((t) => t.name === 'delete_site').annotations.destructiveHint === true);

  // --- 单页站 ---
  console.log('\n单页站');

  const empty = await call(token, 'list_sites');
  check('新账户站点列表为空', empty.data.count === 0);

  const created = await call(token, 'create_site', { html: '<!DOCTYPE html><h1>v1</h1>', name: 'smoke-single' });
  check('create_site 成功', !created.isError && created.data.name === 'smoke-single', created.text);
  check('create_site 给出访问地址', created.data?.url?.endsWith('/smoke-single'), created.data?.url);

  const dup = await call(token, 'create_site', { html: '<h1>x</h1>', name: 'smoke-single' });
  check('重名建站被拒', dup.isError && dup.text.includes('已经被占用'), dup.text);

  const reserved = await call(token, 'create_site', { html: '<h1>x</h1>', name: 'mcp' });
  check('保留名被拒', reserved.isError, reserved.text);

  const badName = await call(token, 'create_site', { html: '<h1>x</h1>', name: 'A B' });
  check('非法站名被拒', badName.isError, badName.text);

  const tooBig = await call(token, 'create_site', { html: 'x'.repeat(2 * 1024 * 1024 + 1), name: 'smoke-big' });
  check('超过 2MB 被拒', tooBig.isError && tooBig.text.includes('太大'), tooBig.text);

  const detail = await call(token, 'get_site', { name: 'smoke-single' });
  check('get_site 带上 HTML', detail.data?.site?.html === '<!DOCTYPE html><h1>v1</h1>');
  check('get_site 标成 single', detail.data?.site?.kind === 'single');

  const meta = await call(token, 'update_site_meta', { name: 'smoke-single', tag: 'portfolio', title: '冒烟测试' });
  check('update_site_meta 成功', meta.data?.title === '冒烟测试' && meta.data?.tagLabel === '作品集');

  const metaPartial = await call(token, 'update_site_meta', { description: '只改简介', name: 'smoke-single' });
  check('只传一个字段时其他字段保持', metaPartial.data?.title === '冒烟测试' && metaPartial.data?.description === '只改简介');

  const badTag = await call(token, 'update_site_meta', { name: 'smoke-single', tag: 'nope' });
  check('非法标签被拒', badTag.isError, badTag.text);

  const updated = await call(token, 'update_site_html', { html: '<!DOCTYPE html><h1>v2</h1>', name: 'smoke-single' });
  check('update_site_html 成功', !updated.isError && updated.data.size > 0, updated.text);

  const reread = await call(token, 'get_site', { name: 'smoke-single' });
  check('HTML 确实被换掉了', reread.data.site.html.includes('v2'));

  // --- 多页站 ---
  console.log('\n多页站');

  const multi = await call(token, 'write_file', {
    content: '<!DOCTYPE html><link rel="stylesheet" href="style.css"><h1>multi</h1>',
    name: 'smoke-multi',
    path: 'index.html',
  });
  check('write_file 自动建站', multi.data?.siteCreated === true && multi.data?.fileCreated === true, multi.text);

  await call(token, 'write_file', { content: 'h1 { color: red }', name: 'smoke-multi', path: 'style.css' });

  const binary = await call(token, 'write_file', {
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('base64'),
    encoding: 'base64',
    name: 'smoke-multi',
    path: 'logo.png',
  });
  check('base64 写二进制成功', !binary.isError && binary.data.size === 6, binary.text);

  const badBase64 = await call(token, 'write_file', { content: '!!!not base64!!!', encoding: 'base64', name: 'smoke-multi', path: 'x.bin' });
  check('非法 base64 被拒', badBase64.isError, badBase64.text);

  const multiDetail = await call(token, 'get_site', { name: 'smoke-multi' });
  check('多页站 html 为 null', multiDetail.data.site.html === null && multiDetail.data.site.kind === 'multi');

  const files = await call(token, 'list_files', { name: 'smoke-multi' });
  check('文件清单有 3 个', files.data.total === 3, JSON.stringify(files.data.files.map((f) => f.path)));

  const readCss = await call(token, 'read_file', { name: 'smoke-multi', path: 'style.css' });
  check('read_file 读文本', readCss.data.content === 'h1 { color: red }' && readCss.data.binary === false);

  const readPng = await call(token, 'read_file', { name: 'smoke-multi', path: 'logo.png' });
  check('read_file 二进制标 binary', readPng.data.binary === true && readPng.data.content.startsWith('iVBOR'));

  const badPath = await call(token, 'read_file', { name: 'smoke-multi', path: '../secret' });
  check('路径穿越被拒', badPath.isError, badPath.text);

  const overwrite = await call(token, 'write_file', { content: 'h1 { color: blue }', name: 'smoke-multi', path: 'style.css' });
  check('覆盖已有文件时 fileCreated=false', overwrite.data.fileCreated === false);

  const multiHtmlEdit = await call(token, 'update_site_html', { html: '<h1>x</h1>', name: 'smoke-multi' });
  check('多页站禁止整体替换 HTML', multiHtmlEdit.isError && multiHtmlEdit.text.includes('多页'), multiHtmlEdit.text);

  const removed = await call(token, 'delete_file', { name: 'smoke-multi', path: 'logo.png' });
  check('delete_file 成功', removed.data?.deleted === true);

  const gone = await call(token, 'delete_file', { name: 'smoke-multi', path: 'logo.png' });
  check('删不存在的文件报错', gone.isError, gone.text);

  const afterDelete = await call(token, 'list_files', { name: 'smoke-multi' });
  check('删完剩 2 个', afterDelete.data.total === 2);

  // --- 收尾 ---
  console.log('\n收尾');

  const all = await call(token, 'list_sites');
  check('站点列表有 2 个', all.data.count === 2, `count=${all.data.count}`);

  const delMulti = await call(token, 'delete_site', { name: 'smoke-multi' });
  check('delete_site 成功', delMulti.data?.deleted === true);

  const delMissing = await call(token, 'delete_site', { name: 'smoke-multi' });
  check('删不存在的站点报错', delMissing.isError, delMissing.text);

  const delSingle = await call(token, 'delete_site', { name: 'smoke-single' });
  check('单页站也能删', delSingle.data?.deleted === true);

  const finalList = await call(token, 'list_sites');
  check('删完列表清空', finalList.data.count === 0);

  // 留一个站点给隔离测试用：换个账号、拿它的密钥来碰这个站点，应当全被拒
  const friend = process.env.SMOKE_FRIEND ?? 'smoke-friend';
  const friendSite = await call(token, 'create_site', {
    html: '<!DOCTYPE html><h1>friend</h1>',
    name: friend,
  });
  check(`保留 "${friend}" 供隔离测试使用`, !friendSite.isError, friendSite.text);

  console.log(`\n接着跑隔离测试：node scripts/mcp-smoke.mjs --isolation ${friend}`);
}

// ---------------------------------------------------------------- 入口

// 四种模式互斥，按命令行参数挑一个跑；不管是哪一种，都先登录并新建一把 label='smoke' 的密钥。
const { cookie, user } = await login();
console.log(`\n以 ${user.email}（id=${user.id}）登录 ${BASE}\n`);

const token = await mintToken(cookie, 'smoke');

const banIndex = args.indexOf('--ban-check');
const revokeIndex = args.indexOf('--revoke-check');

if (isolationIndex !== -1) {
  await runIsolation(token, args[isolationIndex + 1]);
} else if (banIndex !== -1) {
  await runBanCheck(token, args[banIndex + 1] ?? user.email, user);
} else if (revokeIndex !== -1) {
  await runRevokeCheck(cookie, token);
} else {
  await runMain(cookie, token);
}

console.log(`\n${failed === 0 ? '全过' : '有失败'}：${passed} 项通过，${failed} 项失败\n`);

// 用 exitCode 而不是 process.exit()：fetch 的 keep-alive 连接还在关的时候强退，
// 在 Windows 上会触发 libuv 的 UV_HANDLE_CLOSING 断言，把好结果报成崩溃。
process.exitCode = failed === 0 ? 0 : 1;
