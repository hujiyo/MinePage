import { all, get, run } from './db.js';
import { hashPassword, verifyPassword, createToken } from './auth.js';
import { SESSION_TTL_DAYS, PASSWORD_MIN, NAME_MIN, NAME_MAX, BIO_MAX } from './config.js';

const nowIso = () => new Date().toISOString();
const isoInDays = (days) => new Date(Date.now() + days * 86400_000).toISOString();

/** 去掉 password_hash，任何要发给客户端或渲染到页面的用户对象都必须先过这里。 */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    isAdmin: row.is_admin === 1,
    status: row.status,
    bio: row.bio ?? '',
    createdAt: row.created_at,
  };
}

export async function findUserById(id) {
  return (await get('SELECT * FROM users WHERE id = ?', id)) ?? null;
}

/** 登录标识可以是邮箱，也可以是用户名（管理员用的是 admin）。 */
export async function findUserByLogin(login) {
  const value = String(login ?? '').trim();
  if (!value) return null;

  return (
    (await get('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE', value, value)) ??
    null
  );
}

export async function createUser({ email, username = null, password, isAdmin = false }) {
  const result = await run(
    `INSERT INTO users (email, username, password_hash, is_admin, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    email.trim().toLowerCase(),
    username,
    hashPassword(password),
    isAdmin ? 1 : 0,
    nowIso(),
  );

  return findUserById(Number(result.lastInsertRowid));
}

export async function authenticate(login, password) {
  const user = await findUserByLogin(login);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

export async function listUsers({ limit = 200, offset = 0 } = {}) {
  return all('SELECT * FROM users ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset);
}

export async function setUserStatus(id, status) {
  return (await run('UPDATE users SET status = ? WHERE id = ?', status, id)).changes;
}

// ---------------------------------------------------------------- 账号自助设置

// 用户名规则：小写字母/数字/连字符，长度复用站名的 NAME_MIN/NAME_MAX。
// 注意不套用站点的 RESERVED 集合——管理员自己的用户名就叫 admin。
const USERNAME_PATTERN = /^[a-z0-9-]+$/;

export function isValidUsername(username) {
  return (
    typeof username === 'string' &&
    username.length >= NAME_MIN &&
    username.length <= NAME_MAX &&
    USERNAME_PATTERN.test(username)
  );
}

/** 设置用户名。传 null 表示清除。冲突抛 code === 'NAME_TAKEN'。 */
export async function setUsername(userId, username) {
  if (username === null || username === undefined || String(username).trim() === '') {
    await run('UPDATE users SET username = NULL WHERE id = ?', userId);
    return null;
  }

  const value = String(username).trim().toLowerCase();
  if (!isValidUsername(value)) {
    throw Object.assign(
      new Error(`用户名只能用小写字母、数字和连字符，长度 ${NAME_MIN}-${NAME_MAX}`),
      { code: 'BAD_NAME' },
    );
  }

  const taken = await get('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?', value, userId);
  if (taken) {
    throw Object.assign(new Error('这个用户名已经被使用了'), { code: 'NAME_TAKEN' });
  }

  await run('UPDATE users SET username = ? WHERE id = ?', value, userId);
  return value;
}

/** 保存个人简介（或想说的话）。空值表示清除，超长抛 BIO_TOO_LONG。 */
export async function setBio(userId, bio) {
  const value = String(bio ?? '').trim();
  if (value.length > BIO_MAX) {
    throw Object.assign(new Error(`简介最多 ${BIO_MAX} 字`), { code: 'BIO_TOO_LONG' });
  }

  await run('UPDATE users SET bio = ? WHERE id = ?', value, userId);
  return value;
}

/** 修改密码。旧密码不对抛 WRONG_PASSWORD，太短抛 PASSWORD_TOO_SHORT。 */
export async function changePassword(userId, currentPassword, newPassword) {
  const row = await findUserById(userId);
  if (!row) throw Object.assign(new Error('用户不存在'), { code: 'NO_USER' });

  if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
    throw Object.assign(new Error('当前密码不正确'), { code: 'WRONG_PASSWORD' });
  }

  const next = String(newPassword ?? '');
  if (next.length < PASSWORD_MIN) {
    throw Object.assign(new Error(`新密码至少 ${PASSWORD_MIN} 位`), {
      code: 'PASSWORD_TOO_SHORT',
    });
  }

  await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), userId);
}

export async function countUsers() {
  return (await get('SELECT COUNT(*) AS c FROM users')).c;
}

export async function countAdmins() {
  return (await get('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1')).c;
}

/** 直接改密码（调用方负责先完成身份验证）。 */
export async function updateUserPassword(id, newPassword) {
  await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), id);
}

// ---------------------------------------------------------------- 会话

export async function createSession(userId) {
  const token = createToken();
  await run(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    token,
    userId,
    nowIso(),
    isoInDays(SESSION_TTL_DAYS),
  );
  return token;
}

export async function findSessionUser(token) {
  if (!token) return null;

  return (
    (await get(
      `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      token,
      nowIso(),
    )) ?? null
  );
}

export async function deleteSession(token) {
  if (!token) return;
  await run('DELETE FROM sessions WHERE token = ?', token);
}

export async function deleteExpiredSessions() {
  return (await run('DELETE FROM sessions WHERE expires_at <= ?', nowIso())).changes;
}

/**
 * 踢掉某个用户的其他会话。找回密码后不带 keepToken（全部失效）；
 * 用户自己改密码时传当前会话 token，免得把自己也踢下线。
 */
export async function deleteOtherSessions(userId, keepToken = null) {
  if (keepToken) {
    return (await run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', userId, keepToken)).changes;
  }
  return (await run('DELETE FROM sessions WHERE user_id = ?', userId)).changes;
}

// ---------------------------------------------------------------- 管理员种子

/**
 * 数据库里一个管理员都没有时，创建默认管理员。
 * 已存在则什么都不做，所以改过密码之后重启不会被覆盖回去。
 */
export async function ensureAdminAccount() {
  if ((await countAdmins()) > 0) return null;

  const email = process.env.ADMIN_EMAIL ?? 'admin@minepage.local';
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? '123';

  await createUser({ email, username, password, isAdmin: true });
  return { email, username, password };
}
