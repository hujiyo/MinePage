// 最小 ZIP 解析器（零第三方依赖，双版本共用，改动请两边同步）。
// 只支持最常见的两种压缩方式：stored(0) 与 deflate(8)——覆盖日常网页打包的 99%+；
// 加密、ZIP64、bzip2 等偏门条目直接跳过并记入 skipped，不整包失败。
//
// 安全约束（防 zip 炸弹 / zip slip）：
//   - 条目数上限 maxEntries
//   - 单条目解压后字节上限 maxEntryBytes（inflateRawSync 带 maxOutputLength，超了抛错→跳过该条目）
//   - 整包解压累计上限 maxTotalBytes，超过即停，后面的条目全部不收
//   - 路径本身不做合法性判断，交给调用方的 isValidSitePath（它连垃圾文件黑名单一起管）

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * 解析 zip 字节流。
 * 返回 { entries: [{ path, content, method }], skipped: [{ path, reason }] }
 * zip 结构本身坏掉（找不到目录、签名不对）时抛错，调用方回 400。
 */
export function parseZip(buf, { maxEntries = 5000, maxEntryBytes = 90 * 1024 * 1024, maxTotalBytes = 512 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('内容不是有效的 zip');

  // 从尾部回扫找 EOCD（中央目录结束记录），其后可能有注释，最多回扫 64KB+22
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构损坏（找不到目录结束标记）');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdirOffset = buf.readUInt32LE(eocd + 16);
  if (cdirOffset + 4 > buf.length) throw new Error('zip 结构损坏（目录偏移越界）');

  const entries = [];
  const skipped = [];
  let offset = cdirOffset;
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CDIR_SIG) {
      throw new Error('zip 结构损坏（中央目录不完整）');
    }

    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const rawName = buf.subarray(offset + 46, offset + 46 + nameLen);
    const name = rawName.toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (entries.length >= maxEntries) { skipped.push({ path: name, reason: '条目数超上限' }); continue; }
    if (name.endsWith('/') || name.length === 0) continue; // 目录条目，跳过
    // Windows 打包的 zip 常用反斜杠分隔，先归一成 /
    const path = name.replace(/\\/g, '/');

    if (flags & 0x1) { skipped.push({ path, reason: '加密条目不支持' }); continue; }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) { skipped.push({ path, reason: 'ZIP64 不支持' }); continue; }
    if (uncompSize > maxEntryBytes) { skipped.push({ path, reason: '超过单文件上限' }); continue; }
    if (totalBytes + uncompSize > maxTotalBytes) { skipped.push({ path, reason: '整包解压超总容量上限' }); continue; }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      skipped.push({ path, reason: '本地头损坏' });
      continue;
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) { skipped.push({ path, reason: '数据区越界' }); continue; }
    const raw = buf.subarray(dataStart, dataEnd);

    let content;
    if (method === 0) {
      content = Buffer.from(raw);
    } else if (method === 8) {
      try {
        content = inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      } catch (err) {
        skipped.push({ path, reason: '解压失败或超过单文件上限' });
        continue;
      }
    } else {
      skipped.push({ path, reason: `不支持的压缩方式(${method})` });
      continue;
    }

    totalBytes += content.length;
    entries.push({ path, content, method });
  }

  // 单一根目录包裹（网页打包最常见：整包都在 site/ 下）时剥掉一层，
  // 否则发布后入口是 site/index.html，页内相对链接却按 /站名/ 解析，全站错位。
  // 判定只看"像正常相对路径"的条目：含 .. 段的（zip slip 候选）不参与投票，
  // 免得一个坏条目就让整包放弃剥根。
  if (entries.length > 0) {
    const firstSegs = new Set();
    let allNested = true;
    let voters = 0;
    for (const e of entries) {
      const segs = e.path.split('/');
      if (segs.some((s) => s === '..' || s === '')) continue;
      const i = e.path.indexOf('/');
      if (i < 1) { allNested = false; break; }
      firstSegs.add(e.path.slice(0, i));
      voters++;
    }
    if (allNested && voters > 0 && firstSegs.size === 1) {
      const prefix = `${[...firstSegs][0]}/`;
      for (const e of entries) if (e.path.startsWith(prefix)) e.path = e.path.slice(prefix.length);
      for (const s of skipped) if (s.path.startsWith(prefix)) s.path = s.path.slice(prefix.length);
    }
  }

  return { entries, skipped };
}
