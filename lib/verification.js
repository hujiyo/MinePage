// 邮箱验证码：生成、发送、校验。
// 验证码本身只存 sha256 哈希；校验失败累计 attempts，超过上限作废。
import crypto from 'node:crypto';
import { get, run } from './db.js';
import { sendMail } from './email.js';
import {
  CODE_LENGTH,
  CODE_TTL_MINUTES,
  CODE_RESEND_COOLDOWN_SECONDS,
  CODE_MAX_ATTEMPTS,
} from './config.js';

const nowIso = () => new Date().toISOString();

// purpose → 邮件主题。新加验证码场景时在这里登记。
export const PURPOSES = {
  register: { subject: 'MinePage 注册验证码' },
  change: { subject: 'MinePage 修改密码验证码' },
  reset: { subject: 'MinePage 找回密码验证码' },
};

function hashCode(email, code) {
  // 混入邮箱做盐，同一串验证码在不同邮箱下哈希不同
  return crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');
}

function generateCode() {
  const n = crypto.randomInt(0, 10 ** CODE_LENGTH);
  return String(n).padStart(CODE_LENGTH, '0');
}

/** 清掉一天前的旧记录，防止表无限涨。 */
async function cleanup() {
  await run('DELETE FROM email_codes WHERE created_at <= ?', new Date(Date.now() - 86400_000).toISOString());
}

/**
 * 给邮箱发一个验证码。受 60 秒重发冷却限制。
 * 返回 { ok, dev? } 或 { ok: false, message }。
 */
export async function issueCode(email, purpose) {
  if (!PURPOSES[purpose]) throw new Error(`未知的验证码用途: ${purpose}`);
  await cleanup();

  const recent = await get('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1', email, purpose);

  if (recent) {
    const elapsed = (Date.now() - Date.parse(recent.created_at)) / 1000;
    if (elapsed < CODE_RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(CODE_RESEND_COOLDOWN_SECONDS - elapsed);
      return { ok: false, message: `发送太频繁了，请 ${wait} 秒后再试` };
    }
  }

  const code = generateCode();
  await run(`INSERT INTO email_codes (email, purpose, code_hash, attempts, created_at, expires_at)
     VALUES (?, ?, ?, 0, ?, ?)`, email, purpose, hashCode(email, code), nowIso(), new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString());

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
 */
export async function consumeCode(email, purpose, code) {
  const row = await get(`SELECT * FROM email_codes
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY id DESC LIMIT 1`, email, purpose, nowIso());

  if (!row) return { ok: false, message: '验证码不存在或已过期，请重新获取' };
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    return { ok: false, message: '错太多次了，这个验证码已作废，请重新获取' };
  }

  await run('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', row.id);

  const actual = Buffer.from(hashCode(email, String(code)), 'hex');
  const expected = Buffer.from(row.code_hash, 'hex');
  const match = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);

  if (!match) return { ok: false, message: '验证码不对' };

  await run('UPDATE email_codes SET consumed_at = ? WHERE id = ?', nowIso(), row.id);
  return { ok: true };
}
