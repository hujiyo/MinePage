// 对话里的图片附件：用户上传 / 粘贴到对话栏的图。
//
// ============ 体积策略（2026-11 重做）============
//
// 实测结论（对本项目当前网关 amr-link.open-design.ai）：
//   - 字节上限在 9.6 MB ~ 10 MB 之间（10.01 MB 就 400 upstream_error）
//   - **像素几乎没有限制**：8000×6000 = 48 MP 的纯色图（137 KB）能正常返回
//   - 所以限制的瓶颈是**字节**，不是像素
//
// 但「能用满」不等于「该用满」：8.8 MB 的图要 11.3 秒才返回，
// 而 300 KB 的图只要 5 秒；token 还按像素算。所以分三层：
//
//   ① 准入（这里）：原始文件 ≤ 20 MB、像素 ≤ 40 MP，超了直接拒
//   ② 归一化（前端 canvas）：长边缩到 2048、JPEG 0.9 → 通常 150–400 KB
//   ③ 投影（发送前，前端）：超过 1 MB 就按质量阶梯 0.9/0.8/0.65 再压
//
// 为什么压缩放在前端：本项目零依赖，服务端没有 sharp；
// 而浏览器天生能解码 + 缩放 + 重编码。顺带省掉 10 倍上传流量和服务器 CPU。
//
// 存哪：库里的 agent_attachments 表（MEDIUMBLOB）。
// 内容寻址：同一个站里同一张图（sha256 相同）只存一份，重复粘贴直接复用 id。
//
// 生命周期：随站点级联删除（外键 site_id）；过期清理交给定时任务。

import { createHash } from 'node:crypto';
import {
  ATTACH_MAX_BYTES,
  ATTACH_MAX_PER_MESSAGE,
  ATTACH_MAX_PIXELS,
  ATTACH_USER_QUOTA_BYTES,
} from '../config.js';
import { get, all, run } from '../db.js';

const nowIso = () => new Date().toISOString();

// 准入上限（从 config 来，可用环境变量调）
export const MAX_ATTACHMENT_BYTES = ATTACH_MAX_BYTES;
export const MAX_ATTACHMENT_PIXELS = ATTACH_MAX_PIXELS;
export const MAX_ATTACHMENTS_PER_MESSAGE = ATTACH_MAX_PER_MESSAGE;

// 只接受这三种。**故意不支持 GIF**：
// 前端 canvas 会把 GIF 变成静态第一帧，而动图对「看图改页面」也没意义；
// 与其让用户发出去发现不动了，不如在入口就说清楚。
const MIME_WHITELIST = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * 按文件头嗅探图片类型，不信任客户端声明的 Content-Type。
 * 只认这三种；其它一律拒绝（尤其要挡住 SVG —— SVG 能带脚本）。
 */
export function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // WEBP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';

  return null;
}

/**
 * 从文件头读出像素尺寸，不解码图像。
 *
 * 为什么要读：40 MP 的图解码会吃掉 120 MB 内存，在入口拦掉比事后处理划算。
 * 只解析 PNG 的 IHDR 和 JPEG 的 SOF 段 —— 这两个足够覆盖实际会遇到的格式。
 * 读不出来就返回 null，调用方按「不拦」处理（宁可放过，不要误伤）。
 */
export function sniffImageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;

  // PNG：IHDR 紧跟着 8 字节签名 + 4 字节长度 + 4 字节类型
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    // 偏移 16 = 宽，20 = 高（都是大端 uint32）
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG：扫 SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1];
      // SOF 段：C0-C3, C5-C7, C9-CB, CD-CF（排除 C4 DHT / C8 JPG / CC DAC）
      const isSOF = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        // 段结构：FF Cn | len(2) | precision(1) | height(2) | width(2)
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      // 其它段：跳过（段头后 2 字节是长度，含自身）
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
  }

  // WEBP：VP8 / VP8L / VP8X 三种头，结构各不相同。这里不解析，
  // 交给「字节数」这道闸兜底（WEBP 通常比同尺寸 PNG 小得多）。
  return null;
}

/** 某个站某个用户当前占用了多少附件空间。 */
export async function attachmentUsage(userId) {
  const row = await get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM agent_attachments WHERE user_id = ?',
    userId,
  );
  return { count: Number(row?.c ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * 存一张图，返回 { id, mime, size, deduped }。
 *
 * 去重粒度是「同一个站」：不同站的同一张图各存一份（删站时不会互相牵连），
 * 但用户在同一个草稿里反复粘贴同一张截图只占一份空间。
 */
export async function saveAttachment({ siteId, threadId, userId, bytes }) {
  const mime = sniffImageMime(bytes);
  if (!mime) {
    throw Object.assign(
      new Error('只支持 PNG / JPEG / WEBP 图片（不支持 GIF 和 SVG）'),
      { code: 'BAD_IMAGE' },
    );
  }
  if (!MIME_WHITELIST.has(mime)) {
    throw Object.assign(new Error('这个图片格式不支持'), { code: 'BAD_IMAGE' });
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(
      new Error(`图片太大了，单张上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`),
      { code: 'IMAGE_TOO_LARGE' },
    );
  }

  // 像素闸：只对能读出来的格式生效（PNG / JPEG）
  const dim = sniffImageSize(bytes);
  if (dim && dim.width > 0 && dim.height > 0) {
    const pixels = dim.width * dim.height;
    if (pixels > MAX_ATTACHMENT_PIXELS) {
      throw Object.assign(
        new Error(
          `图片像素太多了（${dim.width}×${dim.height}），`
          + `上限 ${Math.round(MAX_ATTACHMENT_PIXELS / 1_000_000)} MP`,
        ),
        { code: 'IMAGE_TOO_MANY_PIXELS' },
      );
    }
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // 同站同图：直接复用已有 id（内容寻址）
  const existing = await get(
    'SELECT id, mime, size FROM agent_attachments WHERE site_id = ? AND sha256 = ? LIMIT 1',
    siteId, sha256,
  );
  if (existing) {
    return { id: Number(existing.id), mime: existing.mime, size: Number(existing.size), deduped: true };
  }

  // 配额：超了就拒，不要让单个用户把库撑爆
  const usage = await attachmentUsage(userId);
  if (usage.bytes + bytes.length > ATTACH_USER_QUOTA_BYTES) {
    throw Object.assign(
      new Error(
        `图片空间用完了（每人 ${Math.round(ATTACH_USER_QUOTA_BYTES / 1024 / 1024)} MB），`
        + '删掉一些旧草稿再试',
      ),
      { code: 'ATTACH_QUOTA_EXCEEDED', used: usage.bytes, limit: ATTACH_USER_QUOTA_BYTES },
    );
  }

  const result = await run(
    `INSERT INTO agent_attachments (site_id, thread_id, user_id, mime, size, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    siteId, threadId ?? null, userId, mime, bytes.length, sha256, bytes, nowIso(),
  );
  return {
    id: Number(result.lastInsertRowid),
    mime,
    size: bytes.length,
    deduped: false,
    width: dim?.width ?? null,
    height: dim?.height ?? null,
  };
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
 * 代价是 base64 让体积膨胀 1/3 —— 这也是「归一化到 2048」的原因：
 * 300 KB 的图变成 400 KB 的 base64，一张请求带 6 张也只有 2.4 MB。
 */
export function toImagePart(mime, bytes) {
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` },
  };
}

/** 清掉超过 N 天的图（定时任务调用）。 */
export async function pruneAttachments(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const result = await run('DELETE FROM agent_attachments WHERE created_at < ?', cutoff);
  return result.changes;
}

export { ATTACH_USER_QUOTA_BYTES };
