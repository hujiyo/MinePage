// 最小 ZIP 打包器（零第三方依赖，与 lib/zip.js 的解析器配套）。
//
// 只做「写」这一半：把 [{ path, content }] 打成标准的 zip，Windows 资源管理器、
// macOS 归档工具、`unzip` 都能直接解。
//
// 为什么不引 archiver / jszip：整个项目的风格是零依赖（MCP 手写 JSON-RPC、
// 解包手写 ZIP 解析器），为一个导出功能加包会破坏一致性；而 Node 内置
// zlib.deflateRawSync 已经提供了压缩能力，这里只差一个 CRC32 和一个目录结构。
//
// 支持：
//   - deflate(8) 与 stored(0) 两种压缩方式
//   - UTF-8 文件名（置通用标志位 bit 11，中文路径不会乱码）
//   - 目录条目（path 以 / 结尾时）
// 不支持（用不到，遇到也不该出现）：
//   - ZIP64（>4GB 或 >65535 个条目）
//   - 加密、多卷

import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';

// Node 20.15+ 有 zlib.crc32；没有就退回内置查表实现，保证老 Node 也能跑。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32Fallback(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const crc32 = typeof zlibCrc32 === 'function' ? zlibCrc32 : crc32Fallback;

/** DOS 时间格式（zip 里存的是 1980 起的日期，秒只有 2 秒精度）。 */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 把若干文件打成 zip。
 *
 * @param {Array<{path: string, content: Buffer|string}>} entries
 *   路径用 / 分隔；以 / 结尾表示目录条目。
 * @param {object} [opt]
 * @param {boolean} [opt.compress=true]  true 用 deflate，false 全用 stored
 * @param {Date}    [opt.mtime]          条目时间，默认现在
 * @returns {Buffer}
 */
export function buildZip(entries, { compress = true, mtime = new Date() } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('没有可以打包的文件');
  }

  const { time, date } = dosDateTime(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;
  let count = 0;

  for (const entry of entries) {
    const name = String(entry.path ?? '').replace(/\\/g, '/');
    if (!name) continue;

    const isDir = name.endsWith('/');
    const raw = isDir
      ? Buffer.alloc(0)
      : (Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ''), 'utf8'));

    // 空文件和小文件压缩收益不稳定，但文本类（html/css/js）压缩率通常 70%+，
    // 所以只要 compress 打开就一律压；压完反而更大时退回 stored。
    let method = 0;
    let body = raw;
    if (compress && !isDir && raw.length > 0) {
      const deflated = deflateRawSync(raw);
      if (deflated.length < raw.length) {
        method = 8;
        body = deflated;
      }
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const flags = 0x0800; // bit 11：文件名是 UTF-8
    const sum = crc32(raw);

    // ---- 本地文件头 ----
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 签名
    local.writeUInt16LE(20, 4);           // 解压所需版本
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18); // 压缩后
    local.writeUInt32LE(raw.length, 22);  // 解压后
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra 长度

    locals.push(local, nameBuf, body);

    // ---- 中央目录项 ----
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 签名
    central.writeUInt16LE(20, 4);         // 创建版本
    central.writeUInt16LE(20, 6);         // 解压所需版本
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // 磁盘号
    central.writeUInt16LE(0, 36);         // 内部属性
    central.writeUInt32LE(isDir ? 0x10 : 0, 38); // 外部属性：目录位
    central.writeUInt32LE(offset, 42);    // 对应本地头的偏移

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
    count += 1;
  }

  if (count === 0) throw new Error('没有可以打包的文件');

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);              // 本卷号
  eocd.writeUInt16LE(0, 6);              // 起始卷
  eocd.writeUInt16LE(count, 8);          // 本卷条目数
  eocd.writeUInt16LE(count, 10);         // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);        // 中央目录起始偏移
  eocd.writeUInt16LE(0, 20);             // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * 给一组站点文件路径补上目录条目。
 * 有的解压工具（老版 WinRAR）对「只有文件没有目录」的包处理不好，
 * 显式补上目录条目最稳。test 用不着，导出时调一下就行。
 */
export function withDirs(entries) {
  const dirs = new Set();
  for (const e of entries) {
    const parts = String(e.path).split('/');
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join('/') + '/');
    }
  }
  const existing = new Set(entries.map((e) => e.path));
  const extra = [...dirs].filter((d) => !existing.has(d)).map((path) => ({ path, content: Buffer.alloc(0) }));
  // 目录排在前面，文件保持原来的顺序
  return [...extra.sort(), ...entries];
}
