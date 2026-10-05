import { getDb } from './db.js';
import { hashPassword, verifyPassword, createToken } from './auth.js';
import { SESSION_TTL_DAYS, PASSWORD_MIN, NAME_MIN, NAME_MAX, BIO_MAX } from './config.js';

/** 当前时间的 ISO 8601 字符串。users / sessions 的时间列都用这个格式，比较靠字符串序。 */
const nowIso = () => new Date().toISOString();
/** 从此刻起 days 天后的 ISO 字符串，只用来算 sessions.expires_at。 */
const isoInDays = (days) => new Date(Date.now() + days * 86400_000).toISOString();

/** 去掉 password_hash，任何要发给客户端或渲染到页面的用户对象都必须先过这里。
 *  顺带做两件事：is_admin（0/1）转成布尔 isAdmin，bio 兜底成空串。
 *  传 null / undefined 返回 null（调用方常把 null 直接当「未登录」）。
 *  注意它不脱敏 email——库里存的就是 trim + 小写后的邮箱。 */
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

/** 按 id 取整行（**含 password_hash**），返回 null 表示没有这个用户。
 *  要发给客户端或渲染页面时必须先过 publicUser。 */
export function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

/** 登录标识可以是邮箱，也可以是用户名（管理员用的是 admin）。
 *  login 为空或只有空格时直接返回 null，不查库；两个字段都按 COLLATE NOCASE 匹配，大小写不敏感。
 *  返回整行（含 password_hash），密码比对在 authenticate 里做。 */
export function findUserByLogin(login) {
  const value = String(login ?? '').trim();
  if (!value) return null;

  return (
    getDb()
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE')
      .get(value, value) ?? null
  );
}

/** 新建用户：邮箱 trim + 转小写，密码就地 hash（明文不落任何地方），status 固定写 'active'。
 *  返回新建的整行（含 password_hash）。
 *  陷阱：不校验密码长度、不校验用户名格式、不处理重复邮箱——撞上 email 的 UNIQUE 会把 SQLite 原始错误抛出去，
 *  调用方（server.js 的注册 / 重置流程）负责先做这些校验。
 *  username 不传就是 null，也就是「还没设用户名」。 */
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

/** 校验登录标识 + 密码：查不到用户和密码不对都返回 null，两者不区分（避免泄露账号是否存在）。
 *  成功返回整行（含 password_hash），调用方要自己过 publicUser 再外发。 */
export function authenticate(login, password) {
  const user = findUserByLogin(login);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

/** 后台用户列表，按 id 倒序（新的在前）。
 *  返回的是整行，**含 password_hash**——后台接口外发前必须逐行过 publicUser。
 *  默认 200 条、只有 OFFSET 分页；后台调用时不传参，所以 200 条之后的用户看不到也操作不了。 */
export function listUsers({ limit = 200, offset = 0 } = {}) {
  return getDb()
    .prepare('SELECT * FROM users ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}

/** 改用户状态（'active' 可用 / 'banned' 封禁），返回受影响行数，0 表示没有这个 id。
 *  值不做白名单校验，由调用方保证。
 *  封禁**不吊销已签发的会话**：库里 sessions 行依旧有效，只是 server.js 的 currentUser 每次请求现查 status 拦下来。 */
export function setUserStatus(id, status) {
  return getDb().prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id).changes;
}

// ---------------------------------------------------------------- 账号自助设置

// 用户名规则：小写字母/数字/连字符，长度复用站名的 NAME_MIN/NAME_MAX。
// 注意不套用站点的 RESERVED 集合——管理员自己的用户名就叫 admin。
const USERNAME_PATTERN = /^[a-z0-9-]+$/;

/** 校验用户名：小写字母 / 数字 / 连字符，长度复用站名的 NAME_MIN-NAME_MAX。
 *  刻意不套用站点的 RESERVED 集合——管理员自己的用户名就叫 admin，用户名也不出现在 URL 路径里。 */
export function isValidUsername(username) {
  return (
    typeof username === 'string' &&
    username.length >= NAME_MIN &&
    username.length <= NAME_MAX &&
    USERNAME_PATTERN.test(username)
  );
}

/** 设置用户名。传 null 表示清除。冲突抛 code === 'NAME_TAKEN'。
 *  null / undefined / 空白都算清除：写 NULL 并返回 null；否则先 trim + 转小写再校验。
 *  格式不合法抛 BAD_NAME，已被别人占用抛 NAME_TAKEN（先 SELECT 再 UPDATE，中间仍有并发窗口，靠 UNIQUE 兜底）。
 *  成功时返回真正写进库的规范值，调用方要用它而不是原始输入（用户可能传了大写或带空格）。
 *  前提：调用方已经完成身份验证（本函数只认 userId）。 */
export function setUsername(userId, username) {
  if (username === null || username === undefined || String(username).trim() === '') {
    getDb().prepare('UPDATE users SET username = NULL WHERE id = ?').run(userId);
    return null;
  }

  const value = String(username).trim().toLowerCase();
  if (!isValidUsername(value)) {
    throw Object.assign(
      new Error(`用户名只能用小写字母、数字和连字符，长度 ${NAME_MIN}-${NAME_MAX}`),
      { code: 'BAD_NAME' },
    );
  }

  const taken = getDb()
    .prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?')
    .get(value, userId);
  if (taken) {
    throw Object.assign(new Error('这个用户名已经被使用了'), { code: 'NAME_TAKEN' });
  }

  getDb().prepare('UPDATE users SET username = ? WHERE id = ?').run(value, userId);
  return value;
}

/** 保存个人简介（或想说的话）。空值表示清除，超长抛 BIO_TOO_LONG。
 *  只 trim，不做 HTML 转义——它是纯文本，渲染时的转义责任在页面。
 *  返回 trim 后的最终值（前端拿它回填输入框）。 */
export function setBio(userId, bio) {
  const value = String(bio ?? '').trim();
  if (value.length > BIO_MAX) {
    throw Object.assign(new Error(`简介最多 ${BIO_MAX} 字`), { code: 'BIO_TOO_LONG' });
  }

  getDb().prepare('UPDATE users SET bio = ? WHERE id = ?').run(value, userId);
  return value;
}

/** 修改密码。旧密码不对抛 WRONG_PASSWORD，太短抛 PASSWORD_TOO_SHORT。
 *  顺序：用户存在（NO_USER）→ 旧密码正确（WRONG_PASSWORD）→ 新密码长度达标（PASSWORD_TOO_SHORT）。
 *  副作用：只改 password_hash，**不吊销任何会话**——要踢下线得调用方自己再调 deleteOtherSessions。
 *  不校验新旧密码是否相同（允许设成一样）。 */
export function changePassword(userId, currentPassword, newPassword) {
  const row = findUserById(userId);
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

  getDb()
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(next), userId);
}

/** 用户总数（后台统计用），包含被封禁的账号。 */
export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

/** 管理员数量。ensureAdminAccount 靠它判断「库里到底有没有管理员」。 */
export function countAdmins() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
}

