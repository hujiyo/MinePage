import crypto from 'node:crypto';

const KEY_LENGTH = 64;

/** 生成 scrypt 哈希，格式 scrypt$<salt>$<hash>，明文永不落库。 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/** 恒定时间比对，避免通过响应耗时猜密码。 */
export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const actual = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  const expectedBuf = Buffer.from(expected, 'hex');
  if (actual.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(actual, expectedBuf);
}

export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

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

export function buildCookie(name, value, { maxAge, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 判断登录标识是邮箱还是用户名。 */
export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}
