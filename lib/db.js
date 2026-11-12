// 数据库访问层：全站 SQL 都从这里出去，换库只动这个文件。
//
// 对外三个动词 + 一个 exec：
//   get(sql, ...参数)   一行，没有就 null
//   all(sql, ...参数)   数组
//   run(sql, ...参数)   { changes, lastInsertRowid }
//   exec(sql)           单条语句
//
// 都是 async 的：MySQL 驱动天然异步，调用方一律 await。
import mysql from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MYSQL_DATABASE, MYSQL_HOST, MYSQL_PASSWORD, MYSQL_PORT, MYSQL_USER } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pool = null;
let ready = null;

// 建表语句全部幂等，每次启动跑一遍即可。
// 历史时间戳存的是 ISO 字符串，用 VARCHAR 原样存取，不折腾时区。
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email          VARCHAR(255) NOT NULL,
    username       VARCHAR(32) NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,
    is_admin       TINYINT NOT NULL DEFAULT 0,
    status         VARCHAR(20) NOT NULL DEFAULT 'active',
    bio            VARCHAR(255) NOT NULL DEFAULT '',
    notify_seen_at VARCHAR(40) NOT NULL DEFAULT '',
    coin_balance   INT NOT NULL DEFAULT 0,
    created_at     VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email),
    UNIQUE KEY uq_users_username (username)
  ) ENGINE=InnoDB`,
  // 站名只在用户名下面唯一：两家各有一个 study 互不冲突。
  // 用户注销时站点跟着级联删除（URL 依赖 owner_id → username，无主站没法访问）。
  `CREATE TABLE IF NOT EXISTS sites (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(32) NOT NULL,
    owner_id    BIGINT UNSIGNED NOT NULL,
    html        MEDIUMTEXT NOT NULL,
    size        BIGINT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'active',
    title       VARCHAR(120) NOT NULL DEFAULT '',
    description VARCHAR(300) NOT NULL DEFAULT '',
    tag         VARCHAR(20) NOT NULL DEFAULT '',
    views       BIGINT NOT NULL DEFAULT 0,
    created_at  VARCHAR(40) NOT NULL,
    updated_at  VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sites_owner_name (owner_id, name),
    KEY idx_sites_owner (owner_id),
    CONSTRAINT fk_sites_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      VARCHAR(128) NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    expires_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (token),
    KEY idx_sessions_user (user_id),
    KEY idx_sessions_expiry (expires_at),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS email_codes (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email       VARCHAR(255) NOT NULL,
    purpose     VARCHAR(20) NOT NULL,
    code_hash   VARCHAR(64) NOT NULL,
    attempts    INT NOT NULL DEFAULT 0,
    created_at  VARCHAR(40) NOT NULL,
    expires_at  VARCHAR(40) NOT NULL,
    consumed_at VARCHAR(40) NULL,
    PRIMARY KEY (id),
    KEY idx_codes_email (email, purpose)
  ) ENGINE=InnoDB`,
  // 多文件站点：一个站点下的所有文件（子页面、样式、脚本、图片…）。
  // 入口页约定为 index.html；老的单文件站点仍然走 sites.html，两套并存。
  `CREATE TABLE IF NOT EXISTS site_files (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id    BIGINT UNSIGNED NOT NULL,
    path       VARCHAR(200) NOT NULL,
    content    MEDIUMBLOB NOT NULL,
    size       BIGINT NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_site_files (site_id, path),
    KEY idx_site_files_site (site_id),
    CONSTRAINT fk_site_files FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 卡片自定义封面：一站一张，原图字节直接入库（≤2MB）。
  // 单独建表而不是给 sites 加列：加表对生产存量数据更安全，也避免 SELECT * 时把图片拖出来。
  `CREATE TABLE IF NOT EXISTS site_covers (
    site_id    BIGINT UNSIGNED NOT NULL,
    mime       VARCHAR(20) NOT NULL,
    size       BIGINT NOT NULL,
    bytes      MEDIUMBLOB NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (site_id),
    CONSTRAINT fk_site_covers_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 社区互动：点赞（一人一站最多一条）
  `CREATE TABLE IF NOT EXISTS likes (
    site_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (site_id, user_id),
    CONSTRAINT fk_likes_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE,
    CONSTRAINT fk_likes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 评论：reply_to 指向同站内另一条评论（只做一级回复）。
  `CREATE TABLE IF NOT EXISTS comments (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    reply_to   BIGINT UNSIGNED NULL,
    content    TEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_comments_site (site_id),
    CONSTRAINT fk_comments_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE,
    CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_comments_reply FOREIGN KEY (reply_to) REFERENCES comments (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 收藏：一人一站最多一条；folder 只存收藏夹名字（简单版不建独立收藏夹表）。
  `CREATE TABLE IF NOT EXISTS favorites (
    site_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    folder     VARCHAR(60) NOT NULL DEFAULT '默认收藏夹',
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (site_id, user_id),
    KEY idx_favorites_user (user_id),
    CONSTRAINT fk_favorites_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE,
    CONSTRAINT fk_favorites_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 收藏夹：用户自建的收藏夹名（空夹子也要能存在、能改名）。
  // favorites.folder 只存名字，这里管「夹子本身」；两边靠名字对齐，改名时一起改。
  `CREATE TABLE IF NOT EXISTS favorite_folders (
    user_id    BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(60) NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (user_id, name),
    CONSTRAINT fk_fav_folders_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 硬币流水：余额（users.coin_balance）是缓存，这张表才是事实，出问题可从这里重算。
  // UNIQUE(user_id, reason, ref) 同时承担幂等：签到用 ref='YYYY-MM-DD'，同一天重复插入直接被挡。
  `CREATE TABLE IF NOT EXISTS coin_ledger (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id    BIGINT UNSIGNED NOT NULL,
    delta      INT NOT NULL,
    reason     VARCHAR(20) NOT NULL,
    ref        VARCHAR(64) NOT NULL,
    site_id    BIGINT UNSIGNED NULL,
    from_user_id BIGINT UNSIGNED NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_coin_ledger_once (user_id, reason, ref),
    KEY idx_coin_ledger_user (user_id, id),
    KEY idx_coin_ledger_site (site_id),
    CONSTRAINT fk_coin_ledger_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_coin_ledger_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  // 投给某个站点的硬币：一人一站一条，count ≤ MAX_COINS_PER_SITE。
  // 只增不改、没有删除路径——页面「收到多少枚」是永久记录，作者花掉自己的币不会让它变小。
  `CREATE TABLE IF NOT EXISTS coin_charges (
    site_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    count      TINYINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (site_id, user_id),
    KEY idx_coin_charges_site (site_id),
    CONSTRAINT fk_coin_charges_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE,
    CONSTRAINT fk_coin_charges_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 关注：follower 关注 followee。
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id BIGINT UNSIGNED NOT NULL,
    followee_id BIGINT UNSIGNED NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    KEY idx_follows_target (followee_id),
    CONSTRAINT fk_follows_follower FOREIGN KEY (follower_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_follows_followee FOREIGN KEY (followee_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 浏览历史：一人一站一条，重复浏览只刷新时间（简单版，不做时长/次数）。
  `CREATE TABLE IF NOT EXISTS view_history (
    user_id   BIGINT UNSIGNED NOT NULL,
    site_id   BIGINT UNSIGNED NOT NULL,
    viewed_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (user_id, site_id),
    KEY idx_history_time (user_id, viewed_at),
    CONSTRAINT fk_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_history_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 私信：按发送时间排，read_at 为空表示收件人还没看。
  `CREATE TABLE IF NOT EXISTS messages (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sender_id   BIGINT UNSIGNED NOT NULL,
    receiver_id BIGINT UNSIGNED NOT NULL,
    content     TEXT NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    read_at     VARCHAR(40) NULL,
    PRIMARY KEY (id),
    KEY idx_messages_receiver (receiver_id, read_at),
    KEY idx_messages_sender (sender_id),
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_receiver FOREIGN KEY (receiver_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // MCP 密钥：只存 sha256，明文不落库；吊销 = 删行。
  `CREATE TABLE IF NOT EXISTS mcp_tokens (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id      BIGINT UNSIGNED NOT NULL,
    label        VARCHAR(60) NOT NULL,
    token_hash   VARCHAR(64) NOT NULL,
    created_at   VARCHAR(40) NOT NULL,
    last_used_at VARCHAR(40) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_mcp_tokens_hash (token_hash),
    KEY idx_mcp_tokens_user (user_id),
    CONSTRAINT fk_mcp_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 工作区会话：一个站点（草稿）下可以有多个对话线程。
  // 老库补 thread_id 列由 migrate() 负责（见下面 ensureColumn），这里只建新表。
  `CREATE TABLE IF NOT EXISTS agent_threads (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id    BIGINT UNSIGNED NOT NULL,
    title      VARCHAR(120) NOT NULL DEFAULT '',
    model      VARCHAR(40) NOT NULL DEFAULT '',
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_agent_threads_site (site_id, updated_at),
    CONSTRAINT fk_agent_threads_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 工作区对话记录：一条消息属于某个会话。
  // thread_id 可空只为兼容老数据，migrate() 会给它回填一个「默认会话」。
  `CREATE TABLE IF NOT EXISTS site_messages (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id    BIGINT UNSIGNED NOT NULL,
    thread_id  BIGINT UNSIGNED NULL,
    role       VARCHAR(12) NOT NULL,
    content    TEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_site_messages_site (site_id, id),
    KEY idx_site_messages_thread (thread_id, id),
    CONSTRAINT fk_site_messages_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE,
    CONSTRAINT fk_site_messages_thread FOREIGN KEY (thread_id) REFERENCES agent_threads (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 改动快照：agent 每次写/删文件前，把「将被改动的文件」的旧内容存一份。
  // 只存被改的文件（不是整站），大站也存得起；files 是 JSON:
  //   { "written": [{path, content(base64)}], "removed": [{path, content(base64)}] }
  `CREATE TABLE IF NOT EXISTS site_snapshots (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id    BIGINT UNSIGNED NOT NULL,
    thread_id  BIGINT UNSIGNED NULL,
    label      VARCHAR(200) NOT NULL DEFAULT '',
    files      MEDIUMBLOB NOT NULL,
    size       BIGINT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_site_snapshots_site (site_id, id),
    CONSTRAINT fk_site_snapshots_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  // 首页轮播位：管理员指定「第几个位置放哪个站」，title/subtitle 空串表示跟随站点自身。
  // 站点被删时轮播位跟着级联删除，不会留下指向不存在页面的卡片。
  `CREATE TABLE IF NOT EXISTS banners (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id    BIGINT UNSIGNED NOT NULL,
    title      VARCHAR(120) NOT NULL DEFAULT '',
    subtitle   VARCHAR(200) NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    enabled    TINYINT NOT NULL DEFAULT 1,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_banners_order (sort_order, id),
    CONSTRAINT fk_banners_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
];

async function connect() {
  if (pool) return pool;

  pool = mysql.createPool({
    charset: 'utf8mb4',
    connectionLimit: 10,
    database: MYSQL_DATABASE,
    decimalNumbers: true,
    host: MYSQL_HOST,
    namedPlaceholders: false,
    password: MYSQL_PASSWORD,
    port: MYSQL_PORT,
    user: MYSQL_USER,
  });

  // 顺手验一下连接与库的存在，错就第一时间炸清楚
  await pool.query('SELECT 1');
  for (const ddl of SCHEMA) await pool.query(ddl);
  await migrate(pool);

  return pool;
}

function handle() {
  if (!ready) ready = connect();
  return ready;
}

// 老库升级：给已有表补新列（新库建表时已带上，这里幂等兜底）。
// 索引 / 外键 / NOT NULL 这类结构变更做不到幂等，统一交给 scripts/migrate-user-space.mjs。
async function migrate(target) {
  const ensureColumn = async (table, name, ddl) => {
    const [cols] = await target.query(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [MYSQL_DATABASE, table, name],
    );
    if (cols.length === 0) {
      await target.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  const ensureIndex = async (table, name, ddl) => {
    const [rows] = await target.query(
      `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [MYSQL_DATABASE, table, name],
    );
    if (rows.length === 0) {
      await target.query(`ALTER TABLE ${table} ADD ${ddl}`);
    }
  };

  await ensureColumn('users', 'bio', "bio VARCHAR(255) NOT NULL DEFAULT ''");
  await ensureColumn('users', 'notify_seen_at', "notify_seen_at VARCHAR(40) NOT NULL DEFAULT ''");
  await ensureColumn('sites', 'title', "title VARCHAR(120) NOT NULL DEFAULT ''");
  await ensureColumn('sites', 'description', "description VARCHAR(300) NOT NULL DEFAULT ''");
  await ensureColumn('sites', 'tag', "tag VARCHAR(20) NOT NULL DEFAULT ''");
  await ensureColumn('sites', 'views', 'views BIGINT NOT NULL DEFAULT 0');
  await ensureColumn('users', 'coin_balance', 'coin_balance INT NOT NULL DEFAULT 0');

  // 工作区改成「一个草稿可以有多条会话」：老库的 site_messages 没有 thread_id，
  // 补列 + 补索引，然后给每个有消息的站点回填一个「默认会话」。
  await ensureColumn('site_messages', 'thread_id', 'thread_id BIGINT UNSIGNED NULL AFTER site_id');
  await ensureIndex('site_messages', 'idx_site_messages_thread', 'INDEX idx_site_messages_thread (thread_id, id)');
  await backfillThreads(target);
}

/**
 * 给「有消息但没有会话」的站点补一个默认会话，并把它的消息挂上去。
 * 幂等：已经回填过的站点不会再动；新库没有任何消息，这一步什么都不做。
 */
async function backfillThreads(target) {
  const [orphans] = await target.query(
    `SELECT DISTINCT site_id FROM site_messages WHERE thread_id IS NULL`,
  );
  if (orphans.length === 0) return;

  const now = new Date().toISOString();
  for (const { site_id: siteId } of orphans) {
    const [existing] = await target.query(
      "SELECT id FROM agent_threads WHERE site_id = ? ORDER BY id LIMIT 1",
      [siteId],
    );
    let threadId = existing[0]?.id;
    if (!threadId) {
      const [created] = await target.query(
        `INSERT INTO agent_threads (site_id, title, model, created_at, updated_at)
         VALUES (?, '默认会话', '', ?, ?)`,
        [siteId, now, now],
      );
      threadId = created.insertId;
    }
    await target.query(
      'UPDATE site_messages SET thread_id = ? WHERE site_id = ? AND thread_id IS NULL',
      [threadId, siteId],
    );
  }
  console.log(`回填了 ${orphans.length} 个站点的默认会话`);
}

/** 一行，没有就 null。 */
export async function get(sql, ...params) {
  const [rows] = await (await handle()).query(sql, params);
  return rows[0] ?? null;
}

/** 多行。 */
export async function all(sql, ...params) {
  const [rows] = await (await handle()).query(sql, params);
  return rows;
}

/** 写入，返回 { changes, lastInsertRowid }。 */
export async function run(sql, ...params) {
  const [result] = await (await handle()).query(sql, params);
  return { changes: result.affectedRows ?? 0, lastInsertRowid: result.insertId ?? 0 };
}

/** 单条语句。 */
export async function exec(sql) {
  await (await handle()).query(sql);
}

/** 同一连接上的事务；回调失败时回滚站点及其文件的全部改动。 */
export async function withTransaction(callback) {
  const connection = await (await handle()).getConnection();
  const query = async (sql, params) => (await connection.query(sql, params))[0];
  const tx = {
    get: async (sql, ...params) => (await query(sql, params))[0] ?? null,
    all: async (sql, ...params) => query(sql, params),
    run: async (sql, ...params) => {
      const result = await query(sql, params);
      return { changes: result.affectedRows ?? 0, lastInsertRowid: result.insertId ?? 0 };
    },
  };
  try {
    await connection.beginTransaction();
    const result = await callback(tx);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * 是不是唯一键冲突。
 * 判断方式属于驱动细节（SQLite 看错误文本，MySQL 看 ER_DUP_ENTRY），
 * 所以放在这一层，业务代码不要去认错误字符串。
 */
export function isDuplicateError(err) {
  return err?.code === 'ER_DUP_ENTRY';
}

export async function closeDb() {
  if (pool) {
    const p = pool;
    pool = null;
    ready = null;
    await p.end();
  }
}
