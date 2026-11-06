/* ============================================================
   MinePage 前端公共脚本（app.js）
   职责：图标库 / 统一顶栏 / 搜索下拉 / 卡片渲染 / 演示数据
   ------------------------------------------------------------
   当前为「纯前端阶段」：所有用户态与列表数据均为本地演示数据，
   每处需要后端的地方都留了 TODO，后续接 /api/* 时逐个替换即可。
   ============================================================ */

(function () {
  'use strict';

  const MP = {};
  window.MP = MP;

  /* ----------------------------------------------------------
     1. 图标库（内联 SVG，跟随 currentColor）
     ---------------------------------------------------------- */

  const ICONS = {
    logo: '<rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor" stroke="none"/><path d="M10 8.2l6 3.8-6 3.8z" fill="#fff" stroke="none"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
    play: '<path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none"/>',
    view: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
    like: '<path d="M7 21V10l4.2-7.2c1.4.2 2 1.2 2 2.6V10h4.6a2 2 0 0 1 1.96 2.4l-1.15 6.2A2 2 0 0 1 16.65 21z"/><path d="M7 10H3.6v11H7"/>',
    fav: '<path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9 6.8 19.65l1-5.8-4.2-4.1 5.8-.85z"/>',
    comment: '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9.5L5 20v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
    bell: '<path d="M18 16.5v-5.5a6 6 0 1 0-12 0v5.5L4 18.5h16z"/><path d="M10 21h4"/>',
    message: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7.5l8.5 5.6 8.5-5.6"/>',
    folder: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
    upload: '<path d="M12 4.5v11"/><path d="M7.5 9L12 4.5 16.5 9"/><path d="M4.5 19.5h15"/>',
    user: '<circle cx="12" cy="8.2" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z"/>',
    logout: '<path d="M15 12H4.5"/><path d="M9 7.5L4.5 12 9 16.5"/><path d="M13.5 4h4.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-4.5"/>',
    home: '<path d="M4 11l8-6.8 8 6.8"/><path d="M6.2 10v10h11.6V10"/>',
    shield: '<path d="M12 3l7 2.6v5.6c0 4.3-2.9 8-7 9.8-4.1-1.8-7-5.5-7-9.8V5.6z"/>',
    fire: '<path d="M12 2.5s5 4.2 5 9a5 5 0 0 1-10 0c0-1.8.9-3 1.6-3.6.2 1.2.9 1.9 1.6 1.9 1.2 0 1.8-2.3 1.8-7.3z"/>',
    coin: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9"/><path d="M9.2 12h5.6"/>',
    share: '<circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.1 10.9l7.8-3.7M8.1 13.1l7.8 3.7"/>',
    left: '<path d="M15 5.5L8.5 12 15 18.5"/>',
    right: '<path d="M9 5.5L15.5 12 9 18.5"/>',
    up: '<path d="M12 19V6"/><path d="M7 11l5-5 5 5"/>',
    down: '<path d="M12 5v13"/><path d="M7 13l5 5 5-5"/>',
    triUp: '<path d="M12 6.5l7.5 11h-15z" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6.5h12"/><path d="M8 12h12"/><path d="M8 17.5h12"/><path d="M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5h5v2"/><path d="M6.5 7l1 13h9l1-13"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    star: '<path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9 6.8 19.65l1-5.8-4.2-4.1 5.8-.85z"/>',
  };

  /**
   * 生成图标 SVG 字符串。
   * @param {string} name 图标名
   * @param {string} [cls] 附加 class
   * @param {number} [size] 同时写入 width/height 属性（不依赖外部 CSS 也能有尺寸）
   */
  function icon(name, cls, size) {
    const inner = ICONS[name] || '';
    return '<svg viewBox="0 0 24 24"'
      + (size ? ' width="' + size + '" height="' + size + '"' : '')
      + ' fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
      + (cls ? ' class="' + cls + '"' : '') + '>' + inner + '</svg>';
  }
  MP.icon = icon;

  /* ----------------------------------------------------------
     2. 工具函数
     ---------------------------------------------------------- */

  /** HTML 转义，所有来自数据源的文本都要过这一层。 */
  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
  MP.esc = esc;

  /** 数字友好显示：12345 → 1.2万 */
  function fmtNum(n) {
    const v = Number(n) || 0;
    if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(v);
  }
  MP.fmtNum = fmtNum;

  /** 取站点名首字，用于封面占位。 */
  function initial(site) {
    const t = String(site.title || site.name || '?').trim();
    return t ? t[0] : '?';
  }
  MP.initial = initial;

  /** 封面渐变：按站点名散列到固定色板，保证每次刷新颜色一致。 */
  const GRADS = [
    'linear-gradient(135deg,#fb7299,#ffb3c8)',
    'linear-gradient(135deg,#23ade5,#7fd6f5)',
    'linear-gradient(135deg,#7c5cff,#b7a6ff)',
    'linear-gradient(135deg,#ff8f3c,#ffc78a)',
    'linear-gradient(135deg,#2ac864,#8ce4ae)',
    'linear-gradient(135deg,#f0656f,#ffb0b0)',
    'linear-gradient(135deg,#00b7c3,#7fe3e9)',
    'linear-gradient(135deg,#8a6d3b,#d8c39a)',
  ];
  function grad(site) {
    const key = String(site.name || site.title || '');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return GRADS[h % GRADS.length];
  }
  MP.grad = grad;

  /**
   * 观看包装页地址：/view/<用户名>/<站名>。
   * 站名只在作者名下唯一，指向观看页的链接必须带用户名。
   */
  function viewUrl(site) {
    return '/view/' + encodeURIComponent((site.author && site.author.username) || '')
      + '/' + encodeURIComponent(site.name);
  }
  MP.viewUrl = viewUrl;

  /** 站点访问地址：/qwq/<用户名>/<站名>。 */
  function siteUrl(site) {
    return '/qwq/' + encodeURIComponent((site.author && site.author.username) || '')
      + '/' + encodeURIComponent(site.name);
  }
  MP.siteUrl = siteUrl;

  /* ----------------------------------------------------------
     2.1 接口与时间
     ---------------------------------------------------------- */

  /**
   * 调 JSON 接口：非 2xx 或 ok:false 一律抛错（message 用服务端文案）。
   * err.status 保留状态码，401 时调用方可以引导去登录。
   *
   * POST / PUT 即使没有参数也补一个 {}：服务端的 readBody 要解析 JSON，
   * 空请求体会被当成格式错误回 400。
   * @param {string} path
   * @param {{method?:string, body?:any}} [opt]
   */
  MP.api = async function (path, opt) {
    const o = opt || {};
    const method = o.method || 'GET';
    const hasBody = o.body !== undefined || method === 'POST' || method === 'PUT';
    const body = hasBody ? (o.body === undefined ? {} : o.body) : undefined;

    const res = await fetch(path, {
      method,
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try { data = await res.json(); } catch { /* 204 或空响应 */ }

    if (!res.ok || (data && data.ok === false)) {
      const err = new Error((data && data.message) || '请求失败（' + res.status + '）');
      err.status = res.status;
      throw err;
    }
    return data || {};
  };

  /** 站点接口地址：/api/sites/<用户名>/<站名><tail>。站名只在作者名下唯一。 */
  function siteApi(site, tail) {
    return '/api/sites/' + encodeURIComponent((site.author && site.author.username) || '')
      + '/' + encodeURIComponent(site.name) + (tail || '');
  }
  MP.siteApi = siteApi;

  const pad2 = (n) => String(n).padStart(2, '0');

  /** 时间戳 / ISO 字符串 → Date；无效值返回 null。 */
  function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  MP.toDate = toDate;

  /** 相对时间：刚刚 / n 分钟前 / n 小时前 / n 天前 / 2026-10-06。 */
  MP.timeAgo = function (value) {
    const d = toDate(value);
    if (!d) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };

  /** 绝对时间：10-06 20:31。 */
  MP.fmtTime = function (value) {
    const d = toDate(value);
    if (!d) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  /* ----------------------------------------------------------
     3. 当前登录用户
     ---------------------------------------------------------- */

  // 已拿到手的当前用户（未登录或还没拉到时为 null）；页面里请用 await MP.me()。
  let ME = null;
  let mePromise = null;

  /** 服务端 user 对象 → 前端通用形状（name 用用户名，没有显示名这个概念）。 */
  function normalizeMe(user, extra) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.username || user.email,
      username: user.username,
      email: user.email,
      isAdmin: Boolean(user.isAdmin),
      bio: user.bio || '',
      createdAt: user.createdAt,
      unread: extra?.unread ?? 0,
      unreadMessages: extra?.unreadMessages ?? 0,
    };
  }

  /**
   * 当前登录用户（带 1 次缓存）。未登录返回 null。
   * opt.refresh=true 强制重新拉取（改名、封禁后需要）。
   */
  MP.me = async function (opt) {
    if (mePromise && !(opt && opt.refresh)) return mePromise;

    mePromise = fetch('/api/me')
      .then((res) => res.json())
      .then((data) => {
        ME = normalizeMe(data.user, data);
        return ME;
      })
      .catch(() => {
        ME = null;
        return null;
      });
    return mePromise;
  };

  /** 同步取缓存里的当前用户（只在 MP.me() 已完成后有意义）。 */
  MP.currentUser = function () {
    return ME;
  };

  /** 登录态失效时统一回登录页，并把原地址带回来。 */
  MP.requireLogin = async function () {
    const me = await MP.me();
    if (!me) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return null;
    }
    return me;
  };

  /* ----------------------------------------------------------
     3.1 标签
     ---------------------------------------------------------- */

  // 与后端 lib/sites.js 的 SITE_TAGS 保持一致（key 存库，label 给人看）
  const TAGS = [
    { key: '', label: '全部' },
    { key: 'resume', label: '求职简历' },
    { key: 'portfolio', label: '作品集' },
    { key: 'social', label: '社交聚合页' },
    { key: 'blog', label: '技术博客' },
    { key: 'event', label: '活动落地页' },
    { key: 'opensource', label: '开源项目' },
    { key: 'docs', label: '学习笔记' },
    { key: 'other', label: '其他' },
  ];
  MP.TAGS = TAGS;

  function tagLabel(key) {
    const t = TAGS.find((x) => x.key === key);
    return t ? t.label : '';
  }
  MP.tagLabel = tagLabel;

  /* ----------------------------------------------------------
     4. 搜索历史（localStorage）
     ---------------------------------------------------------- */

  const HIST_KEY = 'mp_search_hist';
  const HIST_MAX = 8;

  MP.searchHist = function () {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, HIST_MAX) : [];
    } catch { return []; }
  };

  MP.pushSearchHist = function (word) {
    const w = String(word || '').trim();
    if (!w) return;
    const list = MP.searchHist().filter((x) => x !== w);
    list.unshift(w);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch { /* 忽略隐私模式报错 */ }
  };

  MP.clearSearchHist = function () {
    try { localStorage.removeItem(HIST_KEY); } catch { /* 同上 */ }
  };

  /** 统一搜索跳转：首页以 ?q= 呈现结果（不改 server 路由）。 */
  MP.goSearch = function (word) {
    const w = String(word || '').trim();
    if (!w) return;
    MP.pushSearchHist(w);
    location.href = '/?q=' + encodeURIComponent(w);
  };

  /* ----------------------------------------------------------
     5. 顶栏
     ---------------------------------------------------------- */

  /** 根据当前路径推断高亮的导航项。 */
  function currentNav() {
    const p = location.pathname;
    const q = new URLSearchParams(location.search).get('q');
    if (p === '/' || p === '/index.html') {
      if (q) return 'search';
      if (new URLSearchParams(location.search).get('sort') === 'rank') return 'rank';
      return 'home';
    }
    if (p.startsWith('/notifications')) return 'dynamic';
    if (p.startsWith('/messages')) return 'messages';
    return '';
  }

  // 左侧导航只保留两个入口：收藏 / 历史已在右侧图标组里，不再重复
  const NAVS = [
    { key: 'home', label: '首页', href: '/' },
    { key: 'rank', label: '排行榜', href: '/?sort=rank' },
  ];

  // 顶栏「热门搜索」：后端没有热搜接口，先用内容标签的词，点了就是按词搜索。
  // 有接口以后换成 GET /api/hot 的返回即可。
  const HOT_WORDS = TAGS.filter((t) => t.key).map((t) => t.label);

  /** 顶栏用户区。me 为 null 时显示「未登录」入口。 */
  function tuserHtml(me) {
    if (!me) {
      return '<a class="tlogin" href="/login">登录 / 注册</a>';
    }
    const initial = esc((me.name || '?').charAt(0));
    const dot = (n) => (n ? '<i class="dot">' + n + '</i>' : '');
    return ''
      + '<div class="tacts">' + [
        { key: 'messages', href: '/messages', ic: 'message', label: '消息', dot: me.unreadMessages },
        { key: 'dynamic', href: '/notifications', ic: 'bell', label: '动态', dot: me.unread },
        { key: 'favorites', href: '/favorites', ic: 'folder', label: '收藏' },
        { key: 'history', href: '/history', ic: 'history', label: '历史' },
        { key: 'create', href: '/sites', ic: 'grid', label: '创作' },
      ].map((a) => '<a class="tact" href="' + a.href + '" title="' + a.label + '">'
        + icon(a.ic) + '<span>' + a.label + '</span>' + dot(a.dot) + '</a>').join('')
      + '</div>'
      + '<div class="tuser" id="tuser">'
      +   '<div class="avatar sm" title="' + esc(me.name) + '">' + initial + '</div>'
      +   '<div class="tmenu">'
      +     '<div class="who">' + esc(me.name) + '<small>' + esc(me.email) + '</small></div>'
      +     '<hr>'
      +     '<a href="/qwq/' + encodeURIComponent(me.username) + '">' + icon('user') + '我的主页</a>'
      +     '<a href="/account">' + icon('settings') + '账号设置</a>'
      +     '<a href="/sites">' + icon('grid') + '创作</a>'
      +     (me.isAdmin ? '<a href="/admin">' + icon('shield') + '管理后台</a>' : '')
      +     '<hr>'
      +     '<a href="/login" id="tLogout">' + icon('logout') + '退出登录</a>'
      +   '</div>'
      + '</div>';
  }

  function topbarHtml(active, me) {
    const nav = NAVS.map((n) => '<a href="' + n.href + '"'
      + (active === n.key ? ' class="on"' : '') + '>' + n.label + '</a>').join('');

    return ''
      + '<div class="tinner">'
      +   '<a class="tlogo" href="/">' + icon('logo') + '<span class="tname">MinePage</span></a>'
      +   '<nav class="tnav">' + nav + '</nav>'
      +   '<div class="tsearch" id="ts">'
      +     '<form class="tsForm" id="tsForm" autocomplete="off">'
      +       '<input id="tsInput" type="search" placeholder="搜索感兴趣的页面…" maxlength="50">'
      +       '<button type="submit" title="搜索">' + icon('search') + '</button>'
      +     '</form>'
      +     '<div class="tsPanel">'
      +       '<div class="tsSec"><span>搜索历史</span><span class="clr" id="tsClear">清空</span></div>'
      +       '<div class="tsHist" id="tsHist"></div>'
      +       '<div id="tsUsers" hidden></div>'
      +       '<div class="tsSec" style="margin-top:6px">' + icon('fire') + '<span style="flex:1">热门搜索</span></div>'
      +       '<div class="tsHot" id="tsHot"></div>'
      +     '</div>'
      +   '</div>'
      +   '<div id="tuserSlot">' + tuserHtml(me) + '</div>'
      + '</div>';
  }

  /**
   * 挂载顶栏：注入到 body 最前。用户区先按缓存渲染（未登录态），
   * /api/me 回来后原地替换，不阻塞页面其余部分的渲染。
   * @param {{active?:string, collapse?:boolean}} [opt]
   *   collapse=true 时在顶栏左下角加「收起/展开」箭头，并在收起后于屏幕顶部留一条触发带
   */
  MP.topbar = function (opt) {
    const o = opt || {};
    const active = o.active || currentNav();
    const header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML = topbarHtml(active, ME);
    document.body.insertBefore(header, document.body.firstChild);
    if (o.collapse) mountCollapse();

    // 搜索下拉：聚焦展开、失焦收起、历史回填
    const ts = header.querySelector('#ts');
    const input = header.querySelector('#tsInput');
    const histBox = header.querySelector('#tsHist');
    const hotBox = header.querySelector('#tsHot');

    const params = new URLSearchParams(location.search);
    if (params.get('q')) input.value = params.get('q');

    function renderHist() {
      const list = MP.searchHist();
      if (!list.length) { histBox.innerHTML = '<span class="none">还没有搜索记录</span>'; return; }
      histBox.textContent = '';
      list.forEach((w) => {
        const el = document.createElement('span');
        el.className = 'chip';
        el.textContent = w;
        el.addEventListener('mousedown', (e) => { e.preventDefault(); MP.goSearch(w); });
        histBox.appendChild(el);
      });
    }

    hotBox.textContent = '';
    HOT_WORDS.forEach((word, i) => {
      const row = document.createElement('div');
      row.className = 'hRow';
      row.innerHTML = '<span class="hNo' + (i < 3 ? ' top' + (i + 1) : '') + '">' + (i + 1) + '</span>'
        + '<span class="hWord">' + esc(word) + '</span>';
      row.addEventListener('mousedown', (e) => { e.preventDefault(); MP.goSearch(word); });
      hotBox.appendChild(row);
    });

    // 边打边搜用户：输入非空时把「用户」分区插在历史下面，回车仍然按页面搜索
    const usersBox = header.querySelector('#tsUsers');
    let searchTimer = null;
    let searchSeq = 0;

    function renderUsers(list) {
      if (!list.length) { usersBox.hidden = true; usersBox.textContent = ''; return; }
      usersBox.hidden = false;
      usersBox.innerHTML = '<div class="tsSec"><span>用户</span></div>';
      const wrap = document.createElement('div');
      wrap.className = 'tsHist';
      list.forEach((u) => {
        const a = document.createElement('a');
        a.className = 'chip';
        a.href = '/qwq/' + encodeURIComponent(u.username);
        a.textContent = u.username;
        a.title = u.bio || u.username;
        wrap.appendChild(a);
      });
      usersBox.appendChild(wrap);
    }

    input.addEventListener('input', () => {
      const kw = input.value.trim();
      clearTimeout(searchTimer);
      if (!kw) { renderUsers([]); return; }

      searchTimer = setTimeout(async () => {
        const seq = ++searchSeq;
        try {
          const data = await MP.api('/api/users/search?q=' + encodeURIComponent(kw));
          if (seq === searchSeq) renderUsers(data.users);
        } catch {
          if (seq === searchSeq) renderUsers([]);
        }
      }, 220);
    });

    renderHist();
    header.querySelector('#tsClear').addEventListener('mousedown', (e) => {
      e.preventDefault();
      MP.clearSearchHist();
      renderHist();
    });

    input.addEventListener('focus', () => { renderHist(); ts.classList.add('open'); });
    input.addEventListener('blur', () => setTimeout(() => ts.classList.remove('open'), 120));
    // 点击搜索区域任意空白处也能展开面板
    ts.addEventListener('click', (e) => {
      if (e.target.closest('.tsPanel')) return;
      input.focus();
      ts.classList.add('open');
    });

    header.querySelector('#tsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      MP.goSearch(input.value);
    });

    document.addEventListener('click', (e) => {
      if (!ts.contains(e.target)) ts.classList.remove('open');
    });

    // 用户区：头像下拉、退出登录。用户区会随 /api/me 重绘，所以事件挂在 header 上做委托。
    header.addEventListener('click', (e) => {
      const tu = e.target.closest('#tuser');
      if (!tu) return;
      if (e.target.closest('#tLogout')) return;
      tu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      const tu = header.querySelector('#tuser');
      if (tu && !tu.contains(e.target)) tu.classList.remove('open');
    });
    header.addEventListener('click', (e) => {
      if (!e.target.closest('#tLogout')) return;
      e.preventDefault();
      // 有真实会话时先清掉，再回登录页；无会话时该请求只是空操作
      fetch('/api/auth/logout', { method: 'POST' })
        .catch(() => { /* 忽略网络异常，直接跳转 */ })
        .finally(() => { location.href = '/login'; });
    });

    // 拉到真实登录态后替换用户区
    MP.me().then((me) => {
      const slot = header.querySelector('#tuserSlot');
      if (!slot) return;
      slot.innerHTML = tuserHtml(me);
    });

    return header;
  };

  /* ----------------------------------------------------------
     5.1 顶栏收起 / 展开（观看他人网页时减少干扰）
     ---------------------------------------------------------- */

  const NAV_KEY = 'mp_nav_collapsed';

  /** 读取本地布尔开关（隐私模式下静默降级）。 */
  function readFlag(key) {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  }

  /** 写入本地布尔开关。 */
  function writeFlag(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* 忽略 */ }
  }

  MP.readFlag = readFlag;
  MP.writeFlag = writeFlag;

  /**
   * 给顶栏装上收起小三角形：收起后顶栏上滑隐藏，只在屏幕左上角留一个小三角形。
   * 该三角形是固定定位，不受顶栏位移影响，收起状态下依然可点。
   */
  function mountCollapse() {
    let collapsed = readFlag(NAV_KEY);

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'navHandle';
    handle.innerHTML = icon('triUp', null, 14);
    document.body.appendChild(handle);

    function sync() {
      document.body.classList.toggle('nav-collapsed', collapsed);
      handle.title = collapsed ? '展开导航栏' : '收起导航栏';
    }

    handle.addEventListener('click', () => {
      collapsed = !collapsed;
      writeFlag(NAV_KEY, collapsed);
      sync();
    });

    sync();
  }

  /* ----------------------------------------------------------
     6. 站点卡片（首页 / 搜索结果 / 创作者主页共用）
     ---------------------------------------------------------- */

  /**
   * 生成一张站点卡片。
   * @param {object} site 站点数据（发现流 / 创作者主页 / 收藏 / 历史同一形状）
   * @param {{peek?:boolean}} [opt]
   */
  MP.vcard = function (site, opt) {
    const o = opt || {};
    const card = document.createElement('div');
    card.className = 'vcard';

    const cover = document.createElement('div');
    cover.className = 'vcover';
    cover.style.background = grad(site);
    cover.innerHTML = '<span class="vtag">'
      + esc(site.tagLabel || (site.tag ? tagLabel(site.tag) : '') || '页面') + '</span>'
      + '<span class="coverChar">' + esc(initial(site)) + '</span>'
      + '<span class="vviews">' + icon('view') + fmtNum(site.views) + '</span>'
      + (site.fileCount > 1
        ? '<span class="vkind">' + site.fileCount + ' 个文件</span>'
        : '');
    card.appendChild(cover);

    const body = document.createElement('div');
    body.className = 'vbody';

    const title = document.createElement('a');
    title.className = 'vtitle';
    title.href = viewUrl(site);
    title.textContent = site.title || site.name;
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'vmeta';
    meta.innerHTML = '<span>' + icon('like') + fmtNum(site.likes) + '</span>'
      + '<span>' + icon('fav') + fmtNum(site.favorites) + '</span>'
      + '<span>' + icon('comment') + fmtNum(site.comments) + '</span>';
    body.appendChild(meta);

    const author = document.createElement('div');
    author.className = 'vauthor';
    const a = document.createElement('a');
    a.href = '/qwq/' + encodeURIComponent(site.author.username);
    a.innerHTML = '<span class="avatar xs">' + esc(String(site.author.name || '?').charAt(0)) + '</span>';
    const nm = document.createElement('span');
    nm.className = 'aname';
    nm.textContent = site.author.name;
    a.appendChild(nm);
    author.appendChild(a);
    body.appendChild(author);

    card.appendChild(body);

    // 快捷赞 / 藏：直接打接口，成功后以服务端返回的数字为准
    const ops = document.createElement('div');
    ops.className = 'vops';
    const like = document.createElement('button');
    like.type = 'button';
    like.className = 'op' + (site.liked ? ' on' : '');
    like.innerHTML = icon('like') + ' ' + fmtNum(site.likes);
    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'op' + (site.favorited ? ' on' : '');
    fav.innerHTML = icon('fav') + ' ' + fmtNum(site.favorites);

    /** 只在登录后允许互动；未登录引导去登录页。 */
    async function interact(btn, apiPath, method, countKey) {
      if (!(await MP.me())) {
        MP.toast('登录后才能互动');
        location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
        return;
      }
      btn.disabled = true;
      try {
        const data = await MP.api(apiPath, { method });
        const isOn = data[countKey === 'favorites' ? 'favorited' : 'liked'];
        btn.classList.toggle('on', Boolean(isOn));
        btn.innerHTML = (countKey === 'favorites' ? icon('fav') : icon('like'))
          + ' ' + fmtNum(data[countKey]);
        site[countKey] = data[countKey];
      } catch (err) {
        MP.toast(err.message);
      } finally {
        btn.disabled = false;
      }
    }

    like.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const on = like.classList.contains('on');
      interact(like, siteApi(site, '/like'), on ? 'DELETE' : 'POST', 'likes');
    });
    fav.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const on = fav.classList.contains('on');
      interact(fav, siteApi(site, '/favorite'), on ? 'DELETE' : 'POST', 'favorites');
    });
    ops.appendChild(like);
    ops.appendChild(fav);
    card.appendChild(ops);

    if (o.peek !== false) attachPeek(card, site, cover);

    return card;
  };

  /**
   * 悬停实时预览：进入封面 300ms 后挂 iframe，离开即销毁。
   * iframe 直接指到真实的站点地址；站点页自身带 sandbox CSP，这里再加一层 sandbox 属性。
   */
  function attachPeek(card, site, cover) {
    let iframe = null;
    let timer = null;
    const open = () => {
      timer = setTimeout(() => {
        iframe = document.createElement('iframe');
        iframe.className = 'peek';
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'no-referrer';
        iframe.sandbox = 'allow-scripts';
        iframe.src = siteUrl(site) + '/';
        card.appendChild(iframe);
      }, 300);
    };
    const close = () => {
      clearTimeout(timer);
      if (iframe) { iframe.remove(); iframe = null; }
    };
    (cover || card).addEventListener('mouseenter', open);
    card.addEventListener('mouseleave', close);
  }
  MP.attachPeek = attachPeek;

  /** 批量渲染卡片到容器。 */
  MP.renderCards = function (box, sites, opt) {
    box.textContent = '';
    if (!sites.length) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1">没有找到相关页面，换个关键词试试。</div>';
      return;
    }
    sites.forEach((s) => box.appendChild(MP.vcard(s, opt)));
  };

  /* ----------------------------------------------------------
     7. 轻提示
     ---------------------------------------------------------- */

  MP.toast = function (msg) {
    let el = document.getElementById('mpToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mpToast';
      el.style.cssText = 'position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:999;'
        + 'background:rgba(24,25,28,.88);color:#fff;padding:8px 18px;border-radius:999px;'
        + 'font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
  };
})();
