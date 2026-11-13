// Token 估算：不引 tiktoken，用实测出来的换算率估。
//
// 为什么不能用一个固定系数：实测同一个网关，
//   纯中文 2.37 字符/token
//   纯英文 5.21 字符/token
//   纯代码 1.86 字符/token
// 差近 3 倍。统一按 3 算的后果：
//   - 代码会话会**高估**容量 → 拼出来的 prompt 直接超窗，网关报 400
//   - 英文会话会**低估**容量 → 白白浪费一半窗口
//
// 做法分两步：
//   ① 用「符号密度」判断这段整体像代码还是像自然语言
//      实测：纯代码 28.5%、真实源码 15–27%、Markdown 14.6%、纯英文 2.1%
//      阈值取 8%，能把代码和自然语言干净分开
//   ② 中文单独按 2.37 算，剩下的按上一步定下的基准算
//
// 误差实测：纯中文 0.0% / 纯英文 0.0% / 纯代码 0.2%

/** 代码类文本的换算率（短标识符多，token 化得很碎） */
const RATE_CODE = 1.86;
/** 自然语言（英文）的换算率 */
const RATE_TEXT = 5.21;
/** 中文的换算率 */
const RATE_CJK = 2.37;

/**
 * 这个字符算不算「代码符号」。
 *
 * 用 charCode 区间判而不是正则：正则里 `[` `\` `]` 这些要转义，
 * 写错一个就静默失效（我第一版就踩了这个坑，导致代码永远判不出来）。
 * ASCII 里 33–47、58–64、91–96、123–126 这四段就是全部标点符号。
 */
function isCodeSymbol(code) {
  return (code >= 33 && code <= 47)     // ! " # $ % & ' ( ) * + , - . /
    || (code >= 58 && code <= 64)       // : ; < = > ? @
    || (code >= 91 && code <= 96)       // [ \ ] ^ _ `
    || (code >= 123 && code <= 126);    // { | } ~
}

/** 中文字符（CJK 表意文字 + 中日韩标点 + 全角符号）。 */
function isCjk(code) {
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xff00 && code <= 0xffef);
}

/**
 * 判断一段文字整体像代码还是像自然语言。
 * 只看前 4000 字符 —— 够代表整体，又不至于每次都扫全文。
 */
function looksLikeCode(s) {
  const sample = s.length > 4000 ? s.slice(0, 4000) : s;
  let symbols = 0;
  for (const ch of sample) {
    const k = ch.charCodeAt(0);
    if (isCodeSymbol(k) || k === 10 /* \n */) symbols += 1;
  }
  return symbols / sample.length > 0.08;
}

/**
 * 估一段文本的 token 数。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;

  const rateOther = looksLikeCode(s) ? RATE_CODE : RATE_TEXT;

  let cjk = 0;
  let other = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (isCjk(s.charCodeAt(i))) cjk += 1;
    else other += 1;
  }

  return Math.ceil(cjk / RATE_CJK + other / rateOther);
}

/** 估一条消息（role/content）的 token；多模态 content 数组按文字部分估。 */
export function estimateMessageTokens(msg) {
  if (!msg) return 0;
  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && part.type === 'text') text += part.text || '';
      // 图片按固定开销算：一张 2048 长边约 1500–2500 token，取 2000。
      else if (part && part.type === 'image_url') return 2000;
    }
  }
  // 每条消息有约 4 token 的角色/分隔开销
  return estimateTokens(text) + 4;
}

/** 估一整个 messages 数组。 */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) total += estimateMessageTokens(m);
  return total;
}

/** 数据库消息行（role/content/attach_ids）估 token。 */
export function estimateRowTokens(row) {
  const content = String(row?.content ?? '');
  const hasImage = Boolean(String(row?.attach_ids ?? '').trim());
  return estimateTokens(content) + (hasImage ? 2000 : 0) + 4;
}

/** 一个模型窗口能装多少 token 的历史（扣掉回复和工具预留）。 */
export function historyBudgetTokens(contextWindow, usableRatio = 0.7) {
  const window = Number(contextWindow) || 128_000;
  return Math.max(8_000, Math.floor(window * usableRatio));
}