/** 直接改密码（调用方负责先完成身份验证）。
 *  只写新哈希：不校验长度、不比对旧密码、不吊销会话，全在调用方（找回密码流程用它，改密码流程用 changePassword）。 */
export function updateUserPassword(id, newPassword) {
  getDb()
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(newPassword), id);
}

// ---------------------------------------------------------------- 会话

/** 新建会话：生成 token、按 SESSION_TTL_DAYS 算过期时间、写 sessions 表，返回 token。
 *  调用方负责把 token 塞进 mp_session Cookie（server.js 的 setSessionCookie）。
 *  同一用户可以有任意多个会话并存，没有任何数量上限。 */
export function createSession(userId) {
  const token = createToken();
  getDb()
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, nowIso(), isoInDays(SESSION_TTL_DAYS));
  return token;
}

/** 用 token 换用户整行（**含 password_hash**）；token 为空、查不到或已过期都返回 null。
 *  过期判断是「expires_at > 当前时间」的字符串比较，所以时间列必须都是同格式的 ISO 字符串。
 *  注意这里不看 status：被封禁的用户照样能查到，是否放行由 server.js 的 currentUser 决定。 */
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

/** 按 token 删一条会话（退出登录用）。token 为空直接返回不查库；删不存在的 token 也不报错、不抛异常。 */
export function deleteSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 删掉所有已过期的会话，返回删除条数（启动时调用一次，有删除才打印日志）。
 *  只在进程启动时跑一次：长期运行的进程里过期行会一直堆到下次重启。 */
export function deleteExpiredSessions() {
  return getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso()).changes;
}

/**
 * 踢掉某个用户的其他会话。找回密码后不带 keepToken（全部失效）；
 * 用户自己改密码时传当前会话 token，免得把自己也踢下线。
 *
 * 返回被删条数。传 keepToken 时要先确认它确实属于这个 userId，否则会把当前会话也一起删掉。
 * 副作用：被删的会话立刻失效，对方下一次请求就是未登录状态。
 */
export function deleteOtherSessions(userId, keepToken = null) {
  if (keepToken) {
    return getDb()
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
      .run(userId, keepToken).changes;
  }
  return getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

// ---------------------------------------------------------------- 管理员种子

/**
 * 数据库里一个管理员都没有时，创建默认管理员。
 * 已存在则什么都不做，所以改过密码之后重启不会被覆盖回去。
 *
 * 返回 { email, username, password } 供启动日志打印（就是明文密码），已有管理员时返回 null。
 * 取值来自环境变量 ADMIN_EMAIL / ADMIN_USERNAME / ADMIN_PASSWORD，
 * 兜底是 admin@minepage.local / admin / '123'——这个默认密码比 PASSWORD_MIN 还短，
 * 而且 createUser 不校验长度，等于部署后不马上改就是弱口令。
 */
export function ensureAdminAccount() {
  if (countAdmins() > 0) return null;

  const email = process.env.ADMIN_EMAIL ?? 'admin@minepage.local';
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? '123';

  createUser({ email, username, password, isAdmin: true });
  return { email, username, password };
}
