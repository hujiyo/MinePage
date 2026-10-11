// 只在隔离库运行：让第二个文件的 SQL 参数编码失败，验证事务回滚。
import { closeDb, get, run } from '../lib/db.js';
import { publishSiteZip } from '../lib/sites.js';

if (process.env.MYSQL_DATABASE !== 'minepage_smoke') {
  throw new Error('zip-rollback-smoke 只允许 MYSQL_DATABASE=minepage_smoke');
}

const fresh = 'smoke-zip-rollback-new';
const existing = 'smoke-zip-rollback-existing';
const files = (html) => [
  { path: 'index.html', content: Buffer.from(html) },
  { path: 'fail.txt', content: {
    length: 1,
    toSqlString() { throw new Error('forced zip failure'); },
  } },
];

async function expectWriteFailure(input) {
  try {
    await publishSiteZip(input);
  } catch (error) {
    if (error.message === 'forced zip failure') return;
    throw error;
  }
  throw new Error('预期第二个文件写入失败，但发布成功了');
}

try {
  const owner = await get('SELECT id FROM users ORDER BY id LIMIT 1');
  if (!owner) throw new Error('先运行 api-smoke.mjs 创建测试账号');
  await run('DELETE FROM sites WHERE name IN (?, ?)', fresh, existing);
  await publishSiteZip({
    name: existing, ownerId: owner.id, isAdmin: true,
    entries: [{ path: 'index.html', content: Buffer.from('original') }], skipped: [],
  });

  await expectWriteFailure({ name: fresh, ownerId: owner.id, isAdmin: true, entries: files('new'), skipped: [] });
  if (await get('SELECT id FROM sites WHERE name = ?', fresh)) {
    throw new Error('新站点写入失败后仍留在数据库');
  }
  console.log('✓ 新站点：第二个文件失败后，站点和第一个文件均回滚');

  await expectWriteFailure({ name: existing, ownerId: owner.id, isAdmin: true, entries: files('replacement'), skipped: [] });
  const saved = await get(
    'SELECT f.content FROM site_files f JOIN sites s ON s.id = f.site_id WHERE s.name = ? AND f.path = ?',
    existing, 'index.html',
  );
  if (saved?.content?.toString() !== 'original') {
    throw new Error('已有站点在失败后没有恢复旧文件');
  }
  console.log('✓ 已有站点：第二个文件失败后，第一个文件恢复原内容');
} finally {
  await run('DELETE FROM sites WHERE name IN (?, ?)', fresh, existing);
  await closeDb();
}
