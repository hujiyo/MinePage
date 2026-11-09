/* ============================================================
   MinePage 前端公共脚本（app.js）
   职责：图标库 / 统一顶栏 / 搜索下拉 / 站点卡片（含实时封面）/ 轻提示
   ------------------------------------------------------------
   所有数据都来自服务端 /api/*，这里不再有演示数据。
   页面脚本只按需调用 MP.*，不要把业务请求塞进这个文件。
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
    expand: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
    contract: '<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4L11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 4v4h-4"/>',
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
      coins: Number(user.coins ?? 0),
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

  // 与后端 lib/sites.js 的 SITE_TAGS 保持一致（key 存库，label 给人看）。
  // 'hot' 是前端伪标签（服务端词表里没有），首页把它映射成 sort=views。
  const TAGS = [
    { key: '', label: '全部' },
    { key: 'hot', label: '热门' },
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

  // 左侧导航只剩排行榜：首页由 logo 承担，收藏 / 历史已在右侧图标组里
  const NAVS = [
    { key: 'rank', label: '排行榜', href: '/?sort=rank' },
  ];

  // 顶栏「热门搜索」：后端没有热搜接口，先用内容标签的词，点了就是按词搜索。
  // 'hot' 是伪标签不是真实分类，不能出现在这里。有接口以后换成 GET /api/hot。
  const HOT_WORDS = TAGS.filter((t) => t.key && t.key !== 'hot').map((t) => t.label);

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
      +     '<a href="/account#coinSection">' + icon('coin') + '硬币 ' + fmtNum(me.coins) + ' 枚</a>'
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
      +   '<a class="tlogo" href="/" title="首页">' + icon('logo') + '<span class="tname">MinePage</span></a>'
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
   * @param {{active?:string}} [opt]
   */
  MP.topbar = function (opt) {
    const o = opt || {};
    const active = o.active || currentNav();
    const header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML = topbarHtml(active, ME);
    document.body.insertBefore(header, document.body.firstChild);

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
     5.1 本地布尔开关（观看页的底栏收起状态等）
     ---------------------------------------------------------- */

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
    // 封面两级：自定义上传图 > 迷你 iframe（站点顶部实时画面，即悬停下翻的起始画面）。
    // img/iframe 插在最前（coverChar 是 static 会被盖住，角标是 absolute 自然浮在上面）；
    // 自定义图加载失败就移除 img，露出渐变底完成回落。
    if (site.hasCover && site.author && site.author.username) {
      const img = document.createElement('img');
      img.className = 'vimg';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
      img.src = siteApi(site, '/cover');
      cover.insertBefore(img, cover.firstChild);
    } else {
      cover.appendChild(buildLiveCover(site, cover));
    }
    // 整块封面可点：卡片是 div，没有 href，不这么做用户点封面会以为卡片坏了。
    // 快捷赞/藏按钮在 .vops 里、不在封面上，所以不会被这里吃掉。
    const viewHref = viewUrl(site);
    cover.tabIndex = 0;
    cover.setAttribute('role', 'link');
    cover.setAttribute('aria-label', '观看 ' + (site.title || site.name));
    cover.addEventListener('click', () => { location.href = viewHref; });
    cover.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        location.href = viewHref;
      }
    });
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
        // 卡片下方那排数字跟着一起变，别出现「按钮 3、上面还写 2」
        const numbers = meta.querySelectorAll('span');
        if (countKey === 'likes') numbers[0].innerHTML = icon('like') + fmtNum(data.likes);
        else numbers[1].innerHTML = icon('fav') + fmtNum(data.favorites);
        // 收藏页靠这个回调重拉列表：取消收藏后当前收藏夹可能变空
        if (countKey === 'favorites' && o.onFavoriteChange) o.onFavoriteChange(site);
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

  // 迷你封面 / 悬停预览共用的虚拟视口与速度
  const COVER_VW = 1280; // 虚拟视口宽：桌面布局能正常展开
  // 虚拟视口高必须等于真实首屏高度（720）：iframe 里 100vh 跟着 iframe 高度走，
  // 视口拉太高会把全屏 hero 撑出封面可见区，封面就只剩一片背景色
  const COVER_VH = 720;
  const COVER_SPEED = 45; // 下翻速度（屏幕像素/秒）：太快像刷屏，太慢没进展

  // 封面并发闸门：封面是整站 iframe，同时开太多会把带宽切碎、每张都慢。
  // 同一时刻最多加载 COVER_MAX 张，其余按可见顺序排队；用户最先看到的卡片
  // 因此能独占带宽、最快出画面。加载完或超时即释放闸门给下一张。
  const COVER_MAX = 3;
  const COVER_DWELL = 400;    // 进入视口后停留这么久才排队（快速滚过的卡片不浪费流量）
  const COVER_TIMEOUT = 6000; // 超过这么久还没 load 就放行下一张，避免个别慢站卡住整条队列
  let coverBusy = 0;
  const coverQueue = []; // 待加载的 arm 函数，FIFO ≈ 页面从上到下的可见顺序

  function pumpCoverQueue() {
    while (coverBusy < COVER_MAX && coverQueue.length) {
      coverQueue.shift()();
    }
  }

  /**
   * 迷你 iframe 封面：封面区直接显示站点顶部画面（= 悬停下翻的起始画面）。
   * 懒加载 + 停留节流 + 并发闸门：滚进视口且停留一小会儿，才排进队列去载入真站；
   * 载入完成淡入（.mcover.loaded），超时则保留渐变占位、放行下一张。
   */
  function buildLiveCover(site, cover) {
    const frame = document.createElement('iframe');
    frame.className = 'mcover';
    frame.referrerPolicy = 'no-referrer';
    // 只给脚本不给同源：站点 JS 照常跑，但摸不到父页面和 cookie
    frame.sandbox = 'allow-scripts';
    frame.setAttribute('scrolling', 'no');
    let armed = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      coverBusy = Math.max(0, coverBusy - 1);
      pumpCoverQueue();
    };
    /** 算尺寸并载入真站（并发队列的入口，悬停兜底也会调它）。 */
    const arm = () => {
      if (armed) return;
      const scale = cover.clientWidth / COVER_VW;
      if (!scale) return; // 没布局好就先不占用闸门（悬停时会再试）
      armed = true;
      coverBusy += 1; // 占用一个并发槽，release 时归还
      frame.style.width = COVER_VW + 'px';
      frame.style.height = COVER_VH + 'px';
      frame.style.transformOrigin = '0 0';
      frame.style.transform = 'scale(' + scale + ')';
      // load 标志必须在设 src 之后挂：iframe 一创建就有 about:blank 的 load，不能算数
      const reveal = () => frame.classList.add('loaded'); // 淡入（见 style.css 的 .mcover）
      frame.addEventListener('load', () => {
        frame.dataset.loaded = '1';
        reveal();
        release();
      }, { once: true });
      // ?mpcover=1：服务端给入口 HTML 注入滚动代理，悬停时 postMessage 驱动内部下翻
      frame.src = siteUrl(site) + '/?mpcover=1';
      // 首屏通常很快就画出来了，不必等整站（含首屏外的图片/视频）全部下完才露脸：
      // 到点先显示，此时 iframe 底透明，没画出来的部分透出下层渐变占位，不会是白块。
      setTimeout(reveal, 900);
      setTimeout(release, COVER_TIMEOUT);
    };
    frame.arm = arm; // attachPeek 悬停兜底用

    // 懒加载 + 停留节流：进入视口起算 COVER_DWELL，期间滚出去就作废
    let dwell = null;
    const enqueue = () => { coverQueue.push(arm); pumpCoverQueue(); };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            if (!dwell) dwell = setTimeout(() => { io.disconnect(); enqueue(); }, COVER_DWELL);
          } else if (dwell) {
            clearTimeout(dwell);
            dwell = null;
          }
        }
      }, { threshold: 0.01 });
      io.observe(cover);
    } else {
      setTimeout(enqueue, COVER_DWELL);
    }
    return frame;
  }

  /**
   * 悬停实时预览：进入封面 300ms 后页面匀速自动向下翻（循环）。
   *
   * 没有自定义封面的卡片，封面本身就是 .mcover（站点顶部实时画面）——
   * 悬停时同一个 iframe 原地开始翻，移开后停在顶部继续当封面，所见即所得；
   * 自定义图封面的卡片没有 .mcover，才临时新建 .peek，移开即摘掉。
   *
   * 技术要点：沙箱 iframe（不给 allow-same-origin）里父页面碰不到它的内部滚动，
   * 所以服务端给带 ?mpcover=1 的入口页注入了一个滚动代理脚本，悬停时父页面
   * postMessage 让文档自己往下滚——等价于真实浏览器窗口下翻，100vh 全屏
   * 首屏的站点也能正常预览（离开时 mpPeekStop 回顶，封面继续显示首屏）。
   * iframe 挂在封面 div 里（.vcover 自带 overflow:hidden），缩放多出的部分被裁掉，
   * 不会盖住卡片的标题区；pointer-events:none 保证悬停事件照常触发。
   */
  function attachPeek(card, site, cover) {
    const target = cover || card;
    let frame = null;    // 本次悬停用的 iframe（复用 .mcover 或新建 .peek）
    let created = false; // 是否本次新建的（移开时要摘掉）
    let timer = null;
    let kick = null;
    let started = false;
    /** 页面加载完（或 1.5s 兜底）才开始下翻：白屏翻动没有意义。 */
    const start = () => {
      if (started || !frame) return;
      const scale = target.clientWidth / COVER_VW;
      if (!scale) return;
      started = true;
      // 下翻 = 驱动 iframe 内部文档滚动；速度换算成虚拟像素，滚动手感与缩放无关
      try {
        frame.contentWindow.postMessage({ mpPeekSpeed: Math.round(COVER_SPEED / scale) }, '*');
      } catch (e) { /* iframe 尚未就绪，交给 mpReady 握手补发 */ }
    };
    /** 悬停 300ms 后才开始：防止鼠标扫过卡片时一路触发。 */
    const open = () => {
      timer = setTimeout(() => {
        const scale = target.clientWidth / COVER_VW;
        if (!scale) return;
        started = false;
        frame = target.querySelector('iframe.mcover');
        if (frame) {
          // 封面 iframe 可能还在加载，load 后（或 1.5s 兜底）再翻
          if (frame.dataset.loaded === '1') {
            start();
          } else {
            // 懒加载还没触发（后台窗口等），悬停当场载入
            if (frame.arm) frame.arm();
            frame.addEventListener('load', start, { once: true });
            kick = setTimeout(start, 1500);
          }
        } else {
          created = true;
          const f = document.createElement('iframe');
          f.className = 'peek';
          f.loading = 'lazy';
          f.referrerPolicy = 'no-referrer';
          f.sandbox = 'allow-scripts';
          f.src = siteUrl(site) + '/?mpcover=1';
          f.style.width = COVER_VW + 'px';
          f.style.height = COVER_VH + 'px';
          f.style.transformOrigin = '0 0';
          f.style.transform = 'scale(' + scale + ')';
          target.appendChild(f);
          frame = f;
          f.addEventListener('load', start, { once: true });
          kick = setTimeout(start, 1500);
        }
      }, 300);
    };
    /** 离开封面：让内部滚动停下并回顶；新建的 .peek 摘掉，复用的 .mcover 留着当封面。 */
    const close = () => {
      clearTimeout(timer);
      clearTimeout(kick);
      started = false;
      if (frame) {
        try { frame.contentWindow.postMessage({ mpPeekStop: 1 }, '*'); } catch (e) { /* ignore */ }
      }
      if (frame && created) frame.remove();
      frame = null;
      created = false;
    };
    // 注入的滚动代理就绪后会广播 mpReady；若 start() 发速度时代理还没跑起来
    // （load / 1.5s 兜底都可能早于它执行，消息会丢），就绪这一刻把速度补发一次
    window.addEventListener('message', (e) => {
      const w = frame && frame.contentWindow;
      if (started && w && e.source === w && e.data && e.data.mpReady) {
        try {
          const scale = target.clientWidth / COVER_VW;
          w.postMessage({ mpPeekSpeed: Math.round(COVER_SPEED / scale) }, '*');
        } catch (err) { /* ignore */ }
      }
    });
    target.addEventListener('mouseenter', open);
    target.addEventListener('mouseleave', close);
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
