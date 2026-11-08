// 投稿页（/sites?tab=upload）的浏览器冒烟测试：已选文件可逐个移除 + 折叠「更多设置」。
//
// 接口层那些断言在 api-smoke.mjs 里；这个脚本专门盯页面的交互，因为文件列表的
// 移除按钮、模式徽章的自动切换全靠 DOM 事件，接口测不到。
//
//   # 先起一个冒烟服务（自己不会拉服务，省得和 api-smoke 抢端口/清库）
//   $env:PORT=3105; $env:MYSQL_DATABASE='minepage_smoke'; ...; node server.js
//   BASE_URL=http://127.0.0.1:3105 node scripts/upload-page-smoke.mjs
//
// 登录走接口拿 Cookie 再灌进浏览器，不去登录页点按钮（登录后那条 302 会把 CDP 会话带跑）。
// 只支持装了 Edge 的 Windows：找不到浏览器时直接跳过并给出提示，不算失败。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3105';
const LOGIN = process.env.SMOKE_LOGIN ?? 'smokeadmin';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'smoke-admin-pass';
const DBG = Number(process.env.SMOKE_DEBUG_PORT ?? 9431);

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP 小客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.loaded = false;
    this.requests = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Network.requestWillBeSent') this.requests.push(msg.params.request.url);
      if (msg.method === 'Page.loadEventFired') this.loaded = true;
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('调试端口连不上')), { once: true });
    });
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 20000);
    });
  }

  /** 在页面里求值，返回按值序列化的结果（awaitPromise 让内部 await 生效）。 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** 导航并等 load 事件（最多 10 秒），比盲等固定时长稳。 */
  async goto(url) {
    this.loaded = false;
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 50 && !this.loaded; i += 1) await sleep(200);
    await sleep(300);
  }
}

async function pageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

/** 页面内构造 DataTransfer 灌给 file input —— input.files 是只读的，只能这么喂。 */
const pickFiles = (inputId, files) => `(async () => {
  const dt = new DataTransfer();
  ${files.map(([n, c, t]) => `dt.items.add(new File([${JSON.stringify(c)}], ${JSON.stringify(n)}, { type: ${JSON.stringify(t)} }));`).join('\n  ')}
  const inp = document.getElementById(${JSON.stringify(inputId)});
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  return true;
})()`;

// ---------------------------------------------------------------- 主体

