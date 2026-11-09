import { randomUUID } from 'node:crypto';

import {
  COIN_DAILY,
  COIN_REGISTER_BONUS,
  MAX_COINS_PER_SITE,
  MAX_SITES_PER_USER,
  QUOTA_COINS_PER_SLOT,
} from './config.js';
import { dayKey } from './clock.js';
import { all, get, isDuplicateError, run, withTransaction } from './db.js';

const nowIso = () => new Date().toISOString();

/** 硬币：余额 / 流水 / 投币记录 / 配额兑换。
 *  只做数据操作，鉴权与参数校验在 server.js 的接口层。
 *
 *  两条不变式（改动这一层时别破坏）：
 *  1. users.coin_balance 是缓存，coin_ledger 是事实。任何改余额的地方必须同时写一条流水，
 *     且都发生在 withTransaction 里。
 *  2. coin_charges 只增不改、没有删除路径。页面「收到多少枚」是永久记录，
 *     作者花掉自己的币不会让它变小。 */

// ---------------------------------------------------------------- 基础

/** 自然日标签（UTC+8），签到防重与每日发币都按它算。 */
export function todayKey() {
  return dayKey();
}

/** 记一条流水。tx 是 withTransaction 里的 tx（余额与流水必须在同一事务）。
 *  ref 用于幂等：签到传当天日期，其余传一次性随机串。
 *  siteId / fromUserId 只对投币相关流水有值：
 *  投币者那条记 siteId，作者那条记 siteId + fromUserId（通知流直接读，不再靠 ref 反查）。 */
