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
  /**
   * 按站点名算一个稳定的封面渐变：同名站点每次刷新拿到的颜色都一样。
   * 取的是 site.name（没有才退到 title），所以改站名会换色；色板是写死的 8 条。
   */
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

  // 演示数据占位对象：全文没有任何代码读它，真正被页面用的是下面的 MP.ME / MP.SITES / MP.HOT / MP.BANNERS。
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

  // 标签词表。
  // '' 和 'hot' 是筛选专用的伪标签（服务端不认，也不会被提交）；
  // 其余 key 必须与服务端 lib/sites.js 的 SITE_TAGS 完全一致，
  // 否则前端筛选项和服务端存的 key 对不上，筛出来是空的。
  // tests/scripts/consistency.mjs 会核对这件事。
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

  /**
   * 标签 key → 中文名；词表里查不到的 key 返回空串。
   * 注意 '' 在词表里是筛选项「全部」，所以没打标签的站点会得到「全部」而不是空串，
   * 想要别的兜底文案，调用方得自己先判断 key 是否为空（vcard 就是自己兜的）。
   */
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
    { name: 'mini-vue', title: 'mini-vue · 200 行读懂响应式', tag: 'opensource',
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
    { name: 'opensource-landing', title: '开源项目落地页 · Pager', tag: 'opensource',
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

  // TODO 后端对接：真要用时替换为 fetch('/api/discover?tag=…&q=…')；当前没有页面调用它，发现页走的是真实接口。
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

  // n 省略或传 0 都会落到默认的 8 条（内部是 n || 8）；返回新数组，排序不会动到 MP.SITES。
  // 数据源是写死的演示数据（见 MP.SITES 上面的 TODO），接口接上后要换成 /api/discover?sort=views。
  /** 热门榜单（按浏览排序）。 */
  MP.topSites = function (n) {
    return MP.SITES.slice().sort((a, b) => b.views - a.views).slice(0, n || 8);
  };

  /* ----------------------------------------------------------
     4. 搜索历史（localStorage）
     ---------------------------------------------------------- */

  const HIST_KEY = 'mp_search_hist';
  const HIST_MAX = 8;

  /**
   * 读本地搜索历史：最近 8 条，新的在前。
   * 隐私模式、或存进去的内容不是数组时返回空数组，不抛错；返回的是新数组，调用方随便改都不影响存储。
   */
  MP.searchHist = function () {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, HIST_MAX) : [];
    } catch { return []; }
  };

  /**
   * 记一条搜索历史：按词去重后插到最前，只保留最近 8 条。
   * 会写 localStorage；空白词直接忽略；写失败（隐私模式、配额满）静默放弃，调用方不用管。
   */
  MP.pushSearchHist = function (word) {
    const w = String(word || '').trim();
    if (!w) return;
    const list = MP.searchHist().filter((x) => x !== w);
    list.unshift(w);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch { /* 忽略隐私模式报错 */ }
  };

  /** 清空本地搜索历史；只影响当前浏览器，服务端没有这份记录。 */
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

  /** 顶栏显示名：真实用户没有 name 字段，用 username 兜 email。 */
  function displayName(user) {
    return user.username || user.email || '用户';
  }

  /** #tuser 的内部 HTML。user 为 null 表示未登录，显示登录入口。 */
  function userAreaInner(user) {
    if (!user) {
      // data-auth-open：点击弹窗登录、不跳转页面；href 保留作为 JS 失效时的兜底
      return '<a class="tlogin" href="/login" data-auth-open>' + icon('user') + '<span>登录 / 注册</span></a>';
    }

    const name = displayName(user);
    // 没有用户名时 /u/:username 是死链，改成引导去设置
    const home = user.username
      ? '<a href="/u/' + encodeURIComponent(user.username) + '">' + icon('user') + '我的主页</a>'
      : '<a href="/account">' + icon('user') + '设置用户名</a>';

    return ''
      + '<div class="avatar sm" title="' + esc(name) + '">' + esc(name[0] || '?') + '</div>'
      + '<div class="tmenu">'
      +   '<div class="who">' + esc(name) + '<small>' + esc(user.email) + '</small></div>'
      +   '<hr>'
      +   home
      +   '<a href="/account">' + icon('settings') + '账号设置</a>'
      +   '<a href="/sites">' + icon('grid') + '页面管理</a>'
      +   (user.isAdmin ? '<a href="/admin">' + icon('shield') + '管理后台</a>' : '')
      +   '<hr>'
      +   '<a href="/login" id="tLogout">' + icon('logout') + '退出登录</a>'
      + '</div>';
  }

  /**
   * 顶栏动作入口的内部 HTML。
   *
   * 两个红点的语义来自服务端，别弄反：
   *   session.unread         = 未读「动态」（通知）
   *   session.unreadMessages = 未读「消息」（私信）
   */
  function tactsInner(session) {
    const acts = [
      { key: 'messages', href: '/messages', ic: 'message', label: '消息', dot: session ? session.unreadMessages : 0 },
      { key: 'dynamic', href: '/notifications', ic: 'bell', label: '动态', dot: session ? session.unread : 0 },
      { key: 'favorites', href: '/favorites', ic: 'folder', label: '收藏' },
      { key: 'history', href: '/history', ic: 'history', label: '历史' },
      { key: 'upload', href: '/sites', ic: 'grid', label: '创作中心' },
    ];
    return acts.map((a) => '<a class="tact" href="' + a.href + '" title="' + a.label + '">'
      + icon(a.ic) + '<span>' + a.label + '</span>'
      + (a.dot ? '<i class="dot">' + a.dot + '</i>' : '')).join('');
  }

  /**
   * 拼出顶栏的 HTML 字符串（只返回字符串，不碰 DOM）。
   * 这里刻意按「未登录」渲染用户区和未读红点：真实会话是异步来的，先渲染演示用户会闪一下错账号，
   * 拿到会话后由 MP.topbar 用 innerHTML 把那两处补上。
   * active 与 NAVS 的 key 对应，决定哪个导航项加 .on；搜索历史与热搜此刻还是空的，挂载后再填。
   */
  function topbarHtml(active) {
    const nav = NAVS.map((n) => '<a href="' + n.href + '"'
      + (active === n.key ? ' class="on"' : '') + '>' + n.label + '</a>').join('');

    // 先按「未登录」渲染，避免闪出假的用户信息；拿到真实会话后由 MP.topbar 补上
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
      +   '<div class="tacts" id="tacts">' + tactsInner(null) + '</div>'
      +   '<a class="tupload" href="/upload">' + icon('upload') + '<span>投稿</span></a>'
      +   '<div class="tuser" id="tuser">' + userAreaInner(null) + '</div>'
      + '</div>';
  }

  /**
   * 挂载顶栏：注入到 body 最前。
   * @param {{active?:string, collapse?:boolean}} [opt]
   *   collapse=true 时在顶栏左下角加「收起/展开」箭头，并在收起后于屏幕顶部留一条触发带
   *
   * 副作用不少：改 DOM（插到 body 最前）、往 document 上挂 click 监听（挂上就不摘）、
   * 读 MP.searchHist / MP.HOT 填搜索面板、发 /api/me 请求，点「退出登录」还会
   * POST /api/auth/logout 再跳 /login。
   * 顺序是先本地渲染未登录态、再用会话打补丁，所以登录用户会看到极短的一下「登录 / 注册」，属预期。
   * 返回注入的 header 元素；一个页面只该调一次，重复调用会插出第二个顶栏（连带两套全局监听）。
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

    /**
     * 渲染搜索历史词条（每次展开、清空后各调一次）。
     * 用 textContent 写而不是拼 innerHTML：历史词是用户输入的内容，拼进去会被当成标签。
     * 绑 mousedown 而不是 click：输入框 blur 后才会延时收起面板，mousedown 早于 blur 触发，点词条不会扑空。
     */
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

    // 头像下拉。退出登录同样走委托绑定：用户区是异步补上的，
    // 直接绑到 #tLogout 元素上会在重渲染之后失效。
    const tu = header.querySelector('#tuser');
    tu.addEventListener('click', (e) => {
      if (e.target.closest('#tLogout')) {
        e.preventDefault();
        // 有真实会话时先清掉，再回登录页；无会话时该请求只是空操作
        fetch('/api/auth/logout', { method: 'POST' })
          .catch(() => { /* 忽略网络异常，直接跳转 */ })
          .finally(() => { location.href = '/login'; });
        return;
      }
      tu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!tu.contains(e.target)) tu.classList.remove('open');
    });
    document.addEventListener('click', (e) => {
      if (!ts.contains(e.target)) ts.classList.remove('open');
    });

    // 用真实会话补上用户区与未读红点。请求失败就保持未登录外观，不抛错。
    MP.session()
      .then((session) => {
        const userBox = header.querySelector('#tuser');
        if (userBox) userBox.innerHTML = userAreaInner(session.user);
        const actsBox = header.querySelector('#tacts');
        if (actsBox) actsBox.innerHTML = tactsInner(session.user ? session : null);
      })
      .catch(() => { /* 保持未登录外观 */ });

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

    /**
     * 把当前的收起状态刷到 body 的 class 与按钮 title 上；只读不写 localStorage
     *（写只在点击时做，所以挂载时能沿用上次的折叠状态）。
     */
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
   *
   * 返回的是 DOM 节点（不是 HTML 字符串），由调用方自己 append。
   * 字段兼容两套来源：页数认接口给的 fileCount，演示数据只有 pages；标签中文名优先 site.tagLabel，
   * 没有才用 tagLabel(site.tag) 去查词表。
   * opt.peek=false 时这张卡不挂悬停预览（卡片多的列表页更省）。
   * 右下角赞 / 藏两个按钮目前只切自己的 .on 样式，不发请求（见函数里的 TODO）。
   */
  MP.vcard = function (site, opt) {
    const o = opt || {};
    const card = document.createElement('div');
    card.className = 'vcard';

    const cover = document.createElement('div');
    cover.className = 'vcover';
    cover.style.background = grad(site);
    // 页数：接口给的是 fileCount/kind，演示数据给的是 pages，两种都认
    const pages = site.fileCount != null ? site.fileCount : (site.pages != null ? site.pages : 1);
    cover.innerHTML = '<span class="vtag">' + esc(site.tagLabel || tagLabel(site.tag) || '页面') + '</span>'
      + '<span class="coverChar">' + esc(initial(site)) + '</span>'
      + '<span class="vviews">' + icon('view') + fmtNum(site.views) + '</span>'
      + '<span class="vkind">' + (pages > 1 ? pages + ' 页' : '单页') + '</span>';
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
    const uname = site.author && site.author.username;
    // 作者可能没有用户名（账号还没设置过），也可能是被删掉的用户留下的无主站点：
    // 两种情况下 /u/:username 都打不开，所以退回首页而不是造一个死链。
    const aname = (site.author && site.author.name) || uname || '匿名';
    const a = document.createElement('a');
    a.href = uname ? '/u/' + encodeURIComponent(uname) : '/';
    a.innerHTML = '<span class="avatar xs">' + esc(aname[0] || '?') + '</span>';
    const nm = document.createElement('span');
    nm.className = 'aname';
    nm.textContent = aname;
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
    /** 悬停 300ms 后才挂 iframe：防止鼠标扫过卡片时一路建预览。 */
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
    /** 离开卡片：取消还没触发的定时器，并把已挂上的 iframe 摘掉（预览不常驻）。 */
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

  /**
   * 页内轻提示：页面顶部居中显示一行字，1.8 秒后淡出。
   * 节点是单例（#mpToast），连着调用只换文字并重新计时，不会叠出好几个；
   * 它带 pointer-events:none，所以盖在什么东西上都不挡点击。没有返回值。
   */
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

  // undefined = 还没请求过。请求一次后缓存，避免同一页面重复打接口。
  let sessionCache;

  /**
   * 读取当前会话：{ user, unread, unreadMessages }。
   *   user          为 null 表示未登录
   *   unread        未读「动态」（通知）
   *   unreadMessages 未读「消息」（私信）
   * 请求失败按未登录处理，不抛错。
   * @returns {Promise<{user:object|null, unread:number, unreadMessages:number}>}
   */
  MP.session = async function () {
    if (sessionCache !== undefined) return sessionCache;

    try {
      const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
      const data = await res.json();
      sessionCache = {
        user: data && data.user ? data.user : null,
        unread: Number(data && data.unread) || 0,
        unreadMessages: Number(data && data.unreadMessages) || 0,
      };
    } catch {
      sessionCache = { user: null, unread: 0, unreadMessages: 0 };
    }

    return sessionCache;
  };

  /** 只取用户对象；未登录返回 null。 */
  MP.me = async function () {
    return (await MP.session()).user;
  };

  /** 丢弃缓存（退出登录、改完用户名之后调用）。 */
  MP.forgetSession = function () {
    sessionCache = undefined;
  };

  /* ----------------------------------------------------------
     9. 登录弹窗
     ---------------------------------------------------------- */

  // 要求：所有「需要登录」的入口都在当前页上弹窗，不跳转页面；
  // 弹窗打开时，后面页面除滚轮外全部不可操作（由 .modal-mask 的
  // position:fixed 挡住指针事件实现，且刻意不锁 body 滚动）。

  /**
   * 需要登录才能用的路径。
   * 这份清单必须与服务端守卫保持一致——tests/scripts/e2e-auth.mjs
   * 会拿真实的匿名请求结果来核对，防止两边漂移。
   */
  const LOGIN_REQUIRED = [
    /^\/sites(\/|$)/,
    /^\/upload(\/|$)/,
    /^\/account(\/|$)/,
    /^\/settings(\/|$)/,
    /^\/edit\//,
    /^\/admin(\/|$)/,
    /^\/messages(\/|$)/,
    /^\/notifications(\/|$)/,
    /^\/favorites(\/|$)/,
    /^\/history(\/|$)/,
  ];

  /**
   * 这个链接是不是「必须登录」的路径：参数是页面里的原始 href（形如 /messages，不是绝对 URL）。
   * 清单必须与服务端守卫一致 —— 客户端少了会直接跳转，服务端少了等于没保护。
   */
  function needsLogin(href) {
    return LOGIN_REQUIRED.some((re) => re.test(href));
  }

  /** 登录 / 注册表单的标记。弹窗和 /login 页共用同一份。 */
  const AUTH_FORM_HTML = ''
    + '<div class="modal-tabs" role="tablist">'
    +   '<button type="button" class="mtab on" data-tab="login" role="tab" aria-selected="true">登录</button>'
    +   '<button type="button" class="mtab" data-tab="register" role="tab" aria-selected="false">注册</button>'
    + '</div>'
    + '<form class="auth-login" novalidate>'
    +   '<label class="field"><span class="label">邮箱或用户名</span>'
    +     '<input name="loginId" type="text" autocomplete="username" placeholder="you@example.com"></label>'
    +   '<label class="field"><span class="label">密码 <a class="forgot" href="/forgot">忘记密码？</a></span>'
    +     '<input name="loginPassword" type="password" autocomplete="current-password" placeholder="请输入密码"></label>'
    +   '<button type="submit" class="mbtn primary">登 录</button>'
    +   '<p class="mswitch">还没有账号？<a href="#" data-goto="register">立即注册</a></p>'
    + '</form>'
    + '<form class="auth-register" novalidate hidden>'
    +   '<label class="field"><span class="label">邮箱</span>'
    +     '<input name="registerEmail" type="email" autocomplete="email" placeholder="you@example.com"></label>'
    +   '<label class="field"><span class="label">邮箱验证码</span>'
    +     '<span class="code-row">'
    +       '<input name="registerCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字">'
    +       '<button type="button" class="mbtn ghost" data-send-code disabled>发送验证码</button>'
    +     '</span>'
    +     '<span class="hint" data-code-hint>先填邮箱，再点「发送验证码」</span></label>'
    +   '<label class="field"><span class="label">密码</span>'
    +     '<input name="registerPassword" type="password" autocomplete="new-password" placeholder="至少 6 位">'
    +     '<span class="hint">至少 6 位</span></label>'
    +   '<button type="submit" class="mbtn primary">注 册</button>'
    +   '<p class="mswitch">已有账号？<a href="#" data-goto="login">去登录</a></p>'
    + '</form>'
    + '<div class="result" data-msg hidden></div>';

  /**
   * 把登录 / 注册表单渲染进 container 并接好逻辑。
   * 抽出来是为了让弹窗与 /login 页共用同一份实现，避免两份逻辑漂移。
   *
   * @param {HTMLElement} container
   * @param {{initialTab?: 'login'|'register', onSuccess?: (user:object)=>void}} [opts]
   */
  function mountAuthForm(container, opts) {
    const o = opts || {};
    container.innerHTML = AUTH_FORM_HTML;

    const tabLogin = container.querySelector('[data-tab="login"]');
    const tabReg = container.querySelector('[data-tab="register"]');
    const loginForm = container.querySelector('.auth-login');
    const regForm = container.querySelector('.auth-register');
    const msg = container.querySelector('[data-msg]');

    /** 在表单下方显示一行结果：ok 决定用成功样式还是错误样式，text 作为纯文本写入。 */
    function showMsg(ok, text) {
      msg.hidden = false;
      msg.className = 'result ' + (ok ? 'ok' : 'err');
      msg.textContent = text;
    }

    /**
     * 切换登录 / 注册页签：显示对应表单、同步 aria-selected、顺手清掉上一条结果提示。
     * 只切显示，不清空另一个表单已填的内容（来回切不丢输入）；除 'register' 以外的值都按登录处理。
     * 切换后会向 container 派发冒泡的 'auth:tab' 事件，弹窗靠它把标题改成注册 / 登录。
     */
    function switchTab(which) {
      const isLogin = which !== 'register';
      tabLogin.classList.toggle('on', isLogin);
      tabReg.classList.toggle('on', !isLogin);
      tabLogin.setAttribute('aria-selected', isLogin ? 'true' : 'false');
      tabReg.setAttribute('aria-selected', isLogin ? 'false' : 'true');
      loginForm.hidden = !isLogin;
      regForm.hidden = isLogin;
      msg.hidden = true;
      container.dispatchEvent(new CustomEvent('auth:tab', { detail: which, bubbles: true }));
    }

    tabLogin.addEventListener('click', () => switchTab('login'));
    tabReg.addEventListener('click', () => switchTab('register'));
    container.querySelectorAll('[data-goto]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); switchTab(a.dataset.goto); });
    });

    /**
     * 往鉴权接口发 JSON POST 并解析 JSON 返回。
     * 不看 HTTP 状态码：业务失败也是 200 + { ok:false, message }，由调用方判 data.ok；
     * 网络异常或响应不是 JSON 时会抛，调用方要自己 catch（现在每个调用点都有 try/catch）。
     */
    async function post(url, payload) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.json();
    }

    /**
     * 登录 / 注册成功后的公共收尾：先让会话缓存作废（否则顶栏还按未登录渲染），
     * 再把用户对象交给调用方 —— 弹窗就是在这个回调里关掉自己并跳转 / 刷新页面的。
     */
    function done(user) {
      // 会话变了，丢掉缓存，免得顶栏还显示旧状态
      MP.forgetSession();
      if (o.onSuccess) o.onSuccess(user);
    }


    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = loginForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const data = await post('/api/auth/login', {
          login: loginForm.elements.loginId.value,
          password: loginForm.elements.loginPassword.value,
        });
        if (data.ok) {
          showMsg(true, '登录成功…');
          done(data.user);
        } else {
          showMsg(false, data.message || '登录失败');
        }
      } catch (err) {
        showMsg(false, '网络出问题了：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });

    const sendBtn = regForm.querySelector('[data-send-code]');
    const codeHint = regForm.querySelector('[data-code-hint]');
    const emailInput = regForm.elements.registerEmail;
    /** 邮箱格式粗校验，只用来控制「发送验证码」按不按得动；真正的校验在服务端。 */
    const emailOk = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim());

    let countdown = 0;
    let timer = null;

    /**
     * 验证码发出去之后的重发倒计时：按钮禁用、每秒改一次文案，归零后按邮箱是否合法恢复可点。
     * 陷阱：它只覆盖闭包里的 timer，倒计时没走完再调一次会同时跑两个 interval
     *（目前撞不上，倒计时期间按钮是禁用的）；要提前收尾只能用返回的 destroy()，而且只清得掉最后一个。
     */
    function startCountdown(seconds) {
      countdown = seconds;
      sendBtn.disabled = true;
      timer = setInterval(() => {
        countdown -= 1;
        if (countdown <= 0) {
          clearInterval(timer);
          sendBtn.disabled = !emailOk();
          sendBtn.textContent = '重新发送';
        } else {
          sendBtn.textContent = countdown + ' 秒';
        }
      }, 1000);
    }

    emailInput.addEventListener('input', () => {
      if (countdown <= 0) sendBtn.disabled = !emailOk();
    });

    sendBtn.addEventListener('click', async () => {
      if (!emailOk()) { showMsg(false, '先填一个正确的邮箱'); return; }
      sendBtn.disabled = true;
      try {
        const data = await post('/api/auth/send-code', {
          purpose: 'register',
          email: emailInput.value.trim(),
        });
        if (data.ok) {
          codeHint.textContent = data.dev
            ? '验证码已生成（未配置 SMTP，请到服务器控制台查看）'
            : '验证码已发送，10 分钟内有效';
          startCountdown(60);
        } else {
          codeHint.textContent = data.message || '发送失败';
          sendBtn.disabled = false;
        }
      } catch (err) {
        codeHint.textContent = '网络出问题了：' + err.message;
        sendBtn.disabled = false;
      }
    });

    regForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = regForm.querySelector('button[type="submit"]');
      btn.disabled = true;

      if (!/^\d{6}$/.test(regForm.elements.registerCode.value.trim())) {
        showMsg(false, '请输入 6 位邮箱验证码');
        btn.disabled = false;
        return;
      }

      try {
        const data = await post('/api/auth/register', {
          email: emailInput.value.trim(),
          code: regForm.elements.registerCode.value.trim(),
          password: regForm.elements.registerPassword.value,
        });
        if (data.ok) {
          showMsg(true, '注册成功…');
          done(data.user);
        } else {
          showMsg(false, data.message || '注册失败');
        }
      } catch (err) {
        showMsg(false, '网络出问题了：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });

    switchTab(o.initialTab === 'register' ? 'register' : 'login');

    return {
      switchTab,
      destroy() { if (timer) clearInterval(timer); },
    };
  }

  // 同一时刻只允许一个登录弹窗
  let authModal = null;

  /**
   * 在当前页弹出登录窗。
   * @param {{next?: string}} [opts] next 是登录成功后要去的地址；
   *        留空则留在当前页并刷新。
   *
   * 同一时刻只认一个弹窗：已经开着就直接把原来那个返回（顺手聚焦第一个输入框），
   * 不会再建第二个，新传的 next 也会被忽略。
   */
  function openLoginModal(opts) {
    const o = opts || {};
    if (authModal) {
      const focus = authModal.querySelector('input');
      if (focus) focus.focus();
      return authModal;
    }

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = ''
      + '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mpAuthTitle">'
      +   '<button class="modal-x" type="button" data-close aria-label="关闭">×</button>'
      +   '<h2 class="modal-title" id="mpAuthTitle">登录 MinePage</h2>'
      +   '<div data-form></div>'
      +   '<p class="modal-foot">登录即代表你同意 <a href="#">用户协议</a> 与 <a href="#">隐私政策</a></p>'
      + '</div>';

    document.body.appendChild(mask);
    authModal = mask;

    const titleEl = mask.querySelector('#mpAuthTitle');
    mask.addEventListener('auth:tab', (e) => {
      titleEl.textContent = e.detail === 'register' ? '注册 MinePage' : '登录 MinePage';
    });

    mountAuthForm(mask.querySelector('[data-form]'), {
      onSuccess(user) {
        closeLoginModal();
        if (o.next) { location.href = o.next; return; }
        // 没指定去处：刷新当前页，让内容和顶栏都反映登录后的状态
        location.reload();
      },
    });

    mask.querySelector('[data-close]').addEventListener('click', () => closeLoginModal());
    // 刻意不做「点遮罩空白就关闭」：
    //   1. 与 B 站的登录弹窗一致（它只有 X 能关）；
    //   2. 要求是「除滚轮外其他都不可操作」，点外面不该产生任何效果；
    //   3. 用户可能已经填了邮箱和密码，误点外面丢掉太亏。
    // 关闭方式只有两个：右上角 X，以及 Esc。

    /** Esc 关闭用：监听挂在 document 上，句柄存在弹窗元素上，由 closeLoginModal 负责摘掉。 */
    const onKey = (e) => { if (e.key === 'Escape') closeLoginModal(); };
    mask.__onKey = onKey;
    document.addEventListener('keydown', onKey);

    // 刻意不锁 body 滚动：要求是「除滚轮外都不可操作」。
    // 遮罩是 fixed 且自身不滚动，滚轮会冒泡到文档，后面页面照常滚。
    const first = mask.querySelector('input');
    if (first) setTimeout(() => first.focus(), 30);

    return mask;
  }

  /**
   * 关闭登录弹窗：摘掉 Esc 监听并移除遮罩；没有弹窗时什么都不做。
   * 要关弹窗请走 MP.auth.close（就是这个函数），别自己删 .modal-mask：
   * authModal 这个单例标记会留在原地，之后再点登录会被当成「已经开着」而直接返回。
   */
  function closeLoginModal() {
    if (!authModal) return;
    if (authModal.__onKey) document.removeEventListener('keydown', authModal.__onKey);
    authModal.remove();
    authModal = null;
  }

  /**
   * 全局点击拦截：需要登录的链接在未登录时改为弹窗，而不是跳转页面。
   *
   * 关键点：preventDefault() 必须同步调用，而会话检查是异步的。
   * 所以策略是「先一律拦住，拿到会话之后再决定跳转还是弹窗」。
   *
   * 它注册在捕获阶段，会比页面里自己的 click 处理器先跑，所以开头要先看 e.defaultPrevented：
   * 已经被别人处理过的点击，这里不再插手。
   * 带修饰键的点击（新标签页 / 下载）、# 锚点、http(s): 等外链一律放过，交给浏览器原生行为。
   * 整个文档只装一次（用 window.__mpAuthGuard 做标记），重复调用直接返回。
   */
  function installAuthGuard() {
    if (window.__mpAuthGuard) return;
    window.__mpAuthGuard = true;

    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      // 带修饰键的点击（新标签页、下载等）保持浏览器原生行为
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const target = e.target instanceof Element ? e.target : e.target.parentElement;
      if (!target) return;

      // 显式要求登录的触发器（顶栏「登录 / 注册」）
      const opener = target.closest('[data-auth-open]');
      if (opener) {
        e.preventDefault();
        openLoginModal({ next: opener.getAttribute('data-auth-next') || '' });
        return;
      }

      const link = target.closest('a[href]');
      if (!link) return;

      const href = link.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      if (!needsLogin(href)) return;

      e.preventDefault();
      MP.session()
        .then((session) => {
          if (session.user) { location.href = href; return; }
          openLoginModal({ next: href });
        })
        .catch(() => { location.href = href; });
    }, true);
  }

  MP.auth = {
    LOGIN_REQUIRED,
    needsLogin,
    mountForm: mountAuthForm,
    openLogin: openLoginModal,
    close: closeLoginModal,
  };

  // 每个加载了 app.js 的页面都装上拦截
  installAuthGuard();
})();
