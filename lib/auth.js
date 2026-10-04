import crypto from 'node:crypto';

// scrypt 派生密钥长度（字节）。改这个值会让库里已存的密码哈希全部失效。
const KEY_LENGTH = 64;

/** 生成 scrypt 哈希，格式 scrypt$<salt>$<hash>，明文永不落库。
 *  每次调用都重新随机 16 字节 salt，所以同一个密码两次哈希结果不同。
 *  列宽由模块常量 KEY_LENGTH 决定，改它会让老哈希在 verifyPassword 里对不上。 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/** 恒定时间比对，避免通过响应耗时猜密码。
 *  stored 为空或格式不是 scrypt$salt$hash 时直接返回 false，不抛错——脏数据走这条路而不是炸在调用方。
 *  派生用同一个 KEY_LENGTH，长度对不上也返回 false。 */
export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const actual = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  const expectedBuf = Buffer.from(expected, 'hex');
  if (actual.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(actual, expectedBuf);
}

/** 生成会话 token：32 字节随机数的 hex（64 个字符）。
 *  它同时是 sessions 表主键和 mp_session Cookie 的值，明文存库，不做哈希。 */
export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 把 Cookie 请求头解析成「名字 → 值」的对象，值会做 URL 解码。
 *  单个 Cookie 解码失败时保留原值、不抛错；同名 Cookie 后者覆盖前者；没有 Cookie 头返回空对象。 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    if (!key) continue;

    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }

  return out;
}

/** 拼一个 Set-Cookie 的值。固定带 Path=/、HttpOnly、SameSite=Lax，没有 Domain。
 *  maxAge 不传就不带 Max-Age（浏览器会话级 Cookie）；传 0 用来让浏览器删掉它，退出登录走的就是这条。
 *  secure 只决定加不加 Secure 属性，值来自 config.COOKIE_SECURE。
 *  注意：这里没有 CSRF token，防跨站写操作完全依赖 SameSite=Lax。 */
export function buildCookie(name, value, { maxAge, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 判断登录标识是邮箱还是用户名。
 *  只是「有没有 @ 和点」的粗判，不代表邮箱真实存在或已注册；用于决定注册 / 找回流程走哪条分支。 */
export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}
