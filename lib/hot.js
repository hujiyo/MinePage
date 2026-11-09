// 热门搜索：把 /api/discover 的搜索词记下来，按最近几天的人气出榜。
//
// 设计取舍（改这一层前先读）：
// 1. 榜上列的是「整条查询」，不做分词。中文分词是给「相关内容」用的，
//    这里只需要知道「哪些词被很多人搜过」。
// 2. 一人一天只能给一个词投一票 —— 靠 UNIQUE(word, who, day) 挡住 F5 刷榜。
// 3. 上榜门槛是「不同的人」而不是「次数」。一个人搜十遍不该算热门，
//    更不该把某个人私下的搜索词公示给所有人看（这是隐私底线，不是调优参数）。
// 4. 没到门槛就返回空数组。前端见到空榜整段隐藏 —— 不拿标签冒充热门数据。
// 5. 屏蔽词在写入侧生效：被屏蔽的词不记录，已记录的连数据一起删掉。
//    所以聚合查询不需要再加一层过滤，屏蔽是立刻生效的。
import {
  HOT_CACHE_MS,
  HOT_LIMIT,
  HOT_MIN_SEARCHERS,
  HOT_WINDOW_DAYS,
} from './config.js';
import { dayKey, dayKeyBefore } from './clock.js';
import { all, get, run, withTransaction } from './db.js';

const nowIso = () => new Date().toISOString();

// 不当搜索词入库的东西：纯符号 / 纯数字 / 空白。
// 搜索接口本身接受任意 q，所以过滤只能放在记录这一侧 —— 榜上榜的是被记录下来的词。
const NON_WORD = /^[\s\p{P}\p{S}\p{N}]*$/u;
const URL_LIKE = /^(?:https?|ftp):\/\//i;

/** 这个词值不值得记录。返回 true 才算一条有效搜索。 */
export function isRecordableWord(word) {
  const w = String(word ?? '').trim();
  if (w.length < 2 || w.length > 50) return false;
  if (NON_WORD.test(w)) return false;
  if (URL_LIKE.test(w)) return false;
  return true;
}

/**
 * 记录一次搜索。who 是去重标识（登录用户 `user:<id>`，匿名访客 `anon:<cookie 里的随机 id>`）。
 * 同一天同一人同一个词只算一次：靠 UNIQUE(word, who, day) 兜住，重复插入直接忽略。
 */
export async function recordQuery(word, who) {
  if (!isRecordableWord(word)) return false;

  const blocked = await get('SELECT 1 AS x FROM search_blocklist WHERE word = ?', String(word).trim());
  if (blocked) return false;

  const result = await run(
    `INSERT INTO search_queries (word, who, day, created_at) VALUES (?, ?, ?, ?)
       AS new ON DUPLICATE KEY UPDATE word = new.word`,
    String(word).trim().slice(0, 50),
    String(who).slice(0, 64),
    dayKey(),
    nowIso(),
  );
  return result.changes > 0;
}

/** 清掉超出窗口的老记录。开机跑一次 + 每天跑一次，表里永远只有几天的量。 */
export async function pruneQueries() {
  return (await run('DELETE FROM search_queries WHERE day < ?', dayKeyBefore(HOT_WINDOW_DAYS))).changes;
}

let cache = { at: 0, items: [] };

/**
 * 热搜榜。返回 [{ word, people, hits }]：
 *   people —— 窗口内搜过它的不同人数（排序主键，也是上榜门槛）
 *   hits   —— 窗口内去重后的搜索条数（每人每天一条，所以它等于「人 × 天」）
 * 5 分钟内的重复请求直接吃缓存 —— 顶栏搜索下拉每开一次都会打这个接口。
 */
export async function hotWords() {
  if (Date.now() - cache.at < HOT_CACHE_MS) return cache.items;

  // 用派生表先算好两个计数再排：MySQL 的 HAVING 不能引用未出现在 GROUP BY 里的聚合别名之外的排序，
  // 这样写也省得把 COUNT(*) 再算第二遍。
  const rows = await all(
    `SELECT word, COUNT(DISTINCT who) AS people, COUNT(*) AS hits
       FROM search_queries
      WHERE day >= ?
      GROUP BY word
     HAVING people >= ?
      ORDER BY people DESC, hits DESC, word ASC
      LIMIT ?`,
    dayKeyBefore(HOT_WINDOW_DAYS),
    HOT_MIN_SEARCHERS,
    HOT_LIMIT,
  );

  const items = rows.map((r) => ({ word: r.word, people: Number(r.people), hits: Number(r.hits) }));
  cache = { at: Date.now(), items };
  return items;
}

/** 丢掉缓存。后台屏蔽 / 解封之后立即生效，不用等 5 分钟。 */
export function invalidateHotCache() {
  cache = { at: 0, items: [] };
}

// ---------------------------------------------------------------- 屏蔽词

/** 后台：全部屏蔽词，新→旧。 */
export async function listBlockedWords() {
  return all(
    `SELECT word, note, created_at AS createdAt FROM search_blocklist
      ORDER BY created_at DESC, word ASC`,
  );
}

/**
 * 加一个屏蔽词。同时把它已积累的记录删掉 —— 否则屏蔽完榜首还挂着它，
 * 要等 7 天窗口滑过去才消失。两件事在同一事务里做，不会出现「词进了黑名单但数据还在」的中间态。
 */
export async function blockWord(word, note = '') {
  const w = String(word).trim().slice(0, 50);
  if (!w) throw Object.assign(new Error('要填一个词'), { code: 'EMPTY_WORD' });

  await withTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO search_blocklist (word, note, created_at) VALUES (?, ?, ?)
         AS new ON DUPLICATE KEY UPDATE note = new.note`,
      w,
      String(note).trim().slice(0, 200),
      nowIso(),
    );
    await tx.run('DELETE FROM search_queries WHERE word = ?', w);
  });

  invalidateHotCache();
  return { word: w };
}

/** 解封：从黑名单拿掉，之后重新开始积累。已经删掉的历史数据不会回来。 */
export async function unblockWord(word) {
  const changes = (await run('DELETE FROM search_blocklist WHERE word = ?', String(word).trim())).changes;
  invalidateHotCache();
  return changes;
}
