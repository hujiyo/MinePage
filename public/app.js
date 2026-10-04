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

  /* ----------------------------------------------------------
     3. 演示数据（TODO 后端对接：全部替换为 /api/* 返回）
     ---------------------------------------------------------- */

  const DEMO = { enabled: true };

  // TODO 后端对接：替换为 fetch('/api/me')
  MP.ME = {
    name: '演示用户',
    username: 'demo',
    email: 'demo@minepage.dev',
    isAdmin: true,
    bio: '在做一个个人网页托管社区，随手收集好看的页面。',
    unread: 3,      // 未读消息
    dynamic: 5,     // 未读动态
  };

  const TAGS = [
    { key: '', label: '全部' },
    { key: 'hot', label: '热门' },
    { key: 'resume', label: '求职简历' },
    { key: 'portfolio', label: '作品集' },
    { key: 'social', label: '社交聚合页' },
    { key: 'blog', label: '技术博客' },
    { key: 'event', label: '活动落地页' },
    { key: 'oss', label: '开源项目' },
    { key: 'other', label: '其他' },
  ];
  MP.TAGS = TAGS;

  function tagLabel(key) {
    const t = TAGS.find((x) => x.key === key);
    return t ? t.label : '';
  }
  MP.tagLabel = tagLabel;

  // TODO 后端对接：替换为 fetch('/api/discover')
  MP.SITES = [
    { name: 'lin-resume', title: '林同学 · 前端工程师求职简历', tag: 'resume',
      description: '一份用单页 HTML 写的简历，含项目经历、技能雷达和作品链接。',
      author: { name: '林同学', username: 'lin' }, views: 12800, likes: 342, favorites: 128, comments: 26, pages: 1 },
    { name: 'aurora-portfolio', title: 'Aurora 视觉设计作品集', tag: 'portfolio',
      description: 'Motion 与品牌视觉合集，深色留白排版，滚动动效。',
      author: { name: 'Aurora', username: 'aurora' }, views: 45200, likes: 1890, favorites: 763, comments: 88, pages: 6 },
    { name: 'linkhub', title: '我的社交聚合页 · LinkHub', tag: 'social',
      description: '把微博、GitHub、播客和邮箱收在一页，支持一键复制。',
      author: { name: '演示用户', username: 'demo' }, views: 7300, likes: 156, favorites: 92, comments: 11, pages: 1 },
    { name: 'weekly-blog', title: '前端周刊笔记 · 第 42 期', tag: 'blog',
      description: '每周整理值得读的前端文章，本期聊渲染性能与可访问性。',
      author: { name: '演示用户', username: 'demo' }, views: 25600, likes: 920, favorites: 431, comments: 54, pages: 12 },
    { name: 'summer-fest', title: '夏日音乐节 · 活动落地页', tag: 'event',
      description: '演出阵容、购票入口与场地地图，含倒计时与票务进度条。',
      author: { name: 'Momo', username: 'momo' }, views: 31500, likes: 1120, favorites: 508, comments: 132, pages: 4 },
    { name: 'mini-vue', title: 'mini-vue · 200 行读懂响应式', tag: 'oss',
      description: '手写一个迷你 Vue，附可交互的依赖收集演示页面。',
      author: { name: 'Byte', username: 'byte' }, views: 68400, likes: 3210, favorites: 1780, comments: 240, pages: 9 },
    { name: 'coffee-shop', title: '街角咖啡 · 门店与菜单', tag: 'other',
      description: '小店官网，菜单、营业时间与外卖入口，移动端优先。',
      author: { name: '豆子', username: 'douzi' }, views: 9400, likes: 210, favorites: 76, comments: 18, pages: 3 },
    { name: 'ui-notes', title: '设计系统笔记 · 色彩与间距', tag: 'blog',
      description: '把自己的设计 token 整理成可视化的对比页，方便团队对齐。',
      author: { name: '演示用户', username: 'demo' }, views: 18200, likes: 640, favorites: 355, comments: 41, pages: 5 },
    { name: 'grad-apply', title: '保研材料汇总页（简历+项目+成绩）', tag: 'resume',
      description: '把申请材料做成一页索引，老师扫码即可查看附件。',
      author: { name: '演示用户', username: 'demo' }, views: 6100, likes: 98, favorites: 44, comments: 7, pages: 1 },
    { name: 'pixel-game', title: '像素小游戏合集 · 摸鱼专用', tag: 'other',
      description: '三个纯前端小游戏，键盘操作，支持本地最高分记录。',
      author: { name: 'Ken', username: 'ken' }, views: 52300, likes: 2450, favorites: 1330, comments: 176, pages: 8 },
    { name: 'photo-wall', title: '毕业照云相册墙', tag: 'social',
      description: '全班照片瀑布流，支持按人筛选与一键下载原图。',
      author: { name: '小满', username: 'man' }, views: 14700, likes: 512, favorites: 268, comments: 63, pages: 2 },
    { name: 'opensource-landing', title: '开源项目落地页 · Pager', tag: 'oss',
      description: '项目介绍、Star 趋势图与快速上手代码示例。',
      author: { name: 'Pager', username: 'pager' }, views: 39800, likes: 1560, favorites: 890, comments: 102, pages: 7 },
  ];

  // TODO 后端对接：替换为 fetch('/api/hot')
  MP.HOT = [
    { word: '前端简历模板', tag: '热', val: '128.6万' },
    { word: '个人作品集怎么做', val: '96.3万' },
    { word: '暑期活动落地页', tag: '新', val: '74.1万' },
    { word: '响应式布局教程', val: '58.9万' },
    { word: '毕设网页模板', val: '47.2万' },
    { word: '开源项目主页', val: '36.5万' },
    { word: '社交聚合页', val: '28.7万' },
    { word: '动效设计参考', val: '21.4万' },
  ];

  // TODO 后端对接：轮播位来自运营配置
  MP.BANNERS = [
    { title: '夏日作品集征集 · 晒出你的个人主页', sub: '投稿即有机会登上首页推荐', site: 'aurora-portfolio',
      img: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=soft%20gradient%20background%20in%20summer%20blue%20and%20pink%2C%20abstract%20smooth%20waves%2C%20minimal%20modern%20poster%2C%20no%20text%2C%20no%20letters%2C%20no%20words&image_size=landscape_16_9' },
    { title: 'MinePage 创作激励计划上线', sub: '优质页面获得流量扶持与徽章', site: 'mini-vue',
      img: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=pink%20to%20white%20gradient%20background%20with%20soft%20geometric%20shapes%2C%20minimal%20creative%20technology%20poster%2C%20no%20text%2C%20no%20letters%2C%20no%20words&image_size=landscape_16_9' },
    { title: '本周热门 · 开源项目主页精选', sub: '看看大家都在 Star 什么', site: 'opensource-landing',
      img: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=deep%20blue%20night%20sky%20with%20tiny%20glowing%20stars%20and%20soft%20light%20streaks%2C%20minimal%20tech%20poster%2C%20no%20text%2C%20no%20letters%2C%20no%20words&image_size=landscape_16_9' },
  ];

  /** 按标签/关键词过滤演示数据。 */
  MP.querySites = function (opt) {
    const q = (opt && opt.q || '').trim().toLowerCase();
    const tag = (opt && opt.tag) || '';
    return MP.SITES.filter((s) => {
      if (tag === 'hot' ? (s.views < 20000) : (tag && s.tag !== tag)) return false;
      if (!q) return true;
      return (s.title + s.description + s.name + s.author.name).toLowerCase().includes(q);
    });
  };

  /** 热门榜单（按浏览排序）。 */
  MP.topSites = function (n) {
    return MP.SITES.slice().sort((a, b) => b.views - a.views).slice(0, n || 8);
  };

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

  function topbarHtml(active) {
    const me = MP.ME;
    const nav = NAVS.map((n) => '<a href="' + n.href + '"'
      + (active === n.key ? ' class="on"' : '') + '>' + n.label + '</a>').join('');

    const acts = [
      { key: 'messages', href: '/messages', ic: 'message', label: '消息', dot: me.unread },
      { key: 'dynamic', href: '/notifications', ic: 'bell', label: '动态', dot: me.dynamic },
      { key: 'favorites', href: '/favorites', ic: 'folder', label: '收藏' },
      { key: 'history', href: '/history', ic: 'history', label: '历史' },
      { key: 'upload', href: '/sites', ic: 'grid', label: '创作中心' },
    ].map((a) => '<a class="tact" href="' + a.href + '" title="' + a.label + '">'
      + icon(a.ic) + '<span>' + a.label + '</span>'
      + (a.dot ? '<i class="dot">' + a.dot + '</i>' : '') + '</a>').join('');

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
      +       '<div class="tsSec" style="margin-top:6px">' + icon('fire') + '<span style="flex:1">热门搜索</span></div>'
      +       '<div class="tsHot" id="tsHot"></div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="tacts">' + acts + '</div>'
      +   '<a class="tupload" href="/upload">' + icon('upload') + '<span>投稿</span></a>'
      +   '<div class="tuser" id="tuser">'
      +     '<div class="avatar sm" title="' + esc(me.name) + '">' + esc(me.name[0]) + '</div>'
      +     '<div class="tmenu">'
      +       '<div class="who">' + esc(me.name) + '<small>' + esc(me.email) + '</small></div>'
      +       '<hr>'
      +       '<a href="/u/' + encodeURIComponent(me.username) + '">' + icon('user') + '我的主页</a>'
      +       '<a href="/account">' + icon('settings') + '账号设置</a>'
      +       '<a href="/sites">' + icon('grid') + '页面管理</a>'
      +       (me.isAdmin ? '<a href="/admin">' + icon('shield') + '管理后台</a>' : '')
      +       '<hr>'
      +       '<a href="/login" id="tLogout">' + icon('logout') + '退出登录</a>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  /**
   * 挂载顶栏：注入到 body 最前。
   * @param {{active?:string, collapse?:boolean}} [opt]
   *   collapse=true 时在顶栏左下角加「收起/展开」箭头，并在收起后于屏幕顶部留一条触发带
   */
  MP.topbar = function (opt) {
    const o = opt || {};
    const active = o.active || currentNav();
    const header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML = topbarHtml(active);
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
    MP.HOT.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'hRow';
      row.innerHTML = '<span class="hNo' + (i < 3 ? ' top' + (i + 1) : '') + '">' + (i + 1) + '</span>'
        + '<span class="hWord">' + esc(h.word)
        + (h.tag ? '<span class="hTag">' + esc(h.tag) + '</span>' : '') + '</span>'
        + '<span class="hVal">' + esc(h.val) + '</span>';
      row.addEventListener('mousedown', (e) => { e.preventDefault(); MP.goSearch(h.word); });
      hotBox.appendChild(row);
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

    // 头像下拉
    const tu = header.querySelector('#tuser');
    tu.addEventListener('click', (e) => {
      if (e.target.closest('#tLogout')) return;
      tu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!tu.contains(e.target)) tu.classList.remove('open');
    });
    document.addEventListener('click', (e) => {
      if (!ts.contains(e.target)) ts.classList.remove('open');
    });
    header.querySelector('#tLogout').addEventListener('click', (e) => {
      e.preventDefault();
      // 有真实会话时先清掉，再回登录页；无会话时该请求只是空操作
      fetch('/api/auth/logout', { method: 'POST' })
        .catch(() => { /* 忽略网络异常，直接跳转 */ })
        .finally(() => { location.href = '/login'; });
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
   * @param {object} site 站点数据
   * @param {{peek?:boolean}} [opt]
   */
  MP.vcard = function (site, opt) {
    const o = opt || {};
    const card = document.createElement('div');
    card.className = 'vcard';

    const cover = document.createElement('div');
    cover.className = 'vcover';
    cover.style.background = grad(site);
    cover.innerHTML = '<span class="vtag">' + esc(tagLabel(site.tag) || '页面') + '</span>'
      + '<span class="coverChar">' + esc(initial(site)) + '</span>'
      + '<span class="vviews">' + icon('view') + fmtNum(site.views) + '</span>'
      + '<span class="vkind">' + (site.pages > 1 ? site.pages + ' 页' : '单页') + '</span>';
    card.appendChild(cover);

    const body = document.createElement('div');
    body.className = 'vbody';

    const title = document.createElement('a');
    title.className = 'vtitle';
    title.href = '/view/' + encodeURIComponent(site.name);
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
    a.href = '/u/' + encodeURIComponent(site.author.username);
    a.innerHTML = '<span class="avatar xs">' + esc(site.author.name[0]) + '</span>';
    const nm = document.createElement('span');
    nm.className = 'aname';
    nm.textContent = site.author.name;
    a.appendChild(nm);
    author.appendChild(a);
    body.appendChild(author);

    card.appendChild(body);

    // 快捷赞 / 藏
    const ops = document.createElement('div');
    ops.className = 'vops';
    const like = document.createElement('button');
    like.type = 'button';
    like.className = 'op';
    like.innerHTML = icon('like') + ' ' + fmtNum(site.likes);
    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'op';
    fav.innerHTML = icon('fav') + ' ' + fmtNum(site.favorites);
    // TODO 后端对接：POST/DELETE /api/sites/:name/like | /favorite
    [['like', like], ['fav', fav]].forEach(([kind, btn]) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        btn.classList.toggle('on');
      });
    });
    ops.appendChild(like);
    ops.appendChild(fav);
    card.appendChild(ops);

    if (o.peek !== false) attachPeek(card, site, cover);

    return card;
  };

  /**
   * 悬停实时预览：进入封面 300ms 后挂 iframe，离开即销毁。
   * 前端阶段站点 slug 并不存在，故用 srcdoc 生成一张预览占位。
   * TODO 后端对接：把 iframe.src 换成 '/' + site.name + '/'
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
        iframe.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
          + 'html,body{margin:0;height:100%;font-family:system-ui,sans-serif;'
          + 'background:' + grad(site) + ';display:flex;align-items:center;justify-content:center;color:#fff}'
          + '.w{text-align:center;padding:16px}'
          + '.w b{display:block;font-size:18px}'
          + '.w p{font-size:12px;opacity:.9;margin:6px 0 0}'
          + '</style></head><body><div class="w"><b>' + esc(site.title || site.name)
          + '</b><p>' + esc((site.description || '').slice(0, 40)) + '</p></div></body></html>';
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

  /* ----------------------------------------------------------
     8. 当前登录态
     ---------------------------------------------------------- */

  /**
   * 获取当前用户。
   * 前端阶段直接返回演示用户；接后端时改回 fetch('/api/me')。
   * @returns {Promise<object|null>}
   */
  MP.me = async function () {
    // TODO 后端对接：
    // const res = await fetch('/api/me');
    // const data = await res.json();
    // return data.user;
    return DEMO.enabled ? MP.ME : null;
  };
})();
