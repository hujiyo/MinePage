import { getDb } from './db.js';
import { hashPassword, verifyPassword, createToken } from './auth.js';
import { SESSION_TTL_DAYS } from './config.js';

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
    createdAt: row.created_at,
  };
}

export function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

/** 登录标识可以是邮箱，也可以是用户名（管理员用的是 admin）。 */
export function findUserByLogin(login) {
  const value = String(login ?? '').trim();
  if (!value) return null;

  return (
    getDb()
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE')
      .get(value, value) ?? null
  );
}

export function createUser({ email, username = null, password, isAdmin = false }) {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO users (email, username, password_hash, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(email.trim().toLowerCase(), username, hashPassword(password), isAdmin ? 1 : 0, nowIso());

  return findUserById(Number(result.lastInsertRowid));
}

export function authenticate(login, password) {
  const user = findUserByLogin(login);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

export function listUsers({ limit = 200, offset = 0 } = {}) {
  return getDb()
    .prepare('SELECT * FROM users ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}

export function setUserStatus(id, status) {
  return getDb().prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id).changes;
}

export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function countAdmins() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
}

// ---------------------------------------------------------------- 会话

export function createSession(userId) {
  const token = createToken();
  getDb()
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, nowIso(), isoInDays(SESSION_TTL_DAYS));
  return token;
}

export function findSessionUser(token) {
  if (!token) return null;

  return (
    getDb()
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, nowIso()) ?? null
  );
}

export function deleteSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteExpiredSessions() {
  return getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso()).changes;
}

// ---------------------------------------------------------------- 管理员种子

/**
 * 数据库里一个管理员都没有时，创建默认管理员。
 * 已存在则什么都不做，所以改过密码之后重启不会被覆盖回去。
 */
export function ensureAdminAccount() {
  if (countAdmins() > 0) return null;

  const email = process.env.ADMIN_EMAIL ?? 'admin@minepage.local';
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? '123';

  createUser({ email, username, password, isAdmin: true });
  return { email, username, password };
}
