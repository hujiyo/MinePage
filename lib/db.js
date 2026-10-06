// 数据库访问层：全站 SQL 都从这里出去，换库只动这个文件。
//
// 对外三个动词 + 一个 exec：
//   get(sql, ...参数)   一行，没有就 null
//   all(sql, ...参数)   数组
//   run(sql, ...参数)   { changes, lastInsertRowid }
//   exec(sql)           多条语句（建表用）
//
// 都是 async 的：SQLite 驱动本身是同步的，但换到 MySQL 之后必然是异步，
// 所以这一层统一按异步写，调用方一律 await，将来换驱动不用再改一遍调用点。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { DB_FILE } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let db = null;

// 建表语句全部幂等，每次启动跑一遍即可。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  username      TEXT    UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active',
  bio           TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  html        TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active',
  title       TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  tag         TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS email_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL,
  purpose     TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  consumed_at TEXT
);

-- 多文件站点：一个站点下的所有文件（子页面、样式、脚本、图片…）。
-- 入口页约定为 index.html；老的单文件站点仍然走 sites.html，两套并存。
CREATE TABLE IF NOT EXISTS site_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  path       TEXT    NOT NULL,
  content    BLOB    NOT NULL,
  size       INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,
  UNIQUE (site_id, path)
);

-- 社区互动：点赞（一人一站最多一条）
CREATE TABLE IF NOT EXISTS likes (
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (site_id, user_id)
);

-- 评论：reply_to 指向同站内另一条评论（只做一级回复）。
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_to   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

-- 收藏：一人一站最多一条；folder 只存收藏夹名字（简单版不建独立收藏夹表）。
CREATE TABLE IF NOT EXISTS favorites (
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder     TEXT    NOT NULL DEFAULT '默认收藏夹',
  created_at TEXT    NOT NULL,
  PRIMARY KEY (site_id, user_id)
);

-- 关注：follower 关注 followee。
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

-- 浏览历史：一人一站一条，重复浏览只刷新时间（简单版，不做时长/次数）。
CREATE TABLE IF NOT EXISTS view_history (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  viewed_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, site_id)
);

-- 私信：按发送时间排，read_at 为空表示收件人还没看。
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  read_at     TEXT
);

-- MCP 密钥：只存 sha256，明文不落库；吊销 = 删行。
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sites_owner     ON sites(owner_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_codes_email     ON email_codes(email, purpose);
CREATE INDEX IF NOT EXISTS idx_site_files_site ON site_files(site_id);
CREATE INDEX IF NOT EXISTS idx_comments_site   ON comments(site_id);
CREATE INDEX IF NOT EXISTS idx_follows_target  ON follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user  ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_history_time    ON view_history(user_id, viewed_at);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, read_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
`;

let ready = null;

function connect() {
  if (db) return db;

  // path.resolve 而不是 path.join：DB_FILE 允许写绝对路径
  const file = path.resolve(ROOT, DB_FILE);
  mkdirSync(path.dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);

  return db;
}

function handle() {
  if (!ready) ready = connect();
  return ready;
}

// 老库升级：给已有表补新列（新库建表时已带上，这里幂等兜底）。
function migrate(target) {
  const ensureColumn = (table, name, ddl) => {
    const cols = target.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === name)) {
      target.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  ensureColumn('users', 'bio', "bio TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'notify_seen_at', "notify_seen_at TEXT NOT NULL DEFAULT ''");
  ensureColumn('sites', 'title', "title TEXT NOT NULL DEFAULT ''");
  ensureColumn('sites', 'description', "description TEXT NOT NULL DEFAULT ''");
  ensureColumn('sites', 'tag', "tag TEXT NOT NULL DEFAULT ''");
  ensureColumn('sites', 'views', 'views INTEGER NOT NULL DEFAULT 0');
}

/** 一行，没有就 null。 */
export async function get(sql, ...params) {
  return handle().prepare(sql).get(...params) ?? null;
}

/** 多行。 */
export async function all(sql, ...params) {
  return handle().prepare(sql).all(...params);
}

/** 写入，返回 { changes, lastInsertRowid }。 */
export async function run(sql, ...params) {
  return handle().prepare(sql).run(...params);
}

/** 多条语句（建表 / PRAGMA 之类）。 */
export async function exec(sql) {
  handle().exec(sql);
}

/**
 * 是不是唯一键冲突。
 * 判断方式属于驱动细节（SQLite 看错误文本，MySQL 看 ER_DUP_ENTRY），
 * 所以放在这一层，业务代码不要去认错误字符串。
 */
export function isDuplicateError(err) {
  return String(err?.message ?? '').includes('UNIQUE');
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    ready = null;
  }
}
