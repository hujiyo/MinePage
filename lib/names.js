import { NAME_MIN, NAME_MAX, RESERVED } from './config.js';

// 首尾必须是字母或数字，中间允许连字符
const PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * 校验站名。
 * 通过时返回 { ok: true, name }，name 是规范化后的结果（去空格、转小写），调用方必须用它。
 * 不通过时返回 { ok: false, reason }，reason 可以直接展示给用户。
 *
 * 口径：长度 NAME_MIN-NAME_MAX、字符集 [a-z0-9-]、首尾不能是连字符、不在 config.RESERVED 里。
 * 只拦新建与改名，不回溯检查库里已有的站名——往 RESERVED 里加词不影响存量站点。
 * reason 是直接给用户看的中文文案，改文案等于改页面显示。
 */
export function checkName(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: '请填写名字' };
  }

  const name = raw.trim().toLowerCase();

  if (name.length < NAME_MIN) {
    return { ok: false, reason: `名字至少 ${NAME_MIN} 个字符` };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, reason: `名字最多 ${NAME_MAX} 个字符` };
  }
  if (!PATTERN.test(name)) {
    return {
      ok: false,
      reason: '只能用英文小写字母、数字和连字符，且不能以连字符开头或结尾',
    };
  }
  if (RESERVED.has(name)) {
    return { ok: false, reason: `"${name}" 是平台保留的名字，换一个吧` };
  }

  return { ok: true, name };
}
