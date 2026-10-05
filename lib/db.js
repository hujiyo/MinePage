import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_FILE } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let db = null;

// 建表语句全部幂等，每次启动跑一遍即可。
// 库里的表：users / sites / sessions / email_codes / site_files（前两段是平台自身，后一段是站点内容与社区互动）。
// 注意：sites.views、users.notify_seen_at 不在这段建表语句里，由下方 migrate() 补列——新库也走那条路。
const SCHEMA = `
-- 账号表。一行一个邮箱，id 是自增主键。
-- email 唯一且 COLLATE NOCASE（'A@x' 与 'a@x' 视为同一个），是注册与登录的主标识。
-- username 唯一且 COLLATE NOCASE，但可空；SQLite 里多个 NULL 不算冲突，所以「没设用户名」的用户可以有很多。
-- password_hash 存 scrypt$<salt>$<hash>，是唯一不能外发的列（所有出参都要过 users.js 的 publicUser）。
-- is_admin：0 普通用户 / 1 管理员；status：'active' 可用 / 'banned' 封禁（封禁不吊销会话，登录态在 server.js 里按 status 现查）。
-- bio 是个人简介（上限 BIO_MAX）。created_at 是 ISO 字符串——全库时间列都是 TEXT + ISO 8601，比较靠字符串序。
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

-- 站点表。一行一个站点，id 是自增主键；name 唯一，就是访问地址里的那一段（/站名）。
-- owner_id 外键指向 users(id)，ON DELETE SET NULL：用户被删后站点留下来变成无主站点（平台目前没有删用户的入口）。
-- html 存「单页站」的整段 HTML；多页站建站时被塞一个空字符串占位，内容在 site_files 里。
--   这一列是 NOT NULL，所以占位符躲不掉，同一列因此承载「真实内容」和「占位符」两种语义。
-- size 是字节数；status：'active' 上线 / 'offline' 被管理员下线（下线后访问回 451）。
-- title / description / tag 是站点元信息，tag 存 sites.js 的 SITE_TAGS key，空串表示未设置。
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

-- 会话表。token 是主键，就是 mp_session Cookie 里那串 32 字节随机 hex，明文存库不做哈希。
-- user_id 外键指向 users(id)，ON DELETE CASCADE：删用户连带删掉他的全部会话。
-- expires_at 是 ISO 字符串，users.js 的 findSessionUser 用「expires_at > 当前时间」的字符串比较判过期；
--   过期行不会自动消失，只在进程启动时由 deleteExpiredSessions() 清一次。
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);

-- 邮箱验证码。id 是自增主键；没有外键——按邮箱字符串记录，所以给尚未注册的邮箱发码（注册场景）也成立。
-- purpose 是用途（register / change / reset，见 verification.js 的 PURPOSES），同一邮箱的不同用途互不干扰。
-- code_hash 存 sha256(email:code)，明文只出现在邮件正文里；attempts 记校验失败次数，到 CODE_MAX_ATTEMPTS 后该行作废。
-- consumed_at 为空表示还没用过（用掉后写时间戳）；expires_at 过后 consumeCode 直接查不到（TTL 见 CODE_TTL_MINUTES）。
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
-- id 是自增主键；site_id 外键指向 sites(id)，ON DELETE CASCADE：删站点连带删掉全部文件。
-- UNIQUE (site_id, path) 是同一站点内「一路径一行」的唯一约束，sites.js 的 upsertSiteFile 靠它做 ON CONFLICT。
-- content 是 BLOB（原始字节），size 是它的长度；改文件的 updated_at 时会顺带刷新 sites.updated_at。
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
-- 主键 (site_id, user_id) 同时就是唯一约束；site_id / user_id 两个外键都 ON DELETE CASCADE。
-- 没有 id 列，取消点赞按这对主键删。
CREATE TABLE IF NOT EXISTS likes (
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (site_id, user_id)
);

-- 评论：reply_to 指向同站内另一条评论（只做一级回复）。
-- id 是自增主键；site_id / user_id 外键都 ON DELETE CASCADE。
-- reply_to 自引用 comments(id) 且 ON DELETE CASCADE：删父评论时它的回复一并被删。
-- 「reply_to 必须存在且属于同一站点」这条规则靠接口层校验，库里没有约束。
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_to   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

-- 收藏：一人一站最多一条；folder 只存收藏夹名字（简单版不建独立收藏夹表）。
-- 主键 (site_id, user_id) 同时就是唯一约束，重复收藏用 ON CONFLICT DO UPDATE 只改 folder（不刷新 created_at）。
-- folder 只是文本，不是外键——没有收藏夹表，也没有「收藏夹重命名」这类操作。
-- site_id / user_id 两个外键都 ON DELETE CASCADE。
CREATE TABLE IF NOT EXISTS favorites (
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder     TEXT    NOT NULL DEFAULT '默认收藏夹',
  created_at TEXT    NOT NULL,
  PRIMARY KEY (site_id, user_id)
);

-- 关注：follower 关注 followee。
-- 主键 (follower_id, followee_id)：一人对一人最多一条，而且**这张表没有 id 列**，查/删都按这对主键走。
-- 两个外键都指向 users(id) 且 ON DELETE CASCADE；「不能关注自己」只在 server.js 拦截，库里没有约束。
-- 索引 idx_follows_target 建在 followee_id 上，供「谁的粉丝」反查。
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

-- 浏览历史：一人一站一条，重复浏览只刷新时间（简单版，不做时长/次数）。
-- 主键 (user_id, site_id) 同时就是唯一约束；两个外键都 ON DELETE CASCADE。
-- 索引 idx_history_time 覆盖 (user_id, viewed_at)，供列表按时间倒序取。
CREATE TABLE IF NOT EXISTS view_history (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  viewed_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, site_id)
);

-- 私信：按发送时间排，read_at 为空表示收件人还没看。
-- id 是自增主键；sender_id / receiver_id 两个外键都指向 users(id) 且 ON DELETE CASCADE。
-- 会话列表按「每个对话取 id 最大的那条」实现，所以同一个人的往来只靠这张表推。
-- 索引 idx_messages_receiver 覆盖 (receiver_id, read_at)，供未读统计；idx_messages_sender 供按发送者查。
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  read_at     TEXT
);

-- MCP 密钥：只存 sha256，明文不落库；吊销 = 删行。
-- id 是自增主键；user_id 外键指向 users(id) ON DELETE CASCADE。
-- token_hash 唯一，是密钥全串的 sha256；明文只在创建响应里出现一次，之后无法找回。
-- label 是用户自己起的备注；last_used_at 可空，写入受 MCP_LAST_USED_THROTTLE_MS 节流。
-- 每账户上限 MCP_TOKENS_PER_USER 由 lib/mcp/tokens.js 校验，库里没有约束。
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT
);

-- 索引：覆盖外键反查（站点归属、密钥按用户、会话按用户）与高频过滤/排序（会话过期、
-- 验证码按邮箱+用途取最近一条、粉丝反查、收藏按用户、浏览历史时间线、未读私信）。
-- 唯一约束（email / username / sites.name / token 主键 / 各复合主键）由 SQLite 隐式建索引，这里不重复建。
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

/**
 * 取数据库单例，并保证表结构就绪。
 * 首次调用时：建目录 → 打开 DB_FILE → 开 WAL 与外键 → 跑幂等建表 → 跑补列迁移；
 * 之后每次都直接返回同一个连接（模块级单例，node:sqlite 是同步 API，没有连接池）。
 * 陷阱：PRAGMA foreign_keys 是连接级设置，级联删除依赖它，别在别处自己开库绕开这里。
 * 陷阱：改了 DB_FILE 环境变量要重启进程才生效，运行中不会重连。
 */
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
/**
 * 目前补 6 列：users.bio、users.notify_seen_at、sites.title、sites.description、sites.tag、sites.views。
 * 注意 users.notify_seen_at 与 sites.views 连上面的建表语句里都没有，新库也是靠这里补出来的；
 * 以后再改这两列（默认值、NOT NULL）要同时看建表语句和这里。
 */
function migrate(target) {
  /**
   * 表里没有这一列就补上。
   * 幂等：每次都先查 PRAGMA table_info 再决定要不要 ALTER。
   * 陷阱：table / name / ddl 是直接拼进 SQL 的，只能传代码里写死的常量，别接用户输入。
   * 副作用：ALTER TABLE 会立刻改库结构且无法回滚。
   */
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

/**
 * 关闭连接并清空单例。给进程退出（SIGINT / SIGTERM）和测试用。
 * 关闭之后再调 getDb() 会重新打开文件并重跑建表与迁移，不会复用旧连接（WAL 下数据不丢）。
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
