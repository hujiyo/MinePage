#!/usr/bin/env node
/**
 * 一次性导入脚本：把 /home/ubuntu/templates-src 下的模板目录灌进 minepage 库。
 *
 * 模型：一级目录 = 分类（存 sites.category），二级目录 = 一个模板站（sites 一行），
 * 模板里的每个文件 = site_files 一行（BLOB）。分类目录下散落的 html 各自建单文件站
 * （原文件改名为 index.html 放进 site_files，sites.html 留空占位，与平台多页站约定一致）。
 *
 * 站名用 tp-<分类代号>-<序号>（小写字母数字连字符，≤32 字符，符合平台站名规则）。
 * 状态一律 offline：不进发现流（discoverSites 硬过滤 active）、外部访问被拒，
 * 等平台上传功能完善后再上新。
 *
 * 幂等：站名已存在时先删（site_files 级联）再重插，可安全重跑。
 * 内存：文件按批读入（32MB 阈值 + 单文件例外，最大单包约 117MB < 256MB packet），
 * 不整站驻留，2GB 内存的机器跑得动。
 *
 * 用法（在服务器上，凭据从 /etc/minepage.env 取）：
 *   sudo bash -c 'set -a; source /etc/minepage.env; set +a; node /opt/minepage/scripts/import-templates.mjs'
 */
import mysql from 'mysql2/promise';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.TEMPLATES_ROOT || '/home/ubuntu/templates-src';
const BATCH_ROWS = 200;               // site_files 单批行数上限
const BATCH_BYTES = 32 * 1024 * 1024; // site_files 单批字节阈值

// 分类目录名 → 站名代号。站名规则 [a-z0-9-]+ 且 ≤32 字符。
const SLUG = {
  '100套HTML模板': 'tpl100',
  'AI': 'ai',
  'Bootstrap5': 'bs5',
  '个人': 'geren',
  '企业': 'qiye',
  '农业': 'nongye',
  '医疗': 'yiliao',
  '博客': 'boke',
  '后台': 'houtai',
  '宠物': 'chongwu',
  '工业': 'gongye',
  '教育': 'jiaoyu',
  '旅游': 'lvyou',
  '汽车': 'qiche',
  '游戏': 'youxi',
  '登录': 'denglu',
  '科技': 'keji',
  '网店': 'wangdian',
  '职业，求职类': 'zhiye',
  '音乐': 'yinyue',
};

// 爬虫残留与系统垃圾文件，不入库。
const SKIP_FILES = new Set(['_done.marker', 'Thumbs.db', '.DS_Store', 'desktop.ini']);

/** 递归列出目录下全部文件（相对路径，/ 分隔），跳过 SKIP_FILES。 */
async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else if (e.isFile() && !SKIP_FILES.has(e.name)) out.push(rel);
  }
  return out;
}

