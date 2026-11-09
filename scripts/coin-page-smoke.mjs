// 投币交互的浏览器冒烟：观看页投币弹层、账号页硬币面板。
//
// 接口层断言在 api-smoke.mjs 里；这里专门盯 DOM 行为，因为弹层选项、按钮禁用、
// 余额刷新全是前端事件，接口测不到。
//
// 先起一个冒烟服务（自己不拉服务），再：
//   BASE_URL=http://127.0.0.1:3211 SMOKE_LOGIN=uitester SMOKE_PASSWORD=pw123456 \
//     node scripts/coin-page-smoke.mjs
// 只支持装了 Edge 的 Windows：找不到浏览器直接跳过并提示。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3211';
const LOGIN = process.env.SMOKE_LOGIN ?? 'uitester';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'pw123456';
const VIEW_PATH = process.env.SMOKE_VIEW ?? '/view/uitester/ui-site';
const DBG = Number(process.env.SMOKE_DEBUG_PORT ?? 9432);

// 观看页地址 /view/<用户名>/<站名> → 接口地址 /api/sites/<用户名>/<站名>/stats
const STATS_URL = (() => {
  const parts = VIEW_PATH.replace(/\/$/, '').split('/').filter(Boolean);
  return `/api/sites/${parts[1]}/${parts[2]}/stats`;
})();

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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.loaded = false;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
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

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async goto(url) {
    this.loaded = false;
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 50 && !this.loaded; i += 1) await sleep(200);
    await sleep(400);
  }
}

