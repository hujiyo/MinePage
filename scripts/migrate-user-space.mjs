// 把「站名全局唯一」的旧库迁到「站名在每个用户名下唯一」的用户空间模型。
//
// 只做结构 + 数据两件事：
//   1. users.username 补齐成 NOT NULL（没用户名的按邮箱前缀生成一个合法的）
//   2. sites 的唯一键从 name 换成 (owner_id, name)，owner_id 改成 NOT NULL，
//      外键从 ON DELETE SET NULL 改成 ON DELETE CASCADE（注销账号要连站点一起清）
//
// 用法（先备份！）：
//   node scripts/migrate-user-space.mjs            # 执行迁移
//   node scripts/migrate-user-space.mjs --dry-run  # 只打印将要做什么
//
// 连接参数照旧走 MYSQL_* 环境变量。本机连线上库要先开隧道：
//   ssh -N -L 13306:127.0.0.1:3306 minepage
//   MYSQL_PORT=13306 node scripts/migrate-user-space.mjs
//
// 幂等：重复跑会跳过已经迁好的部分。

import mysql from 'mysql2/promise';

import { NAME_MIN, NAME_MAX, RESERVED, USER_SPACE_PREFIX } from '../lib/config.js';

const DRY = process.argv.includes('--dry-run');
const DB = process.env.MYSQL_DATABASE ?? 'minepage';

const log = (...args) => console.log(DRY ? '[dry]' : '[run]', ...args);

const PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** 把任意字符串压成合法用户名；压不出 3 位就返回 null。 */
function slugify(raw, taken) {
  let base = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (base.length < NAME_MIN) base = `user-${base}`.replace(/-+$/, '');
  if (!PATTERN.test(base) || base.length < NAME_MIN) base = 'user-x';
  base = base.slice(0, NAME_MAX).replace(/-+$/, '');
  if (!PATTERN.test(base)) base = 'user-x';

  if (!RESERVED.has(base) && !taken.has(base)) return base;

  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, '') + suffix;
    if (PATTERN.test(candidate) && !RESERVED.has(candidate) && !taken.has(candidate)) return candidate;
  }
  return null;
}

async function columnInfo(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB, table, column],
  );
  return rows[0] ?? null;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB, table, index],
  );
  return rows.length > 0;
}

async function constraintExists(conn, table, name) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [DB, table, name],
  );
  return rows.length > 0;
}

async function main() {
  const conn = await mysql.createConnection({
    charset: 'utf8mb4',
    database: DB,
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    password: process.env.MYSQL_PASSWORD ?? '',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'minepage',
  });

  try {
    console.log(`目标库：${DB}（前缀 /${USER_SPACE_PREFIX}/）\n`);

    // ---------------------------------------------------------- 1. 用户名
    const [users] = await conn.query('SELECT id, email, username FROM users ORDER BY id');
    const taken = new Set(users.map((u) => u.username).filter(Boolean));

    const missing = users.filter((u) => !u.username || String(u.username).trim() === '');
    console.log(`用户 ${users.length} 个，缺用户名的 ${missing.length} 个`);

    for (const user of missing) {
      const local = String(user.email ?? '').split('@')[0];
      const candidate = slugify(local, taken);
      if (!candidate) throw new Error(`给 ${user.email} 生成不出合法用户名，请手工指定`);
      taken.add(candidate);
      log(`用户 #${user.id} ${user.email} → 用户名 ${candidate}`);
      if (!DRY) await conn.query('UPDATE users SET username = ? WHERE id = ?', [candidate, user.id]);
    }

    const usernameCol = await columnInfo(conn, 'users', 'username');
    if (usernameCol && usernameCol.IS_NULLABLE === 'YES') {
      log('users.username 改成 NOT NULL');
      if (!DRY) await conn.query('ALTER TABLE users MODIFY COLUMN username VARCHAR(32) NOT NULL');
    } else {
      log('users.username 已经是 NOT NULL，跳过');
    }

    // ---------------------------------------------------------- 2. 站点归属
    const [[{ orphan }]] = await conn.query('SELECT COUNT(*) AS orphan FROM sites WHERE owner_id IS NULL');
    if (orphan > 0) {
      throw new Error(`有 ${orphan} 个站点没有归属（owner_id IS NULL），先决定怎么处理再迁`);
    }

    // 同一作者名下不能有重名（现在全局唯一，所以必然没有；保险起见查一下）
    const [dupes] = await conn.query(
      `SELECT owner_id, name, COUNT(*) AS c FROM sites GROUP BY owner_id, name HAVING c > 1`,
    );
    if (dupes.length > 0) {
      throw new Error(`同一作者名下有重名站点：${JSON.stringify(dupes)}`);
    }

    const sites = await conn.query('SELECT COUNT(*) AS c FROM sites');
    console.log(`站点 ${sites[0][0].c} 个，都没有归属问题`);

    // ---------------------------------------------------------- 3. 唯一键与外键
    if (await indexExists(conn, 'sites', 'uq_sites_name')) {
      log('删除旧唯一键 uq_sites_name(name)');
      if (!DRY) await conn.query('ALTER TABLE sites DROP INDEX uq_sites_name');
    } else {
      log('旧唯一键 uq_sites_name 不存在，跳过');
    }

    if (!(await indexExists(conn, 'sites', 'uq_sites_owner_name'))) {
      log('新增唯一键 uq_sites_owner_name(owner_id, name)');
      if (!DRY) await conn.query('ALTER TABLE sites ADD UNIQUE KEY uq_sites_owner_name (owner_id, name)');
    } else {
      log('唯一键 uq_sites_owner_name 已存在，跳过');
    }

    // 外键语义从 SET NULL 换成 CASCADE：注销账号 = 删掉 /qwq/用户名/ 下的一切。
    // 顺序很重要：必须先摘掉 SET NULL 的外键，才能把 owner_id 改成 NOT NULL
    // （MySQL 不让带 SET NULL 的列变成 NOT NULL）。
    if (await constraintExists(conn, 'sites', 'fk_sites_owner')) {
      log('摘掉旧外键 fk_sites_owner');
      if (!DRY) await conn.query('ALTER TABLE sites DROP FOREIGN KEY fk_sites_owner');
    }

    const ownerCol = await columnInfo(conn, 'sites', 'owner_id');
    if (ownerCol && ownerCol.IS_NULLABLE === 'YES') {
      log('sites.owner_id 改成 NOT NULL');
      if (!DRY) await conn.query('ALTER TABLE sites MODIFY COLUMN owner_id BIGINT UNSIGNED NOT NULL');
    } else {
      log('sites.owner_id 已经是 NOT NULL，跳过');
    }

    log('重建外键 fk_sites_owner（ON DELETE CASCADE）');
    if (!DRY) {
      await conn.query(
        `ALTER TABLE sites ADD CONSTRAINT fk_sites_owner
           FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE`,
      );
    }

    console.log(DRY ? '\n空跑结束，什么都没改。' : '\n迁移完成。');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('\n迁移失败：', err.message);
  process.exit(1);
});
