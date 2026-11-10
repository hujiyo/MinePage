import { MAX_COVER_BYTES } from './config.js';
import { get, run } from './db.js';

const nowIso = () => new Date().toISOString();

/** 卡片自定义封面：一站一张，图片字节整张存在 site_covers 里。
 *  只做数据操作，鉴权与路由在 server.js 的接口层。 */

// 按文件头认类型，不信 Content-Type（浏览器和客户端都能随便编）。
// 认不出来就返回 null，调用方据此回 400。
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 嗅探图片类型：png / jpeg / gif / webp，返回 mime 或 null。 */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;

  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';

  // webp：RIFF....WEBP，偏移 8 起才是格式标识，至少要 12 字节才够判
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/** 写入/覆盖一个站点的封面。类型不认抛 INVALID_IMAGE，超限抛 TOO_LARGE。 */
export async function setSiteCover(siteId, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length === 0) {
    throw Object.assign(new Error('封面上传内容为空'), { code: 'INVALID_IMAGE' });
  }
  if (buf.length > MAX_COVER_BYTES) {
    throw Object.assign(new Error(`封面超过 ${MAX_COVER_BYTES} 字节上限`), { code: 'TOO_LARGE' });
  }

  const mime = sniffImageType(buf);
  if (!mime) {
    throw Object.assign(new Error('不是 png / jpg / webp / gif 图片'), { code: 'INVALID_IMAGE' });
  }

  // MySQL 8 的别名语法，和 site_files 的 upsert 保持同一套写法
  await run(
    `INSERT INTO site_covers (site_id, mime, size, bytes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     AS new ON DUPLICATE KEY UPDATE mime = new.mime, size = new.size, bytes = new.bytes, updated_at = new.updated_at`,
    siteId,
    mime,
    buf.length,
    buf,
    nowIso(),
  );

  return { mime, size: buf.length };
}

/** 取一个站点的封面（含字节），没有返回 null。 */
export async function getSiteCover(siteId) {
  const row = await get('SELECT mime, size, bytes, updated_at FROM site_covers WHERE site_id = ?', siteId);
  if (!row) return null;

  return {
    mime: row.mime,
    size: Number(row.size),
    bytes: Buffer.from(row.bytes),
    updatedAt: row.updated_at,
  };
}

/** 这个站点有没有封面（只看有没有行，不读 BLOB）。 */
export async function siteHasCover(siteId) {
  return Boolean(await get('SELECT 1 AS x FROM site_covers WHERE site_id = ?', siteId));
}

export async function removeSiteCover(siteId) {
  return (await run('DELETE FROM site_covers WHERE site_id = ?', siteId)).changes;
}
