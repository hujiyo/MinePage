// 邮箱验证码：生成、发送、校验。
// 验证码本身只存 sha256 哈希；校验失败累计 attempts，超过上限作废。
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { sendMail } from './email.js';
import {
  CODE_LENGTH,
  CODE_TTL_MINUTES,
  CODE_RESEND_COOLDOWN_SECONDS,
  CODE_MAX_ATTEMPTS,
} from './config.js';

/** 当前时间的 ISO 8601 字符串。email_codes 的 created_at / expires_at / consumed_at 都用这个格式，过期判断靠字符串比较。 */
const nowIso = () => new Date().toISOString();

// purpose → 邮件主题。新加验证码场景时在这里登记。
// key 同时是 email_codes.purpose 的取值，也是接口 ?purpose= 的参数值；issueCode 遇到未登记的用途直接抛错。
export const PURPOSES = {
  register: { subject: 'MinePage 注册验证码' },
  change: { subject: 'MinePage 修改密码验证码' },
  reset: { subject: 'MinePage 找回密码验证码' },
};

/** 验证码的哈希：sha256('邮箱:验证码') 的 hex。
 *  把邮箱混进来当盐，同一串验证码在不同邮箱下哈希不同；库里只存这个值，明文只出现在邮件正文里。 */
function hashCode(email, code) {
  // 混入邮箱做盐，同一串验证码在不同邮箱下哈希不同
  return crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');
}

/** 生成 CODE_LENGTH 位数字验证码：随机源是 crypto.randomInt，不足位左侧补 0，可能有前导 0。 */
function generateCode() {
  const n = crypto.randomInt(0, 10 ** CODE_LENGTH);
  return String(n).padStart(CODE_LENGTH, '0');
}

/** 清掉一天前的旧记录，防止表无限涨。
 *  每次 issueCode 开头都会跑一次；验证码本身 10 分钟就过期，一天是宽松阈值，不会误删还在有效期内的码。 */
function cleanup() {
  getDb()
    .prepare('DELETE FROM email_codes WHERE created_at <= ?')
    .run(new Date(Date.now() - 86400_000).toISOString());
}

/**
 * 给邮箱发一个验证码。受 60 秒重发冷却限制。
 * 返回 { ok, dev? } 或 { ok: false, message }。
 *
 * 前提：purpose 必须是 PURPOSES 里登记过的，否则抛错。
 * 冷却按「邮箱 + 用途」判断（没有 IP 维度），冷却期内直接返回 { ok: false, message }，不发信也不写库。
 * 副作用顺序：先写 email_codes 一行，再 await sendMail。发信失败时记录已经落库，
 * 调用方拿到 500，而用户还要再等满冷却时间才能重试（已知问题 E6，见 tests/issues.md）。
 * 返回的 dev 为真表示没配置 SMTP、验证码只打印在服务器控制台，前端可以据此提示。
 */
export async function issueCode(email, purpose) {
  if (!PURPOSES[purpose]) throw new Error(`未知的验证码用途: ${purpose}`);
  cleanup();

  const db = getDb();
  const recent = db
    .prepare(
      'SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    )
    .get(email, purpose);

  if (recent) {
    const elapsed = (Date.now() - Date.parse(recent.created_at)) / 1000;
    if (elapsed < CODE_RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(CODE_RESEND_COOLDOWN_SECONDS - elapsed);
      return { ok: false, message: `发送太频繁了，请 ${wait} 秒后再试` };
    }
  }

  const code = generateCode();
  db.prepare(
    `INSERT INTO email_codes (email, purpose, code_hash, attempts, created_at, expires_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(email, purpose, hashCode(email, code), nowIso(), new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString());

  const { dev } = await sendMail({
    to: email,
    subject: PURPOSES[purpose].subject,
    text: `你的验证码是 ${code}，${CODE_TTL_MINUTES} 分钟内有效。如果不是你本人的操作，请忽略这封邮件。`,
  });

  return { ok: true, dev };
}

/**
 * 校验并消费验证码。失败也计入 attempts，错满 CODE_MAX_ATTEMPTS 次作废。
 * 返回 { ok: true } 或 { ok: false, message }。
 *
 * 取的是该邮箱 + 用途下最近一条「未消费且未过期」的记录；查不到就统一回「不存在或已过期」。
 * 先 attempts + 1 再比对哈希，所以失败次数是包含本次的；到 CODE_MAX_ATTEMPTS 之后即使填对也拒绝。
 * 成功会写 consumed_at，同一行不能被用第二次。
 * 注意：它只证明「邮箱收得到信」，不判断邮箱是否已注册、是否已被封禁——那些业务判断在 server.js。
 */
export function consumeCode(email, purpose, code) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM email_codes
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(email, purpose, nowIso());

  if (!row) return { ok: false, message: '验证码不存在或已过期，请重新获取' };
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    return { ok: false, message: '错太多次了，这个验证码已作废，请重新获取' };
  }

  db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  const actual = Buffer.from(hashCode(email, String(code)), 'hex');
  const expected = Buffer.from(row.code_hash, 'hex');
  const match = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);

  if (!match) return { ok: false, message: '验证码不对' };

  db.prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { ok: true };
}