async function main() {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  const cookies = login.headers.getSetCookie?.() ?? [];
  const raw = cookies.find((c) => c.includes('mp_session')) ?? cookies[0] ?? '';
  check('接口登录拿到会话 Cookie', login.status === 200 && raw.length > 0,
    `status=${login.status}`);
  if (!raw) throw new Error('登录失败，后面的页面断言没法跑（检查 SMOKE_LOGIN / SMOKE_PASSWORD）');
  const [cookieName, ...cookieRest] = raw.split(';')[0].split('=');

  const profile = path.join(process.env.TEMP ?? '.', `mp-upload-smoke-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });

  const proc = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DBG}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let cdp = null;
    for (let i = 0; i < 40 && !cdp; i += 1) {
      try {
        const list = await pageTargets(DBG);
        const page = list.find((t) => t.type === 'page');
        if (page) cdp = await Cdp.connect(page.webSocketDebuggerUrl);
      } catch { /* 浏览器还没起来 */ }
      if (!cdp) await sleep(500);
    }
    if (!cdp) throw new Error('Edge 调试端口起不来');

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: cookieName, value: cookieRest.join('='), url: BASE, path: '/', httpOnly: true,
    });

    await cdp.goto(`${BASE}/sites?tab=upload`);
    const boot = await cdp.eval(`(() => ({
      loggedIn: !document.getElementById('form').hidden,
      panel: !document.getElementById('panel-upload').hidden,
      adv: Boolean(document.getElementById('advBox')),
    }))()`);
    check('登录态带进了浏览器', boot.loggedIn === true, JSON.stringify(boot));
    check('投稿标签默认可见', boot.panel === true, JSON.stringify(boot));
    check('折叠区 #advBox 存在', boot.adv === true, JSON.stringify(boot));

    // --- 选 2 个文件
    await cdp.eval(pickFiles('fileInput', [
      ['index.html', '<html><body>a</body></html>', 'text/html'],
      ['style.css', 'body{}', 'text/css'],
    ]));
    const two = await cdp.eval(`(() => ({
      rows: document.querySelectorAll('#pickList .pickRow').length,
      rms: document.querySelectorAll('#pickList .pickRow .rm').length,
      mode: document.getElementById('modeTag').textContent,
      ready: document.getElementById('drop').classList.contains('ready'),
    }))()`);
    check('选 2 个文件 → 列表两行', two.rows === 2, JSON.stringify(two));
    check('每行都带移除按钮', two.rms === 2, JSON.stringify(two));
    check('两个文件判成多页模式', two.mode.includes('多页'), two.mode);
    check('选完之后拖放区进 ready 态', two.ready === true, JSON.stringify(two));

    // --- 移除一个
    await cdp.eval(`(async () => {
      document.querySelectorAll('#pickList .pickRow .rm')[0].click();
      await new Promise((r) => setTimeout(r, 120));
      return true;
    })()`);
    const one = await cdp.eval(`(() => ({
      rows: document.querySelectorAll('#pickList .pickRow').length,
      title: document.getElementById('dropTitle').textContent,
    }))()`);
    check('移除一个 → 列表剩一行', one.rows === 1, JSON.stringify(one));
    check('移除一个 → 标题同步', !one.title.includes('2 个文件'), one.title);

    // --- 移除最后一个 → 回空态
    await cdp.eval(`(async () => {
      document.querySelectorAll('#pickList .pickRow .rm')[0].click();
      await new Promise((r) => setTimeout(r, 120));
      return true;
    })()`);
    const none = await cdp.eval(`(() => ({
      rows: document.querySelectorAll('#pickList .pickRow').length,
      title: document.getElementById('dropTitle').textContent,
      listHidden: document.getElementById('pickList').hidden,
      ready: document.getElementById('drop').classList.contains('ready'),
      modeHidden: document.getElementById('modeTag').hidden,
    }))()`);
    check('移除最后一个 → 列表清空', none.rows === 0, JSON.stringify(none));
    check('移除最后一个 → 回空态文案', none.title.includes('把 HTML 文件'), none.title);
    check('移除最后一个 → 拖放区退出 ready', none.ready === false, JSON.stringify(none));
    check('移除最后一个 → 文件列表隐藏', none.listHidden === true, JSON.stringify(none));
    check('移除最后一个 → 模式徽章隐藏', none.modeHidden === true, JSON.stringify(none));

    // --- 单页；再加一个文件变多页；再移除又自动回单页
    await cdp.eval(pickFiles('fileInput', [
      ['solo.html', '<html><body>solo</body></html>', 'text/html'],
    ]));
    const single = await cdp.eval(`(() => ({
      mode: document.getElementById('modeTag').textContent,
      rows: document.querySelectorAll('#pickList .pickRow').length,
    }))()`);
    check('单个 html → 单页模式', single.mode.includes('单页'), JSON.stringify(single));
    check('单页模式下列表也留一行（能反悔）', single.rows === 1, JSON.stringify(single));

    await cdp.eval(pickFiles('fileInput', [
      ['solo.html', '<html><body>solo</body></html>', 'text/html'],
      ['extra.css', 'x{}', 'text/css'],
    ]));
    const mid = await cdp.eval(`(() => ({
      mode: document.getElementById('modeTag').textContent,
      rows: document.querySelectorAll('#pickList .pickRow').length,
    }))()`);
    check('再选两个文件 → 回到多页', mid.mode.includes('多页') && mid.rows === 2, JSON.stringify(mid));

    await cdp.eval(`(async () => {
      document.querySelectorAll('#pickList .pickRow')[1].querySelector('.rm').click();
      await new Promise((r) => setTimeout(r, 120));
      return true;
    })()`);
    const back = await cdp.eval(`(() => ({
      mode: document.getElementById('modeTag').textContent,
      title: document.getElementById('dropTitle').textContent,
    }))()`);
    check('去掉一个文件后自动回到单页模式', back.mode.includes('单页'), JSON.stringify(back));
    check('自动回单页后标题是剩下的文件名', back.title === 'solo.html', back.title);

    // --- 折叠区
    const adv = await cdp.eval(`(() => ({
      open: document.getElementById('advBox').open,
      tags: Array.from(document.getElementById('advTag').options).map((o) => o.value),
    }))()`);
    check('折叠区默认收起', adv.open === false, `open=${adv.open}`);
    check('标签下拉第一项是「未设置」（空值）', adv.tags[0] === '', JSON.stringify(adv.tags));
    check('标签下拉 9 项（未设置 + 8 个真实标签）', adv.tags.length === 9,
      `len=${adv.tags.length} ${JSON.stringify(adv.tags)}`);
    check('标签下拉里没有前端伪标签 hot', !adv.tags.includes('hot'), JSON.stringify(adv.tags));

    await cdp.eval(`(() => { document.querySelector('#advBox summary').click(); return true; })()`);
    check('点 summary 能展开', await cdp.eval(`document.getElementById('advBox').open`) === true);

    // --- 折叠区全空时发布：不该多发 meta / cover
    cdp.requests.length = 0;
    const emptyName = 'e2e-noadv-' + Math.floor(Math.random() * 1e5);
    await cdp.eval(`(async () => {
      document.getElementById('advBox').open = false;
      document.getElementById('name').value = ${JSON.stringify(emptyName)};
      document.getElementById('submit').click();
      await new Promise((r) => setTimeout(r, 2500));
      return true;
    })()`);
    const plainUrls = cdp.requests.filter((u) => u.includes('/api/'));
    check('折叠区全空时不发 meta 请求', !plainUrls.some((u) => u.includes('/meta')), plainUrls.join(' | '));
    check('折叠区全空时不发 cover 请求', !plainUrls.some((u) => u.includes('/cover')), plainUrls.join(' | '));
    check('折叠区全空时照常发布', plainUrls.some((u) => u.includes('/api/upload')), plainUrls.join(' | '));

    // --- 带设置发布：标题 / 简介 / 标签 / 封面
    // 上一步发布成功后页面把已选文件清空了，这里要重新选一个（否则会卡在「先选择要上传的内容」）
    const advName = 'e2e-adv-' + Math.floor(Math.random() * 1e5);
    const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await cdp.eval(pickFiles('fileInput', [
      ['index.html', '<html><body>e2e-adv</body></html>', 'text/html'],
    ]));
    cdp.requests.length = 0;

    // 先只选封面，确认预览和「清除」立刻出现（这是发布前的状态，发布后会被复位）
    await cdp.eval(`(async () => {
      document.getElementById('advBox').open = true;
      // 1×1 PNG：页面里 atob 解密成字节再包成 File，绕开 input.files 只读
      const bin = atob(${JSON.stringify(PNG_B64)});
      const arr = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const cdt = new DataTransfer();
      cdt.items.add(new File([arr], 'cover.png', { type: 'image/png' }));
      const ci = document.getElementById('advCoverFile');
      ci.files = cdt.files;
      ci.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      return true;
    })()`);
    const previewState = await cdp.eval(`(() => ({
      hidden: document.getElementById('advCoverPreview').hidden,
      hasSrc: Boolean(document.getElementById('advCoverPreview').getAttribute('src')),
      clearHidden: document.getElementById('advCoverClear').hidden,
    }))()`);
    check('选了封面立刻出预览和「清除」',
      previewState.hidden === false && previewState.hasSrc && previewState.clearHidden === false,
      JSON.stringify(previewState));

    // 再填文字项并发布
    await cdp.eval(`(async () => {
      document.getElementById('advTitle').value = 'E2E 标题';
      document.getElementById('advDesc').value = 'E2E 简介';
      document.getElementById('advTag').value = 'resume';
      document.getElementById('name').value = ${JSON.stringify(advName)};
      await new Promise((r) => setTimeout(r, 100));
      document.getElementById('submit').click();
      await new Promise((r) => setTimeout(r, 3000));
      return true;
    })()`);

    const advUrls = cdp.requests.filter((u) => u.includes('/api/'));
    check('带设置发布时补存了 meta', advUrls.some((u) => u.includes('/meta')), advUrls.join(' | '));
    check('带设置发布时补传了封面', advUrls.some((u) => u.includes('/cover')), advUrls.join(' | '));

    const after = await cdp.eval(`(() => ({
      advOpen: document.getElementById('advBox').open,
      title: document.getElementById('advTitle').value,
      tag: document.getElementById('advTag').value,
      result: document.getElementById('result').textContent,
      resultClass: document.getElementById('result').className,
    }))()`);
    check('发布成功后折叠区收起', after.advOpen === false, JSON.stringify(after));
    check('发布成功后折叠区复位', after.title === '' && after.tag === '', JSON.stringify(after));
    check('发布成功提示是绿的 ok', after.resultClass.includes(' ok'), after.resultClass);
    check('发布成功提示里没有「没存上」', !after.result.includes('没存上'), after.result.slice(0, 80));

    // --- 服务端真的存上了
    const detail = await fetch(`${BASE}/api/sites/${encodeURIComponent(LOGIN)}/${advName}`, {
      headers: { Cookie: raw.split(';')[0] },
    }).then((r) => r.json());
    check('（接口复核）标题已存', detail?.site?.title === 'E2E 标题', `title=${JSON.stringify(detail?.site?.title)}`);
    check('（接口复核）简介已存', detail?.site?.description === 'E2E 简介',
      `desc=${JSON.stringify(detail?.site?.description)}`);
    check('（接口复核）标签已存', detail?.site?.tag === 'resume', `tag=${JSON.stringify(detail?.site?.tag)}`);
    check('（接口复核）hasCover=true', detail?.site?.hasCover === true,
      `hasCover=${JSON.stringify(detail?.site?.hasCover)}`);

    // --- 封面预检：类型不对的文件必须在传整站之前就被拦下
    await cdp.eval(pickFiles('fileInput', [
      ['index.html', '<html><body>bad-cover</body></html>', 'text/html'],
    ]));
    const wrongType = await cdp.eval(pickFiles('advCoverFile', [['bad.txt', 'not an image', 'text/plain']])
      + `;(async () => {
        document.getElementById('advBox').open = true;
        document.getElementById('name').value = 'e2e-badcov-${Math.floor(Math.random() * 1e5)}';
        await new Promise((r) => setTimeout(r, 100));
        document.getElementById('submit').click();
        await new Promise((r) => setTimeout(r, 500));
        return { result: document.getElementById('result').textContent,
                 open: document.getElementById('advBox').open };
      })()`);
    check('封面类型不对 → 发布前拦下', wrongType.result.includes('png / jpg') || wrongType.result.includes('不支持'),
      wrongType.result.slice(0, 80));
    check('被拦下时自动展开折叠区', wrongType.open === true, `open=${wrongType.open}`);

    // --- 封面预检：超过 2MB 也一样，别等整站传完才在最后一步失败
    const bigCover = await cdp.eval(`(async () => {
      const big = new Uint8Array(2 * 1024 * 1024 + 10);
      const cdt = new DataTransfer();
      cdt.items.add(new File([big], 'big.png', { type: 'image/png' }));
      const ci = document.getElementById('advCoverFile');
      ci.files = cdt.files;
      ci.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('name').value = 'e2e-bigcov-${Math.floor(Math.random() * 1e5)}';
      await new Promise((r) => setTimeout(r, 100));
      document.getElementById('submit').click();
      await new Promise((r) => setTimeout(r, 500));
      return document.getElementById('result').textContent;
    })()`);
    check('封面超过 2MB → 发布前拦下', bigCover.includes('太大'), bigCover.slice(0, 80));

    console.log(`\n================ ${passed} 项通过 / ${failed} 项失败 ================`);
  } finally {
    try { proc.kill(); } catch { /* 已经退了 */ }
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 目录偶尔还占着 */ }
  }

  process.exitCode = failed === 0 ? 0 : 1;
}

if (!EDGE) {
  console.log('跳过：本机没找到 Microsoft Edge，投稿页浏览器冒烟测试只在 Windows + Edge 上跑。');
  process.exitCode = 0;
} else {
  main().catch((err) => {
    console.error('投稿页冒烟测试崩了：', err);
    process.exitCode = 1;
  });
}
