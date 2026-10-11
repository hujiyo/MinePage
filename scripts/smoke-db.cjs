// 冒烟测试：mysql2 连库 + 90MB 大包插入/读回（验证 LONGBLOB + 256MB packet 真的可用）。
const m = require('mysql2/promise');
(async () => {
  console.log('mysql2 loaded:', typeof m.createConnection);
  const c = await m.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: +(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  const [rows] = await c.query('SELECT COUNT(*) AS c FROM sites');
  const [pkt] = await c.query('SELECT @@max_allowed_packet AS p');
  console.log('连接OK, sites数:', rows[0].c, 'packet:', pkt[0].p);

  // 大包测试：90MB blob（超过旧的 64MB 限制），插入后读回校验长度，最后清理。
  const now = new Date().toISOString();
  const [ins] = await c.query(
    `INSERT INTO sites (name, owner_id, html, size, status, title, description, tag, category, created_at, updated_at)
     VALUES ('tp-smoke-pkt', NULL, '', 0, 'offline', 'smoke', '', '', '', ?, ?)`,
    [now, now],
  );
  const big = Buffer.alloc(90 * 1024 * 1024, 97); // 90MB of 'a'
  await c.query(
    'INSERT INTO site_files (site_id, path, content, size, updated_at) VALUES (?, ?, ?, ?, ?)',
    [ins.insertId, 'big.bin', big, big.length, now],
  );
  const [[r]] = await c.query('SELECT LENGTH(content) AS len FROM site_files WHERE site_id = ?', [ins.insertId]);
  console.log('90MB大包插入/读回:', r.len === big.length ? 'OK' : `FAIL len=${r.len}`);
  await c.query('DELETE FROM sites WHERE id = ?', [ins.insertId]);
  console.log('清理完成');
  await c.end();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
