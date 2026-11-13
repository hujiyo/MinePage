/* ============================================================
   MinePage 创作组件（studio.js）
   创作页 / 新建对话页 / 工作区共用：
   实时首屏封面、发布弹窗、对话栏、草稿接口的薄封装。
   业务请求集中在这里，页面脚本只负责布局与跳转。
   ============================================================ */

(function () {
  'use strict';

  const MP = window.MP;
  if (!MP) return;

  const enc = encodeURIComponent;

  /* ----------------------------------------------------------
     0. 草稿接口薄封装
     ---------------------------------------------------------- */

  /** 站点接口：/api/sites/<用户名>/<站名><tail> */
  MP.siteApiOf = function (username, name, tail) {
    return '/api/sites/' + enc(username || '') + '/' + enc(name || '') + (tail || '');
  };

  /** 草稿访问地址：/qwq/<用户名>/<站名>/（草稿只有作者本人能打开）。 */
  MP.draftUrl = function (username, name) {
    return '/qwq/' + enc(username || '') + '/' + enc(name || '') + '/';
  };

  /**
   * 建一张草稿站（不占「每人 10 站」配额，草稿另有 20 上限）。
   * @param {string} [name] 指定站名；省略时由服务端按时间戳生成
   * @returns {Promise<{site:{id,name,status,url}, drafts:number, maxDrafts:number}>}
   */
  MP.createDraft = function (name) {
    return MP.api('/api/studio/drafts', { method: 'POST', body: name ? { name } : {} });
  };

  /** 读草稿的对话记录（按时间正序）。 */
  MP.loadSiteMessages = async function (username, name) {
    const data = await MP.api(MP.siteApiOf(username, name, '/messages'));
    return data.messages || [];
  };

  /** 发一条消息；服务端立刻返回 taskId，agent 在后台跑。
   *  threadId 给了就挂到那个会话上，不给就落到最近一个会话。
   *  attachIds 是已经上传的图片 id。 */
  MP.sendSiteMessage = function (username, name, content, threadId, attachIds) {
    const body = { content };
    if (threadId) body.threadId = threadId;
    if (Array.isArray(attachIds) && attachIds.length) body.attachments = attachIds;
    return MP.api(MP.siteApiOf(username, name, '/messages'), { method: 'POST', body });
  };

  /* ----------------------------------------------------------
     1. 实时首屏封面（16:10 等比缩放）
     ---------------------------------------------------------- */

  // 虚拟视口：与首页封面同思路，桌面布局才能正常展开；
  // 视口高度按 16:10 算，缩放到封面框里正好铺满。
  const CVW = 1280;
  const CVH = 800;
  const CMAX = 3;      // 并发闸门：同时最多载入 3 张，其余排队
  const CDWELL = 400;  // 进视口停留 400ms 才排队，快速滚过的卡片不浪费流量
  const CTIMEOUT = 6000;

  let cbusy = 0;
  const cqueue = [];

  function cpump() {
    while (cbusy < CMAX && cqueue.length) cqueue.shift()();
  }

  /** 把 iframe 按容器尺寸等比缩放并居中（容器比例不是 16:10 时留白，不裁切）。 */
  function cfit(frame, box) {
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return false;
    const s = Math.min(w / CVW, h / CVH);
    frame.style.width = CVW + 'px';
    frame.style.height = CVH + 'px';
    frame.style.left = ((w - CVW * s) / 2) + 'px';
    frame.style.top = ((h - CVH * s) / 2) + 'px';
    frame.style.transform = 'scale(' + s + ')';
    return true;
  }

  /**
   * 给一个封面框挂上站点实时首屏。
   * @param {HTMLElement} box 需要有确定尺寸（CSS aspect-ratio 保证）
   * @param {string} url 站点入口地址，函数自己补 ?mpcover=1
   */
  MP.liveCover = function (box, url) {
    if (!box || !url) return;
    box.textContent = '';
    box.classList.add('liveCover');

    let armed = false;
    let released = false;
    let dwell = null;
    let frame = null;

    const release = () => {
      if (released) return;
      released = true;
      cbusy = Math.max(0, cbusy - 1);
      cpump();
    };

    const arm = () => {
      if (armed || !box.isConnected || !box.clientWidth) return;
      armed = true;
      cbusy += 1;

      frame = document.createElement('iframe');
      frame.className = 'liveFrame';
      frame.referrerPolicy = 'no-referrer';
      // 只给脚本不给同源：站点 JS 照常跑，但摸不到父页面与 cookie
      frame.sandbox = 'allow-scripts';
      frame.setAttribute('scrolling', 'no');
      cfit(frame, box);

      frame.addEventListener('load', () => {
        frame.classList.add('on');
        release();
      }, { once: true });
      // 首屏通常很快画出来，不必等整站（含首屏外资源）下完才露脸
      setTimeout(() => { if (frame) frame.classList.add('on'); }, 900);
      setTimeout(release, CTIMEOUT);

      box.appendChild(frame);
      frame.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'mpcover=1';

      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => { if (frame) cfit(frame, box); }).observe(box);
      }
    };

    const enqueue = () => { cqueue.push(arm); cpump(); };

    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            if (!dwell) dwell = setTimeout(() => { io.disconnect(); enqueue(); }, CDWELL);
          } else if (dwell) {
            clearTimeout(dwell);
            dwell = null;
          }
        });
      }, { threshold: 0.02 });
      io.observe(box);
    } else {
      enqueue();
    }
  };

  /**
   * 顶部浮层提示（可带链接）：发布成功时告诉用户地址，同时留在原页面。
   * @param {string} text 提示文案
   * @param {string} [href] 链接地址
   * @param {string} [label] 链接文字，省略时直接显示地址
   * @param {number} [ms] 自动消失毫秒数
   */
  MP.alertLink = function (text, href, label, ms) {
    let host = document.getElementById('mpAlerts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mpAlerts';
      host.className = 'mpAlerts';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'mpAlert';
    el.innerHTML = '<span class="aText"></span>'
      + '<a class="aLink" target="_blank" rel="noopener"></a>'
      + '<button type="button" class="aX" aria-label="关闭">×</button>';
    el.querySelector('.aText').textContent = text;
    const a = el.querySelector('.aLink');
    if (href) {
      a.href = href;
      a.textContent = label || href;
    } else {
      a.remove();
    }
    el.querySelector('.aX').addEventListener('click', () => el.remove());
    host.appendChild(el);
    setTimeout(() => el.remove(), ms || 9000);
  };

  /* ----------------------------------------------------------
     2. 通用小弹窗：ask（选择题）/ alert（只有确定）
     ---------------------------------------------------------- */

  /**
   * 弹一个只有几个按钮的小确认框。
   * @param {{text:string, buttons:{key:string,label:string,primary?:boolean,ghost?:boolean}[], mask?:boolean}} opt
   * @returns {Promise<string|null>} 选中的 key；点遮罩或按 Esc 返回 null
   */
  MP.ask = function (opt) {
    const o = opt || {};
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'askMask';
      const card = document.createElement('div');
      card.className = 'askCard';
      card.innerHTML = '<div class="askText"></div><div class="askBtns"></div>';
      card.querySelector('.askText').textContent = o.text || '';

      const done = (key) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(key); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };

      (o.buttons || [{ key: 'ok', label: '知道了', primary: true }]).forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = b.primary ? 'askBtn primary' : (b.ghost === false ? 'askBtn' : 'askBtn ghost');
        btn.textContent = b.label;
        btn.addEventListener('click', () => done(b.key));
        card.querySelector('.askBtns').appendChild(btn);
      });

      mask.appendChild(card);
      mask.addEventListener('click', (e) => { if (e.target === mask) done(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(mask);
      const primary = card.querySelector('.askBtn.primary');
      if (primary) primary.focus();
    });
  };

  MP.alert = function (text) {
    return MP.ask({ text });
  };

  /**
   * 单行输入小弹窗（改名字这类场景）。
   * @param {{text:string, value?:string, placeholder?:string, okLabel?:string}} opt
   * @returns {Promise<string|null>} 输入的值；取消 / Esc / 点遮罩返回 null
   */
  MP.prompt = function (opt) {
    const o = opt || {};
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'askMask';
      const card = document.createElement('div');
      card.className = 'askCard';
      card.innerHTML = '<div class="askText"></div>'
        + '<input class="askInput" type="text" autocomplete="off" spellcheck="false">'
        + '<div class="askBtns"></div>';
      card.querySelector('.askText').textContent = o.text || '';

      const field = card.querySelector('.askInput');
      field.value = o.value ?? '';
      if (o.placeholder) field.placeholder = o.placeholder;

      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        mask.remove();
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') done(null);
        if (e.key === 'Enter') { e.preventDefault(); done(field.value); }
      };

      [{ key: 'cancel', label: '取消', primary: false },
        { key: 'ok', label: o.okLabel || '确定', primary: true }].forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = b.primary ? 'askBtn primary' : 'askBtn ghost';
        btn.textContent = b.label;
        btn.addEventListener('click', () => done(b.primary ? field.value : null));
        card.querySelector('.askBtns').appendChild(btn);
      });

      mask.appendChild(card);
      mask.addEventListener('click', (e) => { if (e.target === mask) done(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(mask);
      field.focus();
      field.select();
    });
  };

  /**
   * 选项列表小弹窗（单选）。用来做「选模型」这类有几个固定选项的场景。
   * @param {{text:string, options:{value:string,label:string,hint?:string,active?:boolean}[]}} opt
   * @returns {Promise<string|null>} 选中的 value；取消 / Esc / 点遮罩返回 null
   */
  MP.pick = function (opt) {
    const o = opt || {};
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'askMask';
      const card = document.createElement('div');
      card.className = 'askCard pickCard';
      card.innerHTML = '<div class="askText"></div><div class="pickList"></div><div class="askBtns"></div>';
      card.querySelector('.askText').textContent = o.text || '';

      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        mask.remove();
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };

      (o.options || []).forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pickItem' + (item.active ? ' on' : '');
        btn.innerHTML = '<b></b><span></span>';
        btn.querySelector('b').textContent = item.label;
        const hint = btn.querySelector('span');
        if (item.hint) hint.textContent = item.hint;
        else hint.remove();
        btn.addEventListener('click', () => done(item.value));
        card.querySelector('.pickList').appendChild(btn);
      });

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'askBtn ghost';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => done(null));
      card.querySelector('.askBtns').appendChild(cancel);

      mask.appendChild(card);
      mask.addEventListener('click', (e) => { if (e.target === mask) done(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(mask);
    });
  };

  /* ----------------------------------------------------------
     3. 发布弹窗
     ---------------------------------------------------------- */

  // 与后端 lib/names.js 同口径：3–32 位小写字母 / 数字 / 连字符，
  // 首尾不能是连字符。地址必须手动填写，不再自动生成 —— 中文标题转不出
  // 有意义的英文地址，硬转只会得到一串乱七八糟的字母数字。
  const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

  /**
   * 发布弹窗：中间草稿实时首屏 + 标题 / 自定义地址两个字段 + 底部四个动作。
   * 发布成功不跳转，只在顶部提示地址，然后关掉弹窗留在原页面。
   *
   * @param {object} opt
   *   username  当前用户名（地址前缀）
   *   draft     草稿站 {name,title,description,tag}
   *   onPublished(payload) 发布成功回调（创作页用来刷新草稿卡片）
   *   onClosed()         弹窗关闭回调
   */
  MP.publishDialog = function (opt) {
    const o = opt || {};
    const draft = o.draft || {};
    const username = o.username || '';
    if (!draft.name || !username) return null;

    const coverUrl = '/qwq/' + enc(username) + '/' + enc(draft.name) + '/';
    const startTitle = draft.title || '';
    const startName = '';

    const mask = document.createElement('div');
    mask.className = 'modal-mask pubMask';
    const card = document.createElement('div');
    card.className = 'modal pubModal';
    card.innerHTML = ''
      + '<button type="button" class="modal-x" aria-label="关闭">×</button>'
      + '<h2 class="modal-title">发布页面</h2>'
      + '<div class="pubCover" aria-label="站点预览"></div>'
      + '<div class="pubFields">'
      +   '<label class="field">'
      +     '<span class="label">页面名字</span>'
      +     '<input class="pubTitle" type="text" autocomplete="off" spellcheck="false" placeholder="给页面起个名字">'
      +   '</label>'
      +   '<div class="field">'
      +     '<span class="label">自定义地址<span class="req">*</span></span>'
      +     '<div class="slug"><span class="prefix"></span>'
      +       '<input class="pubName" type="text" autocomplete="off" spellcheck="false" maxlength="32" placeholder="必填，如 my-page">'
      +     '</div>'
      +     '<span class="hint">必填。只接受小写字母、数字和连字符，3–32 位，首尾不能是连字符</span>'
      +   '</div>'
      + '</div>'
      + '<div class="pubErr" hidden></div>'
      + '<div class="pubConfirm" hidden>'
      +   '<p>发布后只能在个人主页「作品」里管理这个页面。确定现在发布吗？</p>'
      +   '<div class="pubConfirmBtns"><button type="button" class="ghost" data-act="cancel">取消</button>'
      +     '<button type="button" class="go" data-act="confirm">确定发布</button></div>'
      + '</div>'
      + '<div class="pubFoot">'
      +   '<button type="button" class="pubGo">发布</button>'
      +   '<button type="button" class="ghost" data-act="save">保存草稿</button>'
      +   '<button type="button" class="ghost" data-act="ai">AI 帮我改</button>'
      +   '<button type="button" class="ghost" data-act="preview">预览</button>'
      + '</div>';

    const titleEl = card.querySelector('.pubTitle');
    const nameEl = card.querySelector('.pubName');
    const errEl = card.querySelector('.pubErr');
    const confirmEl = card.querySelector('.pubConfirm');
    const goBtn = card.querySelector('.pubGo');
    card.querySelector('.slug .prefix').textContent = '/qwq/' + username + '/';
    titleEl.value = startTitle;
    nameEl.value = startName;

    let busy = false;
    let closed = false;

    /** 关窗（含未保存改动询问）。 */
    const close = async (force) => {
      if (closed) return;
      if (!force && (titleEl.value.trim() !== startTitle || nameEl.value.trim() !== startName)) {
        const choice = await MP.ask({
          text: '有没保存的改动，要保存成草稿吗？',
          buttons: [
            { key: 'save', label: '保存草稿', primary: true },
            { key: 'drop', label: '不保存' },
            { key: 'cancel', label: '取消' },
          ],
        });
        if (choice === 'cancel' || choice === null) return;
        if (choice === 'save') {
          if (!await saveDraft(true)) return;
        }
      }
      closed = true;
      mask.remove();
      if (o.onClosed) o.onClosed();
    };

    const error = (msg) => {
      errEl.hidden = false;
      errEl.textContent = msg;
    };
    const clearError = () => { errEl.hidden = true; errEl.textContent = ''; };

    /** 保存标题回草稿（站名不可改，地址只在发布时生效）。 */
    async function saveDraft(quiet) {
      if (busy) return false;
      busy = true;
      try {
        await MP.api(MP.siteApiOf(username, draft.name, '/meta'), {
          method: 'PUT',
          body: {
            title: titleEl.value.trim(),
            description: draft.description || '',
            tag: draft.tag || '',
          },
        });
        draft.title = titleEl.value.trim();
        if (!quiet) MP.toast('已保存草稿');
        return true;
      } catch (err) {
        if (!quiet) error(err.message || '保存失败');
        return false;
      } finally {
        busy = false;
      }
    }

    /** 发布：校验 → 二次确认 → 提交。 */
    async function doPublish() {
      if (busy) return;
      clearError();
      const title = titleEl.value.trim();
      if (!title) {
        error('标题没写');
        titleEl.focus();
        return;
      }
      // 地址改成必填：中文标题自动生成会得到一串没意义的字母数字，
      // 与其替用户猜，不如让他自己定一个记得住的地址。
      const name = nameEl.value.trim().toLowerCase();
      if (!name) {
        error('地址不能为空，自己起一个吧（比如 my-page）');
        nameEl.focus();
        return;
      }
      if (!NAME_RE.test(name)) {
        error('地址只能用小写字母、数字和连字符，3–32 位，首尾不能是连字符');
        nameEl.focus();
        return;
      }
      confirmEl.hidden = false;
      confirmEl.dataset.name = name;
      confirmEl.dataset.title = title;
    }

    async function reallyPublish() {
      const name = confirmEl.dataset.name;
      const title = confirmEl.dataset.title;
      confirmEl.hidden = true;
      busy = true;
      goBtn.disabled = true;
      goBtn.textContent = '发布中…';
      try {
        const data = await MP.api(MP.siteApiOf(username, draft.name, '/publish'), {
          method: 'POST',
          body: { name, title, description: draft.description || '', tag: draft.tag || '' },
        });
        const url = (data.site && (data.site.url || data.site.viewUrl)) || '';
        closed = true;
        mask.remove();
        MP.alertLink('发布成功，页面已上线', url, url);
        if (o.onPublished) o.onPublished(data.site || {});
        if (o.onClosed) o.onClosed();
      } catch (err) {
        const msg = err.message || '发布失败';
        error(msg);
        if (msg.includes('地址') || msg.includes('名字') || msg.includes('站名')) nameEl.focus();
      } finally {
        busy = false;
        goBtn.disabled = false;
        goBtn.textContent = '发布';
      }
    }

    /* ---- 事件 ---- */
    card.querySelector('.modal-x').addEventListener('click', () => close(false));

    goBtn.addEventListener('click', doPublish);

    card.querySelector('[data-act="confirm"]').addEventListener('click', reallyPublish);
    card.querySelector('[data-act="cancel"]').addEventListener('click', () => { confirmEl.hidden = true; });

    card.querySelector('[data-act="save"]').addEventListener('click', async () => {
      if (await saveDraft(false)) close(true);
    });

    card.querySelector('[data-act="ai"]').addEventListener('click', () => {
      location.href = '/workspace/' + enc(draft.name);
    });

    card.querySelector('[data-act="preview"]').addEventListener('click', () => {
      window.open(coverUrl, '_blank', 'noopener');
    });

    // Enter 直接走发布；地址框里回车同理
    [titleEl, nameEl].forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doPublish(); }
      });
      el.addEventListener('input', clearError);
    });

    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key !== 'Escape') return;
      document.removeEventListener('keydown', onEsc);
      if (confirmEl.hidden) close(false);
      else confirmEl.hidden = true;
    });

    mask.appendChild(card);
    document.body.appendChild(mask);
    MP.liveCover(card.querySelector('.pubCover'), coverUrl);
    titleEl.focus();
    titleEl.select();

    return {
      close: () => close(true),
    };
  };

  /* ----------------------------------------------------------
     4. 对话栏
     ---------------------------------------------------------- */

  // 附件图片的取图地址。由工作区注入（它知道 username/name），
  // 这里不写死路由，避免 studio.js 依赖站点上下文。
  MP.attachmentUrl = null;

  /** 一条消息气泡（返回 DOM，调用方自己 append）。
   *  带图片时气泡里额外挂一行缩略图（点开看大图）。 */
  MP.bubble = function (role, content, pending, attachments) {
    const row = document.createElement('div');
    row.className = 'chatRow ' + (role === 'user' ? 'me' : 'agent') + (pending ? ' pending' : '');

    const b = document.createElement('div');
    b.className = 'chatBubble';
    b.textContent = content;
    row.appendChild(b);

    if (Array.isArray(attachments) && attachments.length) {
      const strip = document.createElement('div');
      strip.className = 'chatImgs';
      attachments.forEach((a) => {
        const img = document.createElement('img');
        img.className = 'chatImg';
        img.loading = 'lazy';
        img.src = a.url;
        img.alt = '图片';
        img.title = '点击看大图';
        img.addEventListener('click', () => MP.viewImage(a.url));
        strip.appendChild(img);
      });
      row.appendChild(strip);

      // 纯图片消息：气泡本身是空的，别留一个空壳占位
      if (!String(content || '').trim()) b.remove();
    }

    return row;
  };

  /** 点缩略图看大图（居中浮层，点任意处关掉）。 */
  MP.viewImage = function (url) {
    const mask = document.createElement('div');
    mask.className = 'imgMask';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '图片';
    mask.appendChild(img);
    const close = () => mask.remove();
    mask.addEventListener('click', close);
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
    document.body.appendChild(mask);
  };

  /** 用一串服务端消息重绘对话流。 */
  MP.renderMessages = function (list, messages, emptyText) {
    list.textContent = '';
    if (!messages || !messages.length) {
      if (emptyText) {
        const el = document.createElement('div');
        el.className = 'chatEmpty';
        el.textContent = emptyText;
        list.appendChild(el);
      }
      return;
    }
    messages.forEach((m) => {
      // 服务端只给元信息（id/mime/size），真正取图走 GET /attachments/:id
      const imgs = Array.isArray(m.attachments) && m.attachments.length && MP.attachmentUrl
        ? m.attachments.map((a) => ({ url: MP.attachmentUrl(a.id) }))
        : null;
      list.appendChild(MP.bubble(m.role, m.content, false, imgs));
    });
    list.scrollTop = list.scrollHeight;
  };

  /** textarea 跟着内容长高（上限由 CSS max-height 兜住）。 */
  MP.autoGrow = function (el) {
    const grow = () => {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    };
    el.addEventListener('input', grow);
    grow();
    return grow;
  };

  /* ----------------------------------------------------------
     5. 发送一条消息：异步任务 + 轮询进度
     ---------------------------------------------------------- */

  // 工具名 → 给用户看的动作短语。技术词对用户没意义，翻译成人话。
  const STEP_LABELS = {
    list_files: '看看有哪些文件',
    read_file: '读文件',
    write_file: '改文件',
    delete_file: '删文件',
    update_meta: '改页面信息',
  };

  /** 把一步工具调用渲染成一行进度文案。 */
  function stepText(step) {
    const label = STEP_LABELS[step.name] ?? step.name;
    const tail = step.path ? ` ${step.path}` : '';
    return step.ok === false ? `${label}${tail} 失败` : `${label}${tail}`;
  }

  /**
   * 轮询一个任务直到结束。返回任务对象；失败抛错。
   *
   * interval 默认 300ms：服务端每 250ms 落一次流式文本，
   * 轮询太慢会让「逐字出现」变成「一段一段跳」，看起来反而更卡。
   * 300ms 一个轻量 GET，对本地/内网完全不是负担。
   */
  async function waitTask(taskId, { onProgress, interval = 300, timeoutMs = 150000 } = {}) {
    const startedAt = Date.now();
    for (;;) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('等太久了，刷新页面看看进度');
      }
      await new Promise((r) => setTimeout(r, interval));

      let task;
      try {
        const data = await MP.api('/api/agent/tasks/' + encodeURIComponent(taskId));
        task = data.task;
      } catch (err) {
        // 任务过期（24 小时后清掉）就别再轮询了
        if (err.status === 404) throw new Error('这个任务已经过期了，刷新页面看看结果');
        throw err;
      }

      if (onProgress) onProgress(task);
      if (task.status === 'done') return task;
      if (task.status === 'cancelled') {
        throw Object.assign(new Error(task.text || '已停止'), { task });
      }
      if (task.status === 'failed') throw Object.assign(new Error(task.error || '生成失败'), { task });
    }
  }

  /**
   * 取消一个正在跑的任务。
   * 只置信号，真正收尾（存快照、写回复、改状态）由服务端在循环跳出后做，
   * 所以这里成功返回不代表已经停了，还得继续轮询等 status 变。
   * @returns {Promise<'cancelling'|'cancelled'>}
   */
  MP.cancelTask = async function (taskId) {
    const data = await MP.api('/api/agent/tasks/' + encodeURIComponent(taskId) + '/cancel', {
      method: 'POST',
      body: {},
    });
    return data.status === 'cancelled' ? 'cancelled' : 'cancelling';
  };

  /**
   * 往工作区发一条消息：
   *   1. 乐观插入用户气泡
   *   2. POST 拿到 taskId（服务端立刻返回，不在请求里等 agent）
   *   3. 轮询任务，实时把「正在读 xxx」写进一个进度气泡
   *   4. 任务完成 → 进度气泡换成最终回复；失败 → 标红并给原因
   *
   * @param {object} opt
   *   list       消息容器
   *   username / name / content / threadId
   *   attachIds  附件 id 数组（已上传的图片）
   *   onProgress(task) 每次轮询回调
   *   onStarted(data)  拿到 taskId 后回调（返回 { cancel } 让调用方接停止按钮）
   *   onReply(task)    完成回调
   */
  MP.pushMessage = async function (opt) {
    const { list, username, name, content, threadId } = opt;
    const attachIds = Array.isArray(opt.attachIds) ? opt.attachIds : [];

    // 乐观气泡直接带上本地预览图，用户立刻能看到自己贴了什么；
    // 发送成功后由 clearImages 释放 blob，历史消息走服务端的图。
    const previews = attachIds.length && MP.attachmentUrl
      ? attachIds.map((id) => ({ url: MP.attachmentUrl(id) }))
      : null;
    const mine = MP.bubble('user', content, true, previews);
    if (list) {
      const empty = list.querySelector('.chatEmpty');
      if (empty) empty.remove();
      list.appendChild(mine);
      list.scrollTop = list.scrollHeight;
    }

    // 进度气泡：先显示「正在想…」，随后被工具进度替换
    const progressRow = MP.bubble('agent', '正在想…', true);
    const progressBubble = progressRow.querySelector('.chatBubble');
    progressBubble.classList.add('stepping');
    if (list) {
      list.appendChild(progressRow);
      list.scrollTop = list.scrollHeight;
    }

    let taskId = null;
    /** 用户点过停止以后，把最终气泡的样式换成「已停止」而不是普通回复 */
    let stopped = false;

    try {
      const data = await MP.sendSiteMessage(username, name, content, threadId, attachIds);
      mine.classList.remove('pending');
      taskId = data.taskId;

      if (opt.onStarted) {
        // 把「停止」能力交给调用方（工作区会把它绑到发送按钮上）
        opt.onStarted(data, {
          cancel: async () => {
            if (!taskId || stopped) return;
            stopped = true;
            progressBubble.textContent = '正在停止…';
            try {
              await MP.cancelTask(taskId);
            } catch (err) {
              stopped = false;
              progressBubble.textContent = err.message || '停止失败';
            }
          },
        });
      }

      const task = await waitTask(taskId, {
        onProgress: (t) => {
          if (stopped) return;   // 正在停，别让进度把「正在停止…」覆盖掉

          // 流式：task.text 是服务端边生成边写的半成品。
          // 有文字就优先显示文字（比「正在想…」有信息量），
          // 没文字时才退回工具进度 —— 工具执行期间本来就没有文字可显示。
          const hasText = Boolean(t.text && t.text.trim());
          if (hasText && (t.status === 'running' || t.status === 'queued')) {
            progressBubble.textContent = t.text;
            progressBubble.classList.add('streaming');
          } else {
            const steps = Array.isArray(t.steps) ? t.steps : [];
            if (steps.length) {
              const last = steps[steps.length - 1];
              progressBubble.textContent = stepText(last);
              progressBubble.classList.remove('streaming');
            }
          }

          if (list) list.scrollTop = list.scrollHeight;
          if (opt.onProgress) opt.onProgress(t);
        },
      });

      // 任务完成：把进度气泡换成真正的回复
      progressRow.classList.remove('pending');
      progressBubble.classList.remove('stepping');
      progressBubble.classList.remove('streaming');
      progressBubble.textContent = task.text || '（没有输出）';
      // 被停止的任务单独标一下，用户一眼能看出「这轮是我停的」
      if (task.status === 'cancelled') {
        progressBubble.classList.add('stopped');
        stopped = true;
      }
      if (list) list.scrollTop = list.scrollHeight;

      if (opt.onReply) opt.onReply(task);
      return task;
    } catch (err) {
      mine.classList.remove('pending');
      progressRow.classList.remove('pending');
      progressBubble.classList.remove('stepping');
      progressRow.classList.add('failed');
      // 用户主动停止也被 waitTask 当成异常抛出（status=cancelled），
      // 但这不是错误，别标红吓人 —— 服务端已经在 project.text 里给了人话。
      if (err.task && err.task.status === 'cancelled') {
        progressBubble.classList.add('stopped');
        progressBubble.textContent = err.task.text || '已停止';
        if (list) list.scrollTop = list.scrollHeight;
        if (opt.onReply) opt.onReply(err.task);
        return err.task;
      }
      progressBubble.classList.add('errtip');
      progressBubble.textContent = err.message || '发送失败';
      throw err;
    }
  };
})();
