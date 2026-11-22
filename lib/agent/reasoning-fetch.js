// 修复「思考内容丢失」：不同网关的 reasoning 字段名不一样。
//
// 背景：DeepSeek / MiniMax / MiMo 这类思考型模型，流式返回的思考内容有两种写法：
//   OpenAI 官方扩展：  delta.reasoning_content
//   部分网关（含本项目的 amr-link）：  delta.reasoning  +  delta.reasoning_details
//
// 而 @langchain/openai 的转换器只认 `reasoning_content`：
//   const providerReasoningContent = message.reasoning_content;   // converters/completions.js
// 字段名不匹配时，思考内容被**静默丢弃** —— 实测前 142 个 chunk 全空，
// 直到第 143 个才开始吐正文，用户在界面上看不到任何「正在思考」的过程。
//
// 修法：给 OpenAI 客户端换一个 fetch，在 SSE 文本层面把 `reasoning` 补写成
// `reasoning_content`，让 LangChain 的转换器能正常识别。
//
// 为什么在 fetch 层做而不是改 LangChain：node_modules 不能改，升级会丢；
// 而且这是网关兼容问题，放在「对接层」最合适。

/**
 * 把一段 SSE 文本里的 `"reasoning":"..."` 补上 `"reasoning_content":"..."`。
 *
 * 逐行处理（SSE 每条消息一行 `data: {...}`），只对能成功解析成 JSON 的
 * data 行做改写，避免用正则硬替换误伤正文里出现的 "reasoning" 字样。
 *
 * @param {string} text SSE 原始文本（可能包含多行，最后一行可能不完整）
 * @returns {string}
 */
export function injectReasoningContent(text) {
  if (!text.includes('"reasoning"')) return text;

  // 按行拆，保留行尾换行符，避免破坏 SSE 分帧
  return text.split('\n').map((line) => {
    const m = /^(\s*data:\s*)(\{.*\})(\s*)$/.exec(line);
    if (!m) return line;

    const [, prefix, json, suffix] = m;
    let obj;
    try {
      obj = JSON.parse(json);
    } catch {
      // 半行（流式切断）解析不了就原样返回
      return line;
    }

    const delta = obj?.choices?.[0]?.delta;
    if (delta && typeof delta.reasoning === 'string' && delta.reasoning
      && typeof delta.reasoning_content !== 'string') {
      // 复制一份给 LangChain 认的字段名。保持字段顺序无关，JSON 序列化即可。
      delta.reasoning_content = delta.reasoning;
      return prefix + JSON.stringify(obj) + suffix;
    }
    return line;
  }).join('\n');
}

/**
 * 造一个「会补 reasoning_content」的 fetch。
 *
 * 只处理 text/event-stream（流式）；非流式响应里的 `message.reasoning`
 * 也顺手补一下，保持一致。
 */
export function makeReasoningFetch(baseFetch = globalThis.fetch) {
  return async function patchedFetch(url, init) {
    const res = await baseFetch(url, init);
    if (!res.body) return res;

    const ctype = res.headers.get('content-type') ?? '';

    // 非流式 JSON：整包读出来改
    if (ctype.includes('application/json')) {
      const text = await res.text();
      let out = text;
      const idx = text.indexOf('"reasoning"');
      if (idx >= 0) {
        try {
          const obj = JSON.parse(text);
          const msg = obj?.choices?.[0]?.message;
          if (msg && typeof msg.reasoning === 'string' && msg.reasoning
            && typeof msg.reasoning_content !== 'string') {
            msg.reasoning_content = msg.reasoning;
            out = JSON.stringify(obj);
          }
        } catch { /* 解析不了就原样返回 */ }
      }
      return new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    // 流式：边读边改
    if (ctype.includes('text/event-stream') || ctype.includes('stream')) {
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      const reader = res.body.getReader();
      let carry = '';

      const stream = new ReadableStream({
        async pull(ctrl) {
          // 读底层 body 必须兜住异常。
          //
          // 踩过的坑（线上把整个 node 进程干掉了）：
          //   用户点「停止」→ AbortController.abort() → undici 让底层 body
          //   的 reader.read() 以 AbortError reject。这发生在 pull() 内部，
          //   pull 返回的 promise 就变成 rejected；而此时外层消费者（LangChain
          //   的 SSE 解析器）已经被 abort 掉、不再读这个流，于是这个 rejection
          //   **没有任何人接** → Node 报 unhandledRejection → 没有监听器时
          //   默认直接终止进程。
          //
          //   症状：agent 思考中点一次「停止」，服务端整个挂掉，
          //   所有正在跑的任务和这个进程里的其他用户一起没了。
          //
          // 正确做法：把错误转成流错误（ctrl.error）交给消费者；
          // 已经没人消费时就静默收尾。
          let chunk;
          try {
            chunk = await reader.read();
          } catch (err) {
            try { ctrl.error(err); } catch { /* 流已关闭，忽略 */ }
            return;
          }

          const { done, value } = chunk;
          if (done) {
            if (carry) ctrl.enqueue(enc.encode(carry));
            ctrl.close();
            return;
          }
          carry += dec.decode(value, { stream: true });
          // 只处理到最后一个完整换行为止，剩下的留到下次（避免切碎 JSON）
          const cut = carry.lastIndexOf('\n');
          if (cut < 0) return;           // 还没凑够一行，继续读
          const ready = carry.slice(0, cut + 1);
          carry = carry.slice(cut + 1);
          ctrl.enqueue(enc.encode(injectReasoningContent(ready)));
        },
        // cancel() 必须把 reader.cancel() 的 promise 接住。
        // 原因同上：abort 之后这个 promise 会以 AbortError reject，
        // 直接 `reader.cancel()` 丢掉返回值就是一个 unhandled rejection。
        cancel(reason) {
          return reader.cancel(reason).catch(() => { /* 已经断了，无需上报 */ });
        },
      });

      return new Response(stream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }

    return res;
  };
}
