// 对话里的图片附件：用户上传 / 粘贴到对话栏的图。
//
// 存哪：库里的 agent_attachments 表（MEDIUMBLOB）。
// 为什么不落磁盘：这个项目所有用户内容都在 MySQL 里（站点文件也是 BLOB），
// 单独开一个上传目录要额外管清理、备份、权限，反而更麻烦。
//
// 大小：单张 ≤ 4 MB。图片进了模型上下文是要按 base64 算 token 的，
// 再大既贵又慢；而且从截图复制过来的图大多在 1 MB 以内。
//
// 生命周期：随站点级联删除（外键 site_id）。会话删了图还留着 ——
// 用户可能只是想清空对话，不一定想丢图；过期清理交给定时任务。

import { get, all, run } from '../db.js';

const nowIso = () => new Date().toISOString();

// 单张图片上限 4 MB
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
// 一条消息最多带几张（多了模型也看不过来，而且 token 会爆）
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

// 只接受这几种：浏览器 <input accept> 和粘贴面板能给到的常见格式
const MIME_WHITELIST = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/**
 * 按文件头嗅探图片类型，不信任客户端声明的 Content-Type。
 * 只认这四种；其它一律拒绝（防止塞 SVG —— SVG 能带脚本）。
 */
export function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WEBP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';

  return null;
}

/** 存一张图，返回 { id, mime, size }。 */
export async function saveAttachment({ siteId, threadId, userId, bytes }) {
  const mime = sniffImageMime(bytes);
  if (!mime) {
    throw Object.assign(new Error('只支持 PNG / JPEG / WEBP / GIF 图片'), { code: 'BAD_IMAGE' });
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(
      new Error(`图片太大了，单张上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`),
      { code: 'IMAGE_TOO_LARGE' },
    );
  }
  if (!MIME_WHITELIST.has(mime)) {
    throw Object.assign(new Error('这个图片格式不支持'), { code: 'BAD_IMAGE' });
  }

  const result = await run(
    `INSERT INTO agent_attachments (site_id, thread_id, user_id, mime, size, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    siteId, threadId ?? null, userId, mime, bytes.length, bytes, nowIso(),
  );
  return { id: Number(result.lastInsertRowid), mime, size: bytes.length };
}

/** 取一张图（含字节），给前端 <img> 用。 */
export async function getAttachment(siteId, id) {
  return get(
    'SELECT id, site_id, thread_id, mime, size, bytes FROM agent_attachments WHERE id = ? AND site_id = ?',
    id, siteId,
  );
}

/** 批量取图（给历史消息渲染用），只返元信息不带字节。 */
export async function listAttachmentMeta(siteId, ids) {
  const clean = (ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return [];
  const rows = await all(
    `SELECT id, mime, size FROM agent_attachments
      WHERE site_id = ? AND id IN (${clean.map(() => '?').join(',')})`,
    siteId, ...clean,
  );
  // 保持传入顺序
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return clean.map((id) => byId.get(id)).filter(Boolean);
}

/** 取一批图的完整内容（构造多模态消息用）。 */
export async function loadAttachmentBytes(siteId, ids) {
  const clean = (ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return [];
  const rows = await all(
    `SELECT id, mime, bytes FROM agent_attachments
      WHERE site_id = ? AND id IN (${clean.map(() => '?').join(',')})`,
    siteId, ...clean,
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return clean
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({ id: Number(r.id), mime: r.mime, bytes: Buffer.from(r.bytes) }));
}

/**
 * 把一张图转成 OpenAI 多模态格式的 image_url。
 *
 * 用 data URL 而不是公网链接：草稿是私有的，图片不应该有可匿名访问的地址。
 * 代价是 base64 让体积膨胀 1/3，这也是单张限 4 MB 的原因之一。
 */
export function toImagePart(mime, bytes) {
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` },
  };
}

/** 清掉超过 7 天且没被任何消息引用的图（定时任务调用）。 */
export async function pruneAttachments(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const result = await run('DELETE FROM agent_attachments WHERE created_at < ?', cutoff);
  return result.changes;
}