async function main() {
  if (!EDGE) {
    console.log('  跳过：没找到 Edge，浏览器探针不跑');
    return;
  }

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  const cookies = login.headers.getSetCookie?.() ?? [];
  const raw = cookies.find((c) => c.includes('mp_session')) ?? cookies[0] ?? '';
  check('接口登录拿到会话 Cookie', login.status === 200 && raw.length > 0, `status=${login.status}`);
  if (!raw) return;

  const me = await (await fetch(BASE + '/api/me', { headers: { cookie: raw } })).json();
  check('测试账号有硬币可用', (me?.user?.coins ?? 0) > 0, JSON.stringify(me?.user?.coins));

  // 临时 profile 放系统临时目录，别在仓库根目录留垃圾
  const workshop = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-coin-'));
  const proc = spawnDetached(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DBG}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--user-data-dir=${path.resolve(workshop)}`,
    'about:blank',
  ]);

  let cdp = null;
  try {
    for (let i = 0; i < 40; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) { cdp = await Cdp.connect(page.webSocketDebuggerUrl); break; }
      } catch { /* 端口还没起来 */ }
      await sleep(250);
    }
    if (!cdp) throw new Error('连不上 Edge 调试端口');

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: 'mp_session', value: raw.split('=')[1].split(';')[0],
      domain: '127.0.0.1', path: '/',
    });

    // ---------------------------------------------------------- 观看页投币
    console.log('\n观看页投币');
    await cdp.goto(BASE + VIEW_PATH);

    const coinBtnText = await cdp.eval(`(async () => {
      const me = await MP.me();
      return me ? me.coins : -1;
    })()`);
    check('页面拿到当前用户余额', typeof coinBtnText === 'number' && coinBtnText >= 0, String(coinBtnText));

    // 操作栏应该有投币按钮，且不再是「未开放」虚线态
    const hasPending = await cdp.eval(`document.querySelectorAll('.wbtn.pending').length`);
    check('不再有「未开放」态按钮', hasPending === 0, `pending=${hasPending}`);

    const coinLabel = await cdp.eval(`(async () => {
      const btns = [...document.querySelectorAll('.wbtn')];
      const b = btns.find((x) => x.textContent.includes('投币'));
      return b ? b.textContent.trim() : null;
    })()`);
    check('操作栏有投币按钮且带枚数', coinLabel !== null && /投币/.test(coinLabel), String(coinLabel));

    // 点开弹层
    await cdp.eval(`(async () => {
      const btns = [...document.querySelectorAll('.wbtn')];
      const b = btns.find((x) => x.textContent.includes('投币'));
      if (b) b.click();
      await new Promise((r) => setTimeout(r, 250));
      return true;
    })()`);
    const modalOpen = await cdp.eval(`Boolean(document.querySelector('.modal-mask'))`);
    check('点投币弹出弹层', modalOpen === true, `open=${modalOpen}`);

    const pickCount = await cdp.eval(`document.querySelectorAll('.coinPick .mbtn').length`);
    check('弹层给出 1 枚 / 2 枚两个选项', pickCount === 2, `count=${pickCount}`);

    const infoText = await cdp.eval(`(document.querySelector('.coinInfo') || {}).textContent || ''`);
    check('弹层显示余额', /硬币/.test(infoText), infoText.slice(0, 60));

    // 点「投 1 枚」，等响应回填
    const before = await cdp.eval(`(async () => (await MP.me()).coins)()`);
    await cdp.eval(`(async () => {
      const b = document.querySelector('.coinPick .mbtn');
      if (b) b.click();
      await new Promise((r) => setTimeout(r, 900));
      return true;
    })()`);
    const closed = await cdp.eval(`!document.querySelector('.modal-mask')`);
    check('投币成功后弹层关闭', closed === true);

    const after = await cdp.eval(`(async () => (await MP.me()).coins)()`);
    check('余额扣了 1 枚', after === before - 1, `${before} → ${after}`);

    const coinStat = await cdp.eval(`(async () => {
      const r = await fetch(${JSON.stringify(BASE + STATS_URL)});
      const d = await r.json();
      return d.stats;
    })()`);
    check('站点投币数 +1', (coinStat?.coins ?? 0) >= 1, JSON.stringify(coinStat));

    const aboutNums = await cdp.eval(`[...document.querySelectorAll('.wanums span')].map((s) => s.textContent)`);
    check('关于栏出现「投币」数字', (aboutNums ?? []).includes('投币'), JSON.stringify(aboutNums));

    // ---------------------------------------------------------- 账号页硬币面板
    console.log('\n账号页硬币面板');
    await cdp.goto(BASE + '/account');
    await sleep(600);

    const balance = await cdp.eval(`document.getElementById('coinBalance').textContent`);
    check('账号页显示余额', /^\d/.test(String(balance)), String(balance));

    const quota = await cdp.eval(`document.getElementById('coinQuota').textContent`);
    check('账号页显示配额', /^\d/.test(String(quota)), String(quota));

    const ledgerRows = await cdp.eval(`document.querySelectorAll('.coinLedger li').length`);
    check('账号页有流水列表', ledgerRows >= 1, `rows=${ledgerRows}`);

    const ledgerText = await cdp.eval(`document.querySelector('.coinLedger').textContent`);
    check('流水里能看到签到/赠币', /签到|赠送|投币/.test(ledgerText), ledgerText.slice(0, 80));

    const redeemState = await cdp.eval(`document.getElementById('redeemQuota').disabled`);
    check('余额不足 5 枚时兑换按钮禁用', redeemState === true, `disabled=${redeemState}`);
  } finally {
    try { cdp?.ws?.close(); } catch { /* 忽略 */ }
    try { proc?.kill(); } catch { /* 忽略 */ }
    try { fs.rmSync(workshop, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

function spawnDetached(bin, args) {
  // Edge 是 GUI 进程：起一个独立进程，测完 kill
  return spawn(bin, args, { stdio: 'ignore', detached: false });
}

try {
  await main();
} catch (err) {
  failed += 1;
  console.log(`\n执行中断：${err?.stack ?? err}`);
}

console.log(`\n================ ${passed} 项通过 / ${failed} 项失败 ================`);
process.exit(failed === 0 ? 0 : 1);
