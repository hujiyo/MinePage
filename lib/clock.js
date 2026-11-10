// 自然日标签：全站的时间「今天」都按 UTC+8 算，别在各处各写一份偏移量。
// 存库的时间戳仍然是 ISO 字符串（见 lib/db.js），这里只负责「哪一天」这种粗粒度归属。

const UTC8_OFFSET_MS = 8 * 3600_000;

/** 某时刻所属的自然日（UTC+8），格式 YYYY-MM-DD。 */
export function dayKey(at = new Date()) {
  return new Date(at.getTime() + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}
