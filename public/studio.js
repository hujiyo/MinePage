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
  /**
   * 渲染一整个对话。
   *
   * **数据来源变了（2026-11）**：以前是「消息从检查点来、面板从 agent_tasks 来，
   * 两套数据靠回复正文内容硬匹配」。现在任务行自带 userText / text / view，
   * 一个任务 = 一整组 UI（用户气泡 + 过程面板 + 回复气泡），
   * **不再需要任何跨表配对** —— 这是「中断后刷新面板消失」那类问题的根治方案。
   *
   * @param {HTMLElement} list 容器
   * @param {Array} messages 检查点历史（老会话兜底用；新会话忽略）
   * @param {string} [emptyText] 空态文案
   * @param {Array} [tasks] 这个会话的任务数组（自带 userText / text / view / attachments）
   */
  MP.renderMessages = function (list, messages, emptyText, tasks) {
    list.textContent = '';

    const taskList = Array.isArray(tasks) ? tasks : [];
    // 有任务就按任务渲染（自足，无配对）；一个任务都没有才退回检查点消息
    const fromTasks = taskList.length > 0;
    const source = fromTasks ? taskList : (Array.isArray(messages) ? messages : []);

    if (!source.length) {
      if (emptyText) {
        const el = document.createElement('div');
        el.className = 'chatEmpty';
        el.textContent = emptyText;
        list.appendChild(el);
      }
      return;
    }

    if (fromTasks) {
      for (const task of taskList) {
        // ① 用户气泡：老任务没存 userText（null），跳过而不是画一个空的
        if (task.userText != null) {
          const urls = (task.attachments ?? [])
            .filter(() => MP.attachmentUrl)
            .map((a) => ({ url: MP.attachmentUrl(a.id) }));
          const mine = MP.bubble('user', task.userText, false, urls.length ? urls : null);
          list.appendChild(mine);
        }

        // ② + ③ 面板和回复气泡放进同一个 .chatRow agent。
        //
        // **正文不重复渲染**（2026-11 修）：面板里的 wsFlowPara 已经是正文了
        //（按模型输出顺序铺开，且已把被切碎的句子归并过），
        // 下面再挂一个完整气泡就是同一段话读两遍。
        // 所以只有「没有面板」时才单独渲染气泡。
        const text = String(task.text ?? '').trim();
        const errText = task.status === 'failed' ? String(task.error ?? '').trim() : '';
        const bodyText = text || errText;

        const trace = MP.buildTraceFromTask(task);
        if (!trace && !bodyText) continue;

        const row = document.createElement('div');
        row.className = 'chatRow agent';

        if (trace) {
          row.appendChild(trace);
        }

        if (bodyText && !trace) {
          const bubble = document.createElement('div');
          bubble.className = 'chatBubble';
          bubble.textContent = bodyText;
          if (task.status === 'cancelled') bubble.classList.add('stopped');
          else if (task.status === 'failed') bubble.classList.add('errtip');
          row.appendChild(bubble);
        }

        list.appendChild(row);
      }

      list.scrollTop = list.scrollHeight;
      return;
    }

    // ---- 兜底：这个会话一条任务都没有（纯老的 site_messages 时代数据）----
    messages.forEach((m) => {
      const imgs = Array.isArray(m.attachments) && m.attachments.length && MP.attachmentUrl
        ? m.attachments.map((a) => ({ url: MP.attachmentUrl(a.id) }))
        : null;
      list.appendChild(MP.bubble(m.role, m.content, false, imgs));
    });

    list.scrollTop = list.scrollHeight;
  };

  /**
   * 从一个已完成的任务对象重建「执行过程」面板（刷新页面后用）。
   *
   * **和实时渲染共用 renderTraceView()** —— 这是这次改造的关键。
   * 以前这里是另一套手写 DOM（按事件的 step 字段分组、自己拼工具行），
   * 和实时的 renderBody 对不上，所以刷新后轮次/图标/顺序总会变。
   *
   * 现在两边拿到的是同一种结构：后端 deriveTrace() 算好的 task.view。
   * 数据相同 → 视图必然相同。
   *
   * @returns {HTMLElement|null} 没有过程记录就返回 null（不占地方）
   */
  /**
   * 从任务重建「执行过程」（刷新页面后用）。
   *
   * **结构是「单容器按顺序平铺」**（2026-11 改）：
   *
   *   已完成 · 3 步操作 · 改了 1 处      29.3s   ▸   ← 摘要行（点它折叠/展开注记）
   *   ─────────────────────────────────────────────
   *   读完了，是个空白草稿。我把它换成…              ← 正文（永远可见）
   *     💭 思考过程（1200 字）                        ← 注记（折叠态隐藏）
   *     ⚙ 改了 index.html  289ms                     ← 注记
   *   改好了，整站现在是一个…                        ← 正文
   *
   * 为什么是**单容器**而不是「正文一栏 + 注记一栏」：
   *   分两栏的话，渲染时把 blocks 按 kind 拆开，**顺序信息就丢了** ——
   *   界面上会变成「所有正文挤在上面、所有工具挤在下面」，
   *   而模型实际的输出是「说一句 → 做一件事 → 再说一句」交替的。
   *   现在按 blocks 原样平铺，折叠只靠 CSS 把 `.wsFlowNote` 藏起来，
   *   正文顺序和注记位置都和模型输出一一对应。
   *
   * 折叠/展开**只影响注记**，正文永远可见。
   *
   * @returns {HTMLElement|null} 没有过程记录就返回 null（不占地方）
   */
  MP.buildTraceFromTask = function (task) {
    const view = task?.view;
    const turns = Array.isArray(view?.turns) ? view.turns : [];
    const hasContent = turns.some((t) => (t.steps ?? []).some(
      (s) => s.reasoning || (s.tools ?? []).length || (s.retries ?? []).length,
    ));

    // 完全没有过程可看：**不画面板**。
    //
    // 另一种情况也会走到这里：任务在模型吐出任何东西之前就被停止了（0 步、0 思考）。
    // 那是个**新任务**，面板本身没有信息量，回复气泡已经把状态说清楚了。
    if (!hasContent) return null;

    const status = task?.status ?? 'done';

    const box = document.createElement('div');
    box.className = 'wsTrace done';
    if (status === 'failed') box.classList.add('failed');
    if (status === 'cancelled') box.classList.add('cancelled');

    // ---- 摘要行：一行淡色小字，不占主体（A 方案的总开关）----
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'wsTraceHead';
    head.setAttribute('aria-expanded', 'false');

    const caret = document.createElement('span');
    caret.className = 'wsTraceCaret';
    caret.textContent = '▸';
    head.appendChild(caret);

    // 摘要统一交给 traceHeadText() —— 实时和历史必须用同一个函数
    const now = document.createElement('span');
    now.className = 'wsTraceNow';
    now.textContent = traceHeadText(view) || '已完成';
    head.appendChild(now);

    if (view?.totals?.ms > 0) {
      const dur = document.createElement('span');
      dur.className = 'wsTraceTime';
      dur.textContent = fmtMs(view.totals.ms);
      head.appendChild(dur);
    }
    box.appendChild(head);

    // ---- 主体：一个容器，按 blocks 顺序平铺 ----
    const body = document.createElement('div');
    body.className = 'wsTraceBody wsTraceFlow';
    box.appendChild(body);

    let hasAnyNote = false;

    for (const turn of turns) {
      const blocks = Array.isArray(turn.blocks) ? turn.blocks : [];

      for (const b of blocks) {
        if (b.kind === 'text') {
          // 正文：直接铺开
          const p = document.createElement('div');
          p.className = 'wsFlowPara';
          p.textContent = String(b.text ?? '');
          body.appendChild(p);
        } else if (b.kind === 'reasoning') {
          body.appendChild(buildFlowNote('reason', `思考过程（${String(b.text ?? '').length} 字）`, String(b.text ?? '')));
          hasAnyNote = true;
        } else if (b.kind === 'tool') {
          body.appendChild(buildFlowNote('tool', toolLabel(b.tool), '', b.tool));
          hasAnyNote = true;
        } else if (b.kind === 'retry') {
          body.appendChild(buildFlowNote('retry', '重试模型请求', ''));
          hasAnyNote = true;
        }
      }

      // 这里原本会追加两行「⌗ 已读取 N 个文件 / 已修改 N 个文件」的汇总。
      // 已删除（2026-11，用户选定方案 A）：
      //   它们是 collectRoundFiles() 从工具调用里**统计出来的派生数据**，
      //   模型的输出里根本没有这两行。留在末尾会破坏「正文最后一行 = 模型原话」
      //   这个规则，看起来像模型在结尾又调用了工具。
      //   「改了哪个文件」在 ⚙ 工具行里已经能看到，汇总纯属冗余。
    }

    // 总开关：折叠/展开注记（正文不受影响）
    head.addEventListener('click', () => {
      const open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // 没有正文也没有注记：整个不渲染
    if (!body.childNodes.length) return null;
    // 只有正文、没有任何注记时不显示折叠开关（点了也没变化）
    if (!hasAnyNote) head.classList.add('no-notes');
    return box;
  };

  /**
   * 一条「注记」：默认收起成一行，点开看内容。
   *
   * 三种 kind 共用一套结构，只换图标和配色：
   *   reason —— 思考正文（淡色斜体）
   *   tool   —— 工具调用（等宽小字）
   *   retry  —— 重试记录
   */
  function buildFlowNote(kind, summary, detail, tool) {
    const wrap = document.createElement('div');
    wrap.className = 'wsFlowNote is-' + kind;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wsFlowNoteHead';

    const icon = document.createElement('span');
    icon.className = 'wsFlowNoteIcon';
    icon.textContent = kind === 'reason' ? '💭' : kind === 'retry' ? '↻' : '⚙';
    btn.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'wsFlowNoteText';
    text.textContent = summary;
    btn.appendChild(text);

    if (tool && Number.isFinite(tool.ms) && tool.ms > 0) {
      const ms = document.createElement('span');
      ms.className = 'wsTraceMs';
      ms.textContent = fmtMs(tool.ms);
      btn.appendChild(ms);
    }
    wrap.appendChild(btn);

    // 有细节才给可展开的 body（工具行通常只有摘要，不需要展开）
    if (detail) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'wsFlowNoteBody';
      bodyEl.textContent = detail;
      wrap.appendChild(bodyEl);

      btn.addEventListener('click', () => {
        wrap.classList.toggle('open');
      });
    } else {
      btn.classList.add('static');
    }

    return wrap;
  }


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
     4.5 上拉面板（模型 / 模式选择）
     ----------------------------------------------------------
     工作区和新建对话页都要用，所以放这里共用一份。
     自己画而不用 <select>：原生 select 没法显示副标题、没法做主题样式。
     ---------------------------------------------------------- */

  // 当前打开的面板；同一时间只允许一个
  let sheetEl = null;
  // 面板刚滚过之后的短时间内，忽略页面滚动（防滚动链误关）
  let sheetScrollGuardUntil = 0;

  function sheetOnDocClick(e) {
    if (!sheetEl) return;
    if (sheetEl.contains(e.target)) return;

    // 点在「打开它的那个按钮」上时不要在这里关：
    // 捕获阶段会比按钮自己的 click 先跑，这里关了、按钮处理器又立刻重新打开，
    // 结果就是「再点一次同一按钮关不掉」。toggle 交给按钮自己处理。
    const holder = document.getElementById(sheetEl.dataset.for);
    if (holder && (holder === e.target || holder.contains(e.target))) return;

    MP.closeSheet();
  }

  function sheetOnDocKey(e) {
    if (e.key === 'Escape') MP.closeSheet();
  }

  /**
   * 页面滚动时收起面板（它用 fixed 定位，页面一滚就贴不住）。
   * 但**面板自己内部的滚动不算**：拖滑条、滚轮翻选项都会产生 scroll 事件，
   * 一律关闭的话就会「一滚鼠标菜单就消失」。
   */
  function sheetOnDocScroll(e) {
    if (!sheetEl) return;
    if (e.target === sheetEl || sheetEl.contains(e.target)) return;
    if (Date.now() < sheetScrollGuardUntil) return;
    MP.closeSheet();
  }

  /** 关掉当前上拉面板。 */
  MP.closeSheet = function () {
    if (!sheetEl) return;
    sheetEl.remove();
    sheetEl = null;
    document.removeEventListener('click', sheetOnDocClick, true);
    document.removeEventListener('keydown', sheetOnDocKey);
    document.removeEventListener('scroll', sheetOnDocScroll, true);
  };

  /** 当前有没有面板开着（调试 / 测试用）。 */
  MP.sheetOpen = function () {
    return Boolean(sheetEl);
  };

  /**
   * 在某个按钮上方弹一个上拉面板。
   *
   * @param {HTMLElement} anchor 触发按钮（id 用于 toggle 判断）
   * @param {object} opt
   *   items: [{ value, label, hint, active }]
   *   onPick(value)
   *   up: 是否强制往上弹（默认自动判断）
   */
  MP.openListSheet = function (anchor, { items, onPick, up }) {
    // 再点同一个按钮就是收起
    if (sheetEl && sheetEl.dataset.for === anchor.id) {
      MP.closeSheet();
      return;
    }
    MP.closeSheet();

    const sheet = document.createElement('div');
    sheet.className = 'wsSheet';
    sheet.dataset.for = anchor.id;
    sheet.setAttribute('role', 'listbox');

    items.forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';

      // 换成可换行的容器：名字一行、说明一行、短标签跟在名字后面
      row.className = 'pickRow' + (item.active ? ' on' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', item.active ? 'true' : 'false');

      const head = document.createElement('span');
      head.className = 'pickHead';

      const title = document.createElement('b');
      title.textContent = item.label;
      head.appendChild(title);

      // 标签（如「能看图」）：单独一个浅色小胶囊，不抢名字的视觉权重
      (item.tags || []).forEach((text) => {
        const tag = document.createElement('i');
        tag.className = 'pickTag';
        tag.textContent = text;
        head.appendChild(tag);
      });

      if (item.active) {
        const tick = document.createElement('em');
        tick.className = 'pickTick';
        tick.textContent = '✓';
        head.appendChild(tick);
      }
      row.appendChild(head);

      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'pickHint';
        hint.textContent = item.hint;
        row.appendChild(hint);
      }

      row.addEventListener('click', () => {
        MP.closeSheet();
        onPick(item.value);
      });
      sheet.appendChild(row);
    });

    document.body.appendChild(sheet);

    // 定位：优先往上弹（在底部输入区，往上翻才不会挡输入框）
    const r = anchor.getBoundingClientRect();
    const w = sheet.offsetWidth;
    const h = sheet.offsetHeight;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    let top = r.top - h - 6;
    const canUp = top >= 8;
    if (up === false || !canUp) top = r.bottom + 6;   // 上面放不下就翻到下面
    sheet.style.left = Math.round(left) + 'px';
    sheet.style.top = Math.round(top) + 'px';
    if (!canUp && up !== false) sheet.classList.add('below');

    sheetEl = sheet;

    // 面板内部滚动时刷新时间窗，让随后可能发生的「滚动链到页面」不被误判
    sheet.addEventListener('scroll', () => {
      sheetScrollGuardUntil = Date.now() + 260;
    }, { passive: true });

    // 滚轮滚到头时浏览器会把滚动传给页面（滚动链）。
    // 面板开着的时候拦掉，既不让背景页面滚，也不会把面板关掉。
    sheet.addEventListener('wheel', (e) => {
      const atTop = sheet.scrollTop <= 0;
      const atBottom = sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 1;
      const scrollingUp = e.deltaY < 0;
      if ((scrollingUp && atTop) || (!scrollingUp && atBottom)) e.preventDefault();
      sheetScrollGuardUntil = Date.now() + 260;
    }, { passive: false });

    // 用捕获阶段：按钮自己的 click 先跑完再判断，避免刚开就被关掉
    setTimeout(() => {
      document.addEventListener('click', sheetOnDocClick, true);
      document.addEventListener('keydown', sheetOnDocKey);
      document.addEventListener('scroll', sheetOnDocScroll, true);
    }, 0);
  };

  // 窗口尺寸变了，面板位置就失效了
  window.addEventListener('resize', () => MP.closeSheet());

  /* ----------------------------------------------------------
     4.8 图片归一化（浏览器里压缩，服务端零依赖）
     ----------------------------------------------------------
     为什么放在前端：
       - 服务端是零依赖的，没有 sharp；手写缩放器不现实
       - 浏览器天生能解码 / 缩放 / 重编码
       - 顺带省掉 10 倍上传流量和服务器 CPU

     两步：
       ① normalize：长边缩到 2048、JPEG 0.9 —— 通常落到 150–400 KB
       ② project  ：超过 1 MB 就按质量阶梯再压（0.9 → 0.8 → 0.65）

     实测依据（当前网关）：
       - 字节上限 9.6–10 MB，像素几乎不限（48 MP 也能收）
       - 但 8.8 MB 的图要 11.3 秒才回，300 KB 只要 5 秒
     ---------------------------------------------------------- */

  // 与 lib/config.js 的 ATTACH_TARGET_DIMENSION / ATTACH_REQUEST_BYTES 保持一致
  const NORMALIZE_MAX_DIM = 2048;
  const REQUEST_TARGET_BYTES = 1024 * 1024;
  const QUALITY_LADDER = [0.9, 0.8, 0.65];

  /** canvas 对某种类型编码，返回 Blob；不支持就返回 null。 */
  async function encodeCanvas(canvas, type, quality) {
    if (typeof canvas.convertToBlob === 'function') {
      try {
        return await canvas.convertToBlob({ type, quality });
      } catch {
        return null;
      }
    }
    // 老浏览器没有 OffscreenCanvas.convertToBlob，退回普通 canvas
    const el = document.createElement('canvas');
    el.width = canvas.width;
    el.height = canvas.height;
    el.getContext('2d').drawImage(canvas, 0, 0);
    return new Promise((resolve) => {
      el.toBlob((blob) => resolve(blob), type, quality);
    });
  }

  /**
   * 把用户选的图片压到「能看清、又不大」的尺寸。
   *
   * @param {File|Blob} file
   * @param {{maxDim?:number, targetBytes?:number}} [opt]
   * @returns {Promise<{blob: Blob, originalBytes: number, bytes: number, width: number, height: number, changed: boolean}>}
   */
  MP.normalizeImage = async function (file, opt = {}) {
    const maxDim = opt.maxDim ?? NORMALIZE_MAX_DIM;
    const targetBytes = opt.targetBytes ?? REQUEST_TARGET_BYTES;
    const originalBytes = file.size;

    // 解码。失败说明不是浏览器认得的图片（或者文件坏了）
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw Object.assign(new Error('这个图片打不开，换一张试试'), { code: 'DECODE_FAILED' });
    }

    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });

    const ctx = canvas.getContext('2d');
    // 白底：PNG 透明区域转成 JPEG 后默认会变黑，先铺一层白
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    // 小图且本来就小：不折腾，原样返回
    if (scale === 1 && originalBytes <= targetBytes) {
      return { blob: file, originalBytes, bytes: originalBytes, width, height, changed: false };
    }

    // 质量阶梯：先 0.9，不够就 0.8、0.65
    let best = null;
    for (const q of QUALITY_LADDER) {
      const blob = await encodeCanvas(canvas, 'image/jpeg', q);
      if (!blob) break;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= targetBytes) { best = blob; break; }
    }
    if (!best) {
      // 编码全失败（极老的浏览器）：退回原图，让服务端的字节闸去判断
      return { blob: file, originalBytes, bytes: originalBytes, width, height, changed: false };
    }

    // 阶梯跑到底还超重（高细节图会这样）：改成继续缩尺寸。
    // 之前只降质量，一张满屏噪点的 2048×2048 压到 0.65 还有 1.2 MB，
    // 所以得再来一轮「尺寸减半 + 中质量」，最多两轮。
    let finalBlob = best;
    let finalW = width;
    let finalH = height;
    if (finalBlob.size > targetBytes) {
      for (let round = 0; round < 2 && finalBlob.size > targetBytes; round += 1) {
        finalW = Math.max(1, Math.round(finalW / 1.5));
        finalH = Math.max(1, Math.round(finalH / 1.5));
        const small = typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(finalW, finalH)
          : Object.assign(document.createElement('canvas'), { width: finalW, height: finalH });
        const sctx = small.getContext('2d');
        sctx.fillStyle = '#fff';
        sctx.fillRect(0, 0, finalW, finalH);
        sctx.drawImage(canvas, 0, 0, finalW, finalH);
        const blob = await encodeCanvas(small, 'image/jpeg', 0.82);
        if (blob && blob.size < finalBlob.size) finalBlob = blob;
      }
    }

    // 压完反而更大（原图本来就是高压缩 WebP）：那还是用原图
    if (finalBlob.size >= originalBytes && scale === 1) {
      return { blob: file, originalBytes, bytes: originalBytes, width, height, changed: false };
    }

    return {
      blob: finalBlob,
      originalBytes,
      bytes: finalBlob.size,
      width: finalW,
      height: finalH,
      changed: true,
    };
  };

  /** 人类可读的体积。 */
  MP.formatBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };

  /* ----------------------------------------------------------
     5. 发送一条消息：异步任务 + 轮询进度
     ---------------------------------------------------------- */

  /**
   * 轮询一个任务直到结束。返回任务对象；失败抛错。
   *
   * interval 默认 300ms：服务端每 250ms 落一次流式文本，
   * 轮询太慢会让「逐字出现」变成「一段一段跳」，看起来反而更卡。
   * 300ms 一个轻量 GET，对本地/内网完全不是负担。
   *
   * 关于 timeoutMs：**默认不再设总时长上限**。
   * 以前写死 150 秒，结果用户给的任务越详细、agent 跑得越久，前端就越先放弃，
   * 显示「等太久了，刷新页面看看进度」—— 但后端其实还在正常跑。
   * 现在改成「只要任务状态还在变（queued/running）就一直等」，
   * 真正的死亡判定交给后端（空闲超时）和任务表 TTL。
   * 传 timeoutMs > 0 才启用上限（保留给测试用）。
   */
  async function waitTask(taskId, { onProgress, interval = 300, timeoutMs = 0 } = {}) {
    const startedAt = Date.now();
    let lastStatus = '';
    let lastChangeAt = Date.now();

    for (;;) {
      if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
        throw new Error(`等了超过 ${Math.round(timeoutMs / 1000)} 秒还没结束，可以去任务列表看看进度`);
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

      // 状态没变超过 3 分钟就提示一次（不是中断，只是让用户知道还在跑）
      if (task.status !== lastStatus) {
        lastStatus = task.status;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt > 180_000 && onProgress) {
        onProgress({ ...task, staleHint: true });
        lastChangeAt = Date.now();   // 每 3 分钟提醒一次，不要刷屏
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
/* ----------------------------------------------------------
   5.1 执行过程渲染器（trace）
   ----------------------------------------------------------
   参考 Cursor / DSH 的做法：默认折叠，**只显示当前那一步**。
   用户想看细节就点开，能看到完整的时间线（思考 / 调用工具 / 重试 / 说话）。

   之前是「一个会被覆盖的字符串」：跑完就只剩最终回复，过程全丢。
   现在步骤全部留在 DOM 里，折叠起来不占地方。
   ---------------------------------------------------------- */

  /* ----------------------------------------------------------
     5.0 执行过程渲染（唯一实现）

     **实时渲染和刷新后重建必须共用这一段。**

     以前这里有两套独立实现：实时按 llm_start 分组、刷新按事件的 step 字段分组，
     结果刷新后轮次、图标、折叠状态全对不上（用户报的 bug）。
     更糟的是上一轮修复只补了历史侧，留下了 groupTraceEvents / renderTraceItems
     两个「定义了但零调用」的死函数，注释还写着「只保留这一个」—— 名不副实。

     现在结构彻底改了：
       1. 事件 → 视图模型（deriveTrace）挪到**后端** lib/agent/trace.js，纯函数，只有一份；
       2. 前端只负责「把 view 画出来」，也就是下面这一个 renderTraceView()；
       3. 实时（轮询 task.view）和历史（刷新后 task.view）喂的是同一种结构。

     这样「两套实现对不上」不是修好了，而是**这类 bug 不再可能发生**。
     ---------------------------------------------------------- */

  /** 工具的中文动词。和 lib/agent/trace.js 的 verbOf 保持同一口径。 */
  const TOOL_VERB = {
    list_files: '看了看文件列表',
    read_file: '读了',
    write_file: '改了',
    delete_file: '删了',
    update_meta: '改了页面信息',
  };

  /** 一步工具的中文描述。 */
  function toolLabel(t) {
    const verb = TOOL_VERB[t.name] ?? `调用了 ${t.name}`;
    const tail = t.path ? ` ${t.path}` : '';
    return `${verb}${tail}${t.ok === false ? '（失败）' : ''}`;
  }

  function fmtMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}分${s}秒`;
  }

  /**
   * 思考过程行：默认折叠成一行「思考过程（N 字）」，点开铺开正文。
   *
   * 为什么默认不展开（2026-11 定的）：
   *   实测这个项目的一段思考动辄 800–7000 字，全铺开会把后面的工具行
   *   推到好几屏之外 —— 用户最关心的「到底改了什么」反而看不见了。
   *   所以折叠态只留一行，点开才看；**展开后是完整正文**，
   *   和工具行在同一个时间线里交替出现，读起来就是一段流水账。
   *
   * 展开时给 .wsTrace 挂 hasThinkOpen，把面板主体的 320px 上限放开
   * （见 style.css）—— 否则上千像素的正文会被塞进 320px 的滚动框，
   * 看起来还是只有几行，用户会以为没展开。
   *
   * @param {string} text 思考正文
   * @param {boolean} live 是否还在流式输出（此时默认展开，让用户看着它想）
   */
  function buildReasonRow(text, live) {
    const row = document.createElement('div');
    row.className = 'wsTraceItem is-reason';

    const icon = document.createElement('span');
    icon.className = 'wsTraceIcon';
    icon.textContent = '💭';
    row.appendChild(icon);

    const wrap = document.createElement('div');
    wrap.className = 'wsTraceReasonWrap';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'wsTraceReasonToggle';
    toggle.textContent = `思考过程（${text.length} 字）`;
    wrap.appendChild(toggle);

    const box = document.createElement('div');
    box.className = 'wsTraceThink';
    box.textContent = text;
    // 默认折叠；只有流式输出时才展开（那时用户要能看着它想）
    box.hidden = !live;
    wrap.appendChild(box);

    toggle.addEventListener('click', () => {
      box.hidden = !box.hidden;
      toggle.classList.toggle('open', !box.hidden);
      syncReasonOpen(row);
    });
    if (live) toggle.classList.add('open');
    // 流式态默认是展开的，初始化时也要同步一次
    syncReasonOpen(row);

    row.appendChild(wrap);
    return row;
  }

  /**
   * 把「这一个面板里有没有正在展开的思考」同步成 .wsTrace 上的一个类。
   * 有 → 面板主体放开高度上限（CSS 里 .hasThinkOpen .wsTraceBody）。
   */
  function syncReasonOpen(fromEl) {
    const trace = fromEl.closest('.wsTrace');
    if (!trace) return;
    const anyOpen = [...trace.querySelectorAll('.wsTraceThink')].some((el) => !el.hidden);
    trace.classList.toggle('hasThinkOpen', anyOpen);
  }
  /** 重试行。 */
  function buildRetryRow(r) {
    const row = document.createElement('div');
    row.className = 'wsTraceItem is-retry';

    const icon = document.createElement('span');
    icon.className = 'wsTraceIcon';
    icon.textContent = '↻';

    const text = document.createElement('span');
    text.className = 'wsTraceText';
    const code = r.failure?.code ? ` · ${r.failure.code}` : '';
    text.textContent = `重试模型请求（${r.attempt}/${r.maxRetries}）${code}`;

    row.appendChild(icon);
    row.appendChild(text);

    if (r.waitMs) {
      const ms = document.createElement('span');
      ms.className = 'wsTraceMs';
      ms.textContent = `${Math.round(r.waitMs)}ms 后重试`;
      row.appendChild(ms);
    }
    return row;
  }

  /**
   * 「说话」行：模型在这一步对用户说的过渡话。
   *
   * 和思考行的区别：思考是内心戏（斜体淡色、默认折叠），
   * 这句话是**给用户看的**，所以用正常颜色正体、直接铺开不折叠。
   * 它通常很短（"我先看一下…" / "现在改成亮色"），铺开也不会占太多地方。
   */
  function buildSayRow(text) {
    const row = document.createElement('div');
    row.className = 'wsTraceItem is-say';

    const icon = document.createElement('span');
    icon.className = 'wsTraceIcon';
    icon.textContent = '💬';
    row.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'wsTraceSay';
    body.textContent = text;
    row.appendChild(body);

    return row;
  }

  /** 工具行。 */
  function buildToolRow(t) {
    const row = document.createElement('div');
    row.className = 'wsTraceItem ' + (t.ok === false ? 'is-fail' : 'is-tool');

    const icon = document.createElement('span');
    icon.className = 'wsTraceIcon';
    // 还没结束的工具用「进行中」样式，和已经完成的区分开
    if (t.done === false) {
      icon.textContent = '◔';
      row.classList.add('is-pending');
    } else {
      icon.textContent = t.ok === false ? '✕' : '⚙';
    }

    const text = document.createElement('span');
    text.className = 'wsTraceText';
    text.textContent = toolLabel(t);

    row.appendChild(icon);
    row.appendChild(text);

    if (Number.isFinite(t.ms) && t.ms > 0) {
      const ms = document.createElement('span');
      ms.className = 'wsTraceMs';
      ms.textContent = fmtMs(t.ms);
      row.appendChild(ms);
    }
    if (t.ok === false && t.error) {
      const err = document.createElement('div');
      err.className = 'wsTraceErr';
      err.textContent = String(t.error);
      row.appendChild(err);
    }
    return row;
  }

  /** 执行命令行（等宽字体）。当前没有 shell 工具，这条路暂时不会走到。 */
  function buildCommandRow(c) {
    const row = document.createElement('div');
    row.className = 'wsTraceItem is-cmd';

    const icon = document.createElement('span');
    icon.className = 'wsTraceIcon';
    icon.textContent = '›_';

    const text = document.createElement('span');
    text.className = 'wsTraceText wsTraceCmd';
    text.textContent = c.path || c.name || '';

    row.appendChild(icon);
    row.appendChild(text);
    return row;
  }


  /** 计算头部摘要：「已完成 · N 步」「正在读取 xxx…」。 */
  function traceHeadText(view) {
    if (!view) return '';

    // 跑的时候优先显示**具体动作**（有了当前动作就不用一句「正在思考…」糊过去）
    if (view.running) {
      return view.currentAction || '正在思考…';
    }

    const parts = [];
    if (view.status === 'cancelled') parts.push('已停止');
    else if (view.status === 'failed') parts.push('失败了');
    else parts.push('已完成');

    if (view.totals?.toolCount) parts.push(`${view.totals.toolCount} 步操作`);
    if (view.totals?.changed) parts.push(`改了 ${view.totals.changed} 处`);
    if (view.totals?.retryCount) parts.push(`重试 ${view.totals.retryCount} 次`);
    return parts.join(' · ');
  }

  /**
   * 创建一个 trace 容器（实时渲染用）。
   *
   * @returns {{el: HTMLElement, update: Function, finish: Function}}
   *   update(task)  每次轮询调一次（读 task.view）
   *   finish(task)  任务结束时收尾
   */
  MP.createTrace = function () {
    const el = document.createElement('div');
    el.className = 'wsTrace';
    el.classList.add('live');

    // 头部：一行摘要 + 折叠箭头。默认折叠
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'wsTraceHead';
    head.setAttribute('aria-expanded', 'false');
    // 箭头和「刷新后重建」那条路保持一致（都是 ▸），否则同一个任务
    // 刷新前后箭头不一样。展开时靠 CSS 的 rotate(90deg) 转成向下。
    head.innerHTML = '<span class="wsTraceCaret">▸</span><span class="wsTraceNow"></span><span class="wsTraceTime"></span>';
    const nowEl = head.querySelector('.wsTraceNow');
    const timeEl = head.querySelector('.wsTraceTime');

    // 主体：和 buildTraceFromTask 一样，**一个容器按 blocks 顺序平铺**
    const body = document.createElement('div');
    body.className = 'wsTraceBody wsTraceFlow';

    el.appendChild(head);
    el.appendChild(body);

    let expanded = false;
    /** 「后端没给 view」的提示只出一次，别每 300ms 刷一遍 */
    let warnedNoView = false;

    head.addEventListener('click', () => {
      expanded = !expanded;
      el.classList.toggle('open', expanded);
      head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (expanded && lastView) paint(lastView);
    });

    const startedAt = Date.now();
    let lastView = null;
    let lastStatus = 'running';
    let timer = null;

    const tick = () => {
      if (lastStatus !== 'running' && lastStatus !== 'queued') return;
      timeEl.textContent = fmtMs(Date.now() - startedAt);
    };
    timer = setInterval(tick, 500);

    /**
     * 用 view 重画。
     *
     * **和 buildTraceFromTask 共用同一套结构**（单容器顺序平铺），
     * 差别只是这里要处理「数据一直在长」：每次重画都会重建 DOM，
     * 所以要把之前展开过的条目记下来，重画后恢复，否则每 300ms
     * 轮询一次就把用户刚点开的思考又收回去。
     */
    function paint(view) {
      // 记住已展开条目的 key（用「kind + 首 32 字」当指纹，足够稳定）
      const opened = new Set();
      for (const node of body.querySelectorAll('.wsFlowNote.open')) {
        opened.add(node.dataset.key ?? '');
      }

      body.textContent = '';

      const turns = Array.isArray(view?.turns) ? view.turns : [];
      for (const turn of turns) {
        for (const b of turn.blocks ?? []) {
          if (b.kind === 'text') {
            const p = document.createElement('div');
            p.className = 'wsFlowPara';
            p.textContent = String(b.text ?? '');
            body.appendChild(p);
          } else {
            const note = buildFlowNoteFromBlock(b);
            if (!note) continue;
            if (opened.has(note.dataset.key)) note.classList.add('open');
            body.appendChild(note);
          }
        }
        // 同上：不再追加「已读取/已修改 N 个文件」汇总行（派生数据，模型没输出）
      }

      // 有内容时才显示主体，否则只剩一行摘要
      body.hidden = !expanded || !body.childNodes.length;
    }

    /** 后端没给 view 时的兜底提示：只出一次，别每 300ms 刷一遍。 */
    function warnNoView() {
      if (warnedNoView) return;
      warnedNoView = true;
      body.textContent = '';
      const tip = document.createElement('div');
      tip.className = 'wsTraceItem';
      tip.textContent = '服务端还没重启，过程数据不可用：重启 node（npm start）后再刷新页面。';
      body.appendChild(tip);
      body.hidden = false;
    }

    /**
     * 每次轮询更新。
     * @param {object} task 服务端返回的 task（含 view）
     */
    function update(task) {
      lastStatus = task.status;
      const view = task.view;
      if (view) lastView = view;

      // 折叠状态下那行：优先用后端算好的「当前动作」
      nowEl.textContent = traceHeadText(view) || '正在思考…';

      if (expanded && view) {
        paint(view);
      } else if (expanded && !view) {
        warnNoView();
      }

      // 流式正文：模型还在说话、还没有任何工具时，把它放进「当前动作」，
      // 否则用户只看到「正在思考…」而正文明明在长
      if ((task.status === 'running' || task.status === 'queued')
          && task.text && task.text.trim() && !view?.families?.tool?.length) {
        const t = task.text.trim();
        nowEl.textContent = t.length > 60 ? `${t.slice(0, 60)}…` : t;
      }

      if (expanded) body.scrollTop = body.scrollHeight;
    }

    /** 任务结束：定格成「已完成 · 用时 X」。 */
    function finish(task) {
      lastStatus = task.status;
      if (timer) { clearInterval(timer); timer = null; }

      const view = task.view ?? lastView;

      el.classList.add('done');
      if (task.status === 'cancelled') el.classList.add('cancelled');
      if (task.status === 'failed') el.classList.add('failed');

      nowEl.textContent = traceHeadText(view) || '已完成';
      // 右边那个总耗时也走 view，别用本地钟。
      // 本地钟量的是「从点发送到收到 done」，比后端记录的步耗时之和大
      //（多出排队、收尾、轮询间隔），刷新前后会差个一两秒。
      timeEl.textContent = view?.totals?.ms > 0
        ? fmtMs(view.totals.ms)
        : fmtMs(Date.now() - startedAt);

      // 结束时要画一次：用户可能一直折叠着，展开后得能看到完整过程
      if (view) {
        lastView = view;
        paint(view);
      } else {
        warnNoView();
      }
    }

    return { el, update, finish };
  };

  /**
   * 从一个 block 造出「注记」条目（实时和历史共用）。
   * 返回的元素带 data-key，用于重画时恢复展开状态。
   */
  function buildFlowNoteFromBlock(b) {
    if (b.kind === 'reasoning') {
      const text = String(b.text ?? '');
      const note = buildFlowNote('reason', `思考过程（${text.length} 字）`, text);
      note.dataset.key = 'r:' + text.slice(0, 32);
      return note;
    }
    if (b.kind === 'tool') {
      const note = buildFlowNote('tool', toolLabel(b.tool), '', b.tool);
      note.dataset.key = 't:' + (b.tool?.name ?? '') + (b.tool?.path ?? '');
      return note;
    }
    if (b.kind === 'retry') {
      const note = buildFlowNote('retry', '重试模型请求', '');
      note.dataset.key = 'x:' + (b.step ?? '');
      return note;
    }
    return null;
  }


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

    // 消息行：上面是「执行过程」（折叠），下面是最终回复气泡。
    // 以前只有一个气泡、过程被覆盖；现在两者都在，过程默认收起。
    const row = document.createElement('div');
    row.className = 'chatRow agent';

    const trace = MP.createTrace();
    row.appendChild(trace.el);

    // 正文气泡先藏起来。
    // 模型还没吐出任何字时，过程面板的标题已经在显示「正在思考… 24.5s」，
    // 下面再挂一个「正在思考…」是重复的两行，看着像卡住了。
    // 等第一段正文到达（或任务结束/出错）再显示。
    const progressBubble = document.createElement('div');
    progressBubble.className = 'chatBubble stepping';
    progressBubble.hidden = true;
    row.appendChild(progressBubble);

    if (list) {
      list.appendChild(row);
      list.scrollTop = list.scrollHeight;
    }

    let taskId = null;
    /** 用户点过停止以后，把最终气泡的样式换成「已停止」而不是普通回复 */
    let stopped = false;
    /** 正文气泡出现过没有 —— 用来避免每 300ms 反复改 hidden 触发重排 */
    let bubbleShown = false;
    const showBubble = () => {
      if (bubbleShown) return;
      bubbleShown = true;
      progressBubble.hidden = false;
    };

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
            // 点停止时要立刻给反馈：哪怕正文气泡还没出现过，也得让它显形
            showBubble();
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
          // 执行过程面板：一直更新（即使正在停止，过程也要保留下来）
          trace.update(t);
          if (stopped) return;

          // 正文气泡：只在真有文字可显示时才出现。
          // 没文字时什么都不做 —— 过程面板顶上那行「正在思考… 24.5s」已经够了。
          // 正文已经在过程面板里流式显示了（wsFlowPara），
          // 这里只在面板还没有正文时用气泡兜底，避免同一段话出现两遍。
          const hasText = Boolean(t.text && t.text.trim());
          if (hasText && (t.status === 'running' || t.status === 'queued')
            && !trace.el.querySelector('.wsFlowPara')) {
            showBubble();
            progressBubble.textContent = t.text;
            progressBubble.classList.add('streaming');
          }

          if (list) list.scrollTop = list.scrollHeight;
          if (opt.onProgress) opt.onProgress(t);
        },
      });

      // 任务完成：收尾过程面板。
      //
      // **正文不再重复显示在气泡里**（2026-11）：面板的 wsFlowPara 已经是正文，
      // 再挂一个完整气泡就是同一段话读两遍。
      // 只有「完全没有面板」（0 步、无思考无工具）时才用气泡兜底。
      trace.finish(task);
      progressBubble.classList.remove('stepping');
      progressBubble.classList.remove('streaming');
      if (trace.el.querySelector('.wsFlowPara')) {
        progressBubble.hidden = true;
      } else {
        showBubble();
        progressBubble.textContent = task.text || '（没有输出）';
        if (task.status === 'cancelled') {
          progressBubble.classList.add('stopped');
          stopped = true;
        }
      }
      if (list) list.scrollTop = list.scrollHeight;

      if (opt.onReply) opt.onReply(task);
      return task;
    } catch (err) {
      mine.classList.remove('pending');
      progressBubble.classList.remove('stepping');
      // 用户主动停止也被 waitTask 当成异常抛出（status=cancelled），
      // 但这不是错误，别标红吓人 —— 服务端已经在 text 里给了人话。
      if (err.task && err.task.status === 'cancelled') {
        trace.finish(err.task);
        showBubble();
        progressBubble.classList.add('stopped');
        progressBubble.textContent = err.task.text || '已停止';
        if (list) list.scrollTop = list.scrollHeight;
        if (opt.onReply) opt.onReply(err.task);
        return err.task;
      }
      // 真失败：过程面板定格成失败态，气泡标红
      trace.finish({ status: 'failed', events: [] });
      showBubble();
      progressBubble.classList.add('errtip');
      progressBubble.textContent = err.message || '发送失败';
      throw err;
    }
  };
})();
