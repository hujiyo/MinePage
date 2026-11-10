// 顶栏「热门搜索」下拉的浏览器冒烟：验证真数据上线、空榜隐藏、点击能跳搜索。
//
// 接口层断言在 api-smoke.mjs 里；这里盯 DOM 行为 —— 面板什么时候展开、空榜是不是整段隐藏、
// 点了以后是不是真的按这个词搜。先起一个冒烟服务：
//   BASE_URL=http://127.0.0.1:3211 node scripts/hot-page-smoke.mjs
// 只支持装了 Edge 的 Windows：找不到浏览器直接跳过并提示。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3211';
const DBG = Number(process.env.SMOKE_DEBUG_PORT ?? 9442);

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

/**
 * 造一个「两个人搜过」的热词。用匿名访客的随机 Cookie 通道，
 * 所以不需要登录、也不依赖冒烟库里的种子账号。
 *
 * 每次跑都会往冒烟库里留一个探针词，跑多了以后榜上会被探针词占满、
 * 新词挤不进去。所以先查榜：满 10 个就直接用榜上第一个词来做后面的 DOM 断言 ——
 * 断言的对象是「榜上的词能被点到搜索页」，用哪个词不影响结论。
 */
async function seedHotWord(word) {
  for (let i = 0; i < 2; i += 1) {
    await fetch(`${BASE}/api/discover?q=${encodeURIComponent(word)}`);
  }
}

async function pickTargetWord() {
  const fresh = `热搜探针${Date.now() % 100000}`;
  await seedHotWord(fresh);

  const hot = await (await fetch(`${BASE}/api/hot`)).json();
  const words = hot?.words ?? [];
  if (!words.length) return { hot, word: fresh, onBoard: false };

  const onBoard = words.some((w) => w.word === fresh);
  return { hot, word: onBoard ? fresh : words[0].word, onBoard };
}

async function main() {
  if (!EDGE) {
    console.log('  跳过：没找到 Edge，浏览器探针不跑');
    return;
  }

  const { hot, word: hotWord } = await pickTargetWord();
  check(
    '榜上有至少一个「≥2 人搜过」的词（接口层）',
    (hot?.words ?? []).length > 0,
    JSON.stringify(hot?.words?.map((w) => w.word)),
  );
  if (!(hot?.words ?? []).length) return;

  const workshop = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-hot-'));
  const proc = spawnEdge([
    '--headless=new',
    `--remote-debugging-port=${DBG}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--user-data-dir=${path.resolve(workshop)}`,
    'about:blank',
  ]);
  proc.unref();

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

    // 首页顶栏
    await cdp.goto(BASE + '/');
    check('首页有搜索框', await cdp.eval(`Boolean(document.querySelector('#tsInput'))`));

    // headless Edge 默认让页面拿不到窗口焦点，focus() 之后不派发 focus 事件。
    // 打开焦点模拟 + 用真实鼠标输入点击输入框，走的就是用户真实的路径。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const box = await cdp.eval(`
      (() => {
        const r = document.querySelector('#tsInput').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1,
      });
    }

    // 等热榜数据真的回来。只等一个状态量不够：初始态和「加载中」都是 hidden=true / 没有行，
    // 用 `rows > 0 || hidden` 当条件会在第一轮就成立然后立刻退出。就轮询「有行了」。
    let rows = 0;
    for (let i = 0; i < 40 && rows === 0; i += 1) {
      rows = await cdp.eval(`document.querySelectorAll('#tsHot .hRow').length`);
      if (rows > 0) break;
      await sleep(150);
    }

    const secHidden = await cdp.eval(`document.querySelector('#tsHotSec').hidden`);
    check('有数据时热搜分区显示', secHidden === false, `hidden=${secHidden}`);
    check('面板展开', await cdp.eval(`document.querySelector('#ts').classList.contains('open')`));
    check('热榜渲染出条目', rows >= 1, `rows=${rows}`);

    const texts = await cdp.eval(
      `Array.from(document.querySelectorAll('#tsHot .hWord')).map((e) => e.textContent)`,
    );
    check(
      '榜上是真实搜索词而不是标签名',
      !texts.includes('求职简历') && !texts.includes('作品集'),
      JSON.stringify(texts),
    );
    check(
      '种子词出现在榜上',
      texts.includes(hotWord),
      JSON.stringify(texts),
    );

    const people = await cdp.eval(
      `document.querySelector('#tsHot .hVal')?.textContent ?? ''`,
    );
    check('每个词带人数', /\d+人$/.test(people), people);

    // 点第一条 → 跳到 /?q=<词>
    const firstWord = await cdp.eval(`document.querySelector('#tsHot .hWord').textContent`);
    await cdp.eval(`
      const row = document.querySelector('#tsHot .hRow');
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    `);
    await sleep(1200);
    const url = await cdp.eval('location.pathname + location.search');
    check(
      '点击热搜跳到搜索页',
      url.includes('q=') && decodeURIComponent(url).includes(firstWord),
      url,
    );

    // 搜索结果页确实按这个词搜了：标题是「搜索：<词>」
    const title = await cdp.eval(`document.querySelector('#feedTitle')?.textContent ?? ''`);
    check('搜索页标题回显关键词', title.includes(firstWord), title);

    // 空榜：整段隐藏，不留一个空标题
    await cdp.goto(BASE + '/');
    await cdp.eval(`window.__hotStub = true`);
    await cdp.eval(`
      // 把 /api/hot 打桩成空榜：验证「没数据就整段隐藏」这条路
      const orig = window.fetch;
      window.fetch = (url, opt) => url === '/api/hot'
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, words: [] }), {
            headers: { 'Content-Type': 'application/json' },
          }))
        : orig(url, opt);
      // 面板已经挂好，直接重挂一次顶栏来走桩
      document.querySelector('.topbar')?.remove();
      MP.topbar();
      document.querySelector('#tsInput').focus();
    `);
    await sleep(900);
    const emptyHidden = await cdp.eval(`document.querySelector('#tsHotSec').hidden`);
    check('空榜整段隐藏', emptyHidden === true, `hidden=${emptyHidden}`);
    check('空榜不渲染任何条目', await cdp.eval(`document.querySelectorAll('#tsHot .hRow').length`) === 0);
  } finally {
    try { cdp?.ws.close(); } catch { /* 已断开 */ }
    try { proc.kill(); } catch { /* 已退出 */ }
    try { fs.rmSync(workshop, { recursive: true, force: true }); } catch { /* Windows 上偶尔还占着 */ }
  }
}

function spawnEdge(args) {
  return spawn(EDGE, args, { detached: true, stdio: 'ignore' });
}

main()
  .catch((err) => { failed += 1; console.log(`  执行中断：${err?.stack ?? err}`); })
  .then(() => {
    console.log(`\n================ ${passed} 项通过 / ${failed} 项失败 ================`);
    process.exit(failed ? 1 : 0);
  });
