import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
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
`;

export function getDb() {
  if (db) return db;

  const file = path.join(ROOT, DB_FILE);
  mkdirSync(path.dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);

  return db;
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
  ensureColumn('sites', 'title', "title TEXT NOT NULL DEFAULT ''");
  ensureColumn('sites', 'description', "description TEXT NOT NULL DEFAULT ''");
  ensureColumn('sites', 'tag', "tag TEXT NOT NULL DEFAULT ''");
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