const conn = await mysql.createConnection({
  charset: 'utf8mb4',
  database: process.env.MYSQL_DATABASE || 'minepage',
  host: process.env.MYSQL_HOST || '127.0.0.1',
  password: process.env.MYSQL_PASSWORD,
  port: +(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'minepage',
});

const t0 = Date.now();
const iso = () => new Date().toISOString();
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

// owner：优先管理员，其次任意已有用户。
let ownerId = null;
{
  const [admins] = await conn.query('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1');
  if (admins[0]) ownerId = admins[0].id;
  else {
    const [users] = await conn.query('SELECT id FROM users ORDER BY id LIMIT 1');
    if (users[0]) ownerId = users[0].id;
  }
}
if (ownerId == null) throw new Error('库里一个用户都没有，先启动一次平台建管理员再跑。');

/**
 * 站名已存在就跳过（单事务写入的站要么完整要么没有，可直接信任），实现断点续跑；
 * FORCE=1 时改为先删（site_files 级联）再重建。
 */
async function clearIfExists(name) {
  const [rows] = await conn.query('SELECT id FROM sites WHERE name = ?', [name]);
  if (rows[0] && !process.env.FORCE) return 'skip';
  if (rows[0]) await conn.query('DELETE FROM sites WHERE id = ?', [rows[0].id]);
  return 'ok';
}

/**
 * 一个模板站 → sites 一行 + site_files 若干行（单事务）。
 * entries: [{ src, dst }] —— src 相对 dir 的原路径，dst 入库 path（散文件统一改 index.html）。
 */
async function importUnit({ name, title, category, entries, dir }) {
  if ((await clearIfExists(name)) === 'skip') return { files: 0, size: 0, skip: true };

  // 先 stat 一遍算总大小（不读内容），sites.size 一次写对。
  let total = 0;
  for (const { src } of entries) total += (await stat(path.join(dir, src))).size;

  const now = iso();
  await conn.beginTransaction();
  try {
    const [res] = await conn.query(
      `INSERT INTO sites (name, owner_id, html, size, status, title, description, tag, category, created_at, updated_at)
       VALUES (?, ?, '', ?, 'offline', ?, '', '', ?, ?, ?)`,
      [name, ownerId, total, title, category, now, now],
    );
    const siteId = res.insertId;

    let batch = [];
    let bytes = 0;
    let count = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await conn.query(
        'INSERT INTO site_files (site_id, path, content, size, updated_at) VALUES ?',
        [batch],
      );
      batch = [];
      bytes = 0;
    };

    for (const { src, dst } of entries) {
      if (Buffer.byteLength(dst) > 200) {
        console.warn(`  ! 路径超长跳过: ${src}`);
        continue;
      }
      const buf = await readFile(path.join(dir, src));
      batch.push([siteId, dst, buf, buf.length, now]);
      bytes += buf.length;
      count++;
      if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await flush();
    }
    await flush(); // 收尾；含大文件时单包最大约 32MB+85MB < 256MB

    await conn.commit();
    return { files: count, size: total };
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

const categories = (await readdir(ROOT, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let unitSeq = 0;
let siteCount = 0;
let fileCount = 0;
let byteCount = 0;
const perCategory = {};

for (const cat of categories) {
  const code = SLUG[cat];
  if (!code) {
    console.warn(`! 未登记的分类，跳过: ${cat}`);
    continue;
  }
  const catDir = path.join(ROOT, cat);
  // 二级模板目录 + 分类根下散落的 html，混合排序后统一编号。
  const entries = (await readdir(catDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() || (e.isFile() && e.name.toLowerCase().endsWith('.html')))
    .sort((a, b) => a.name.localeCompare(b.name));

  let catSites = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = `tp-${code}-${String(i + 1).padStart(2, '0')}`;
    let dir = path.join(catDir, e.name);

    let fileEntries;
    let title;
    if (e.isDirectory()) {
      const rels = await walk(dir);
      if (rels.length === 0) {
        console.warn(`  ! 空模板跳过: ${cat}/${e.name}`);
        continue;
      }
      fileEntries = rels.map((r) => ({ src: r, dst: r }));
      title = e.name;
    } else {
      // 散文件在分类根下，dir 不能指到文件本身（否则会拼出 file/file 的路径）。
      dir = catDir;
      fileEntries = [{ src: e.name, dst: 'index.html' }];
      title = e.name.replace(/\.html?$/i, '');
    }

    const r = await importUnit({ name, title, category: cat, entries: fileEntries, dir });
    unitSeq++;
    if (r.skip) {
      console.log(`[skip] ${name} 已存在，跳过`);
      continue;
    }
    siteCount++;
    fileCount += r.files;
    byteCount += r.size;
    catSites++;
    console.log(`[${unitSeq}] ${name}  ${title}  files=${r.files} size=${mb(r.size)}`);
  }
  perCategory[cat] = catSites;
  console.log(`== 分类 ${cat}: ${catSites} 个站 ==`);
}

console.log('\n==== 导入完成 ====');
console.log(JSON.stringify({ siteCount, fileCount, byteCount, mb: mb(byteCount), perCategory }, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
await conn.end();
