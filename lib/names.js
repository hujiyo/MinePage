import { NAME_MIN, NAME_MAX, RESERVED } from './config.js';

// 首尾必须是字母或数字，中间允许连字符
const PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * 校验站名。
 * 通过时返回 { ok: true, name }，name 是规范化后的结果（去空格、转小写），调用方必须用它。
 * 不通过时返回 { ok: false, reason }，reason 可以直接展示给用户。
 *
 * 站名挂在 /<前缀>/<用户名>/ 下面，只在自己名下唯一，不会跟平台路由或别人的站名冲突，
 * 所以这里不再查保留字表。
 */
export function checkName(raw) {
  return checkSlug(raw, { reserved: false });
}

/**
 * 校验用户名。用户名的段位就是 /<前缀>/<用户名>/，所以它要避开保留字
 * （目前只有前缀本身）。
 */
export function checkUsername(raw) {
  return checkSlug(raw, { reserved: true });
}

function checkSlug(raw, { reserved }) {
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
  if (reserved && RESERVED.has(name)) {
    return { ok: false, reason: `"${name}" 是平台保留的名字，换一个吧` };
  }

  return { ok: true, name };
}