export async function recordLedger(tx, { userId, delta, reason, ref, siteId = null, fromUserId = null }) {
  await tx.run(
    `INSERT INTO coin_ledger (user_id, delta, reason, ref, site_id, from_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId,
    delta,
    reason,
    ref,
    siteId,
    fromUserId,
    nowIso(),
  );
}

/** 事务内读余额。事务外不要再调 coinBalance：池子上可能读到未提交的行。 */
async function balanceWithin(tx, userId) {
  const row = await tx.get('SELECT coin_balance AS b FROM users WHERE id = ?', userId);
  return Number(row?.b ?? 0);
}

export async function coinBalance(userId) {
  if (!userId) return 0;
  const row = await get('SELECT coin_balance AS b FROM users WHERE id = ?', userId);
  return Number(row?.b ?? 0);
}

/** 流水明细（新→旧），供账号页展示。 */
export async function listLedger(userId, limit = 30) {
  return all(
    'SELECT delta, reason, ref, site_id, created_at FROM coin_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    userId,
    limit,
  );
}

// ---------------------------------------------------------------- 发币

/** 注册赠送。调用方在 createUser 的事务里调，保证建号与赠币一起成功或一起回滚。 */
export async function grantRegisterBonus(tx, userId) {
  await tx.run('UPDATE users SET coin_balance = coin_balance + ? WHERE id = ?', COIN_REGISTER_BONUS, userId);
  await recordLedger(tx, { userId, delta: COIN_REGISTER_BONUS, reason: 'register', ref: 'welcome' });
  return COIN_REGISTER_BONUS;
}

/**
 * 每日首次访问发币。/api/me 每次页面加载都会调，所以热路径先做一次只读查询：
 * 当天已经领过就直接返回，不写库。未领过才开事务。
 *
 * 并发重复领取由 coin_ledger 的 UNIQUE(user_id, reason, ref) 兜住：
 * 两个请求同时进事务，后者插入撞唯一键，按「今天已经领过了」处理。
 */
export async function claimDailyCoin(userId) {
  const today = todayKey();
  const seen = await get(
    "SELECT 1 AS x FROM coin_ledger WHERE user_id = ? AND reason = 'signin' AND ref = ?",
    userId,
    today,
  );
  if (seen) return { granted: 0, balance: await coinBalance(userId) };

  try {
    await withTransaction(async (tx) => {
      await tx.run('SELECT id FROM users WHERE id = ? FOR UPDATE', userId);
      await tx.run('UPDATE users SET coin_balance = coin_balance + ? WHERE id = ?', COIN_DAILY, userId);
      await recordLedger(tx, { userId, delta: COIN_DAILY, reason: 'signin', ref: today });
    });
    return { granted: COIN_DAILY, balance: await coinBalance(userId) };
  } catch (err) {
    // 唯一键冲突 = 另一个并发请求刚领过，今天确实已经领了，不是错误
    if (isDuplicateError(err)) return { granted: 0, balance: await coinBalance(userId) };
    throw err;
  }
}

// ---------------------------------------------------------------- 投币

/**
 * 投币：投币者扣 n 枚，作者等额入账（1:1，无抽成），页面收币总量永久累加。
 *
 * 并发安全靠三件事：
 *   1. 按 id 升序锁两行 users —— 投币者与作者可能同时反向操作，固定顺序才不会死锁。
 *   2. 扣款用带条件的 UPDATE（WHERE coin_balance >= n），affectedRows = 0 即余额不足。
 *      不能先 SELECT 余额再 UPDATE：中间有并发窗口，两个请求都能过检查。
 *   3. coin_charges 一行一锁，同一人对同一站的并发累加被串行化。
 */
export async function chargeCoins({ siteId, siteOwnerId, giverId, count }) {
  return withTransaction(async (tx) => {
    const lo = Math.min(giverId, siteOwnerId);
    const hi = Math.max(giverId, siteOwnerId);
    const locked = await tx.all(
      'SELECT id, coin_balance FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE',
      lo,
      hi,
    );
    const giver = locked.find((row) => Number(row.id) === giverId);
    const balance = Number(giver?.coin_balance ?? 0);

    const prior = await tx.get(
      'SELECT count FROM coin_charges WHERE site_id = ? AND user_id = ? FOR UPDATE',
      siteId,
      giverId,
    );
    const already = Number(prior?.count ?? 0);
    if (already + count > MAX_COINS_PER_SITE) {
      throw Object.assign(
        new Error(`每个页面最多投 ${MAX_COINS_PER_SITE} 枚，你已经投了 ${already} 枚`),
        { code: 'COIN_LIMIT' },
      );
    }

    const debited = await tx.run(
      'UPDATE users SET coin_balance = coin_balance - ? WHERE id = ? AND coin_balance >= ?',
      count,
      giverId,
      count,
    );
    if (debited.changes === 0) {
      throw Object.assign(new Error(`硬币不够，你现在有 ${balance} 枚`), {
        code: 'COIN_SHORT',
        balance,
      });
    }

    await tx.run('UPDATE users SET coin_balance = coin_balance + ? WHERE id = ?', count, siteOwnerId);
    await recordLedger(tx, { userId: giverId, delta: -count, reason: 'charge', ref: randomUUID(), siteId });
    await recordLedger(tx, {
      userId: siteOwnerId,
      delta: count,
      reason: 'received',
      ref: randomUUID(),
      siteId,
      fromUserId: giverId,
    });

    await tx.run(
      // 列名必须带 coin_charges. 前缀：右值里的裸 count 会和别名 new 的字段撞上（ER_NON_UNIQ_ERROR）
      `INSERT INTO coin_charges (site_id, user_id, count, updated_at) VALUES (?, ?, ?, ?)
         AS new ON DUPLICATE KEY UPDATE count = coin_charges.count + new.count, updated_at = new.updated_at`,
      siteId,
      giverId,
      count,
      nowIso(),
    );

    // 同一个事务里读，避免走池子拿到未提交的快照
    const total = Number(
      (await tx.get('SELECT COALESCE(SUM(count), 0) AS c FROM coin_charges WHERE site_id = ?', siteId))?.c ?? 0,
    );

    return {
      coins: total,
      myCoins: already + count,
      balance: await balanceWithin(tx, giverId),
    };
  });
}

// ---------------------------------------------------------------- 配额

/** 站点配额 = 基础配额 + 已兑换份数。只从流水推导，不另存字段，余额与配额只有一个事实源。
 *  q 传 {get} 或事务里的 tx：ZIP 发布在事务内校验，必须用 tx 才能读到同一快照。 */
export async function siteQuota(ownerId, q = { get }) {
  const row = await q.get(
    "SELECT COUNT(*) AS c FROM coin_ledger WHERE user_id = ? AND reason = 'quota'",
    ownerId,
  );
  return MAX_SITES_PER_USER + Number(row?.c ?? 0);
}

/** 花硬币换一份额外站点配额。扣款同样用带条件的 UPDATE，余额不足就不动。 */
export async function redeemQuotaSlot(userId) {
  return withTransaction(async (tx) => {
    const locked = await tx.get('SELECT coin_balance FROM users WHERE id = ? FOR UPDATE', userId);
    const balance = Number(locked?.coin_balance ?? 0);
    if (balance < QUOTA_COINS_PER_SLOT) {
      throw Object.assign(
        new Error(`兑换需要 ${QUOTA_COINS_PER_SLOT} 枚硬币，你现在有 ${balance} 枚`),
        { code: 'COIN_SHORT', balance },
      );
    }

    await tx.run(
      'UPDATE users SET coin_balance = coin_balance - ? WHERE id = ?',
      QUOTA_COINS_PER_SLOT,
      userId,
    );
    await recordLedger(tx, { userId, delta: -QUOTA_COINS_PER_SLOT, reason: 'quota', ref: randomUUID() });

    return {
      balance: await balanceWithin(tx, userId),
      quota: await siteQuota(userId, tx),
    };
  });
}

/** 某用户名下所有站点收到的硬币总数（创作者主页用）。 */
export async function coinsReceived(ownerId) {
  const row = await get(
    `SELECT COALESCE(SUM(c.count), 0) AS total
       FROM coin_charges c
       JOIN sites s ON s.id = c.site_id
      WHERE s.owner_id = ? AND s.status = 'active'`,
    ownerId,
  );
  return Number(row?.total ?? 0);
}
