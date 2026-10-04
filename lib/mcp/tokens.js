import crypto from 'node:crypto';

import { getDb } from '../db.js';
import { MCP_TOKEN_PREFIX, MCP_TOKENS_PER_USER, MCP_LAST_USED_THROTTLE_MS } from '../config.js';

// MCP 密钥存储。
//
// 与登录会话（sessions 表）刻意分开：会话是 Cookie、会过期；MCP 密钥是长期凭证、
// 显式吊销才失效。两者都只存哈希，但密钥可以直接当「账户令牌」塞进别人的客户端配置里，
// 所以明文同样只在创建响应里出现一次，库里、日志里都不留。
//
// 吊销 = 删行。MinePage 不需要密钥使用历史，多一个 revoked_at 状态就多一处判断。

const nowIso = () => new Date().toISOString();

/** 密钥只以 sha256 落库；查询走这个哈希（UNIQUE 索引），明文永不参与比较。 */
export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function mintToken() {
  return `${MCP_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function publicToken(row) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function countMcpTokens(userId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM mcp_tokens WHERE user_id = ?').get(userId).c;
}

/**
 * 铸造一把新密钥。
 * 返回 { token, record }，token 是明文，调用方必须立刻回给用户，之后再也拿不到。
 */
export function createMcpToken(userId, label) {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) {
    throw Object.assign(new Error('给密钥起个名字吧'), { code: 'BAD_LABEL' });
  }
  if (trimmed.length > 60) {
    throw Object.assign(new Error('密钥名称最多 60 个字符'), { code: 'BAD_LABEL' });
  }
  if (countMcpTokens(userId) >= MCP_TOKENS_PER_USER) {
    throw Object.assign(
      new Error(`最多保留 ${MCP_TOKENS_PER_USER} 把有效密钥，先吊销不再用的`),
      { code: 'TOO_MANY_TOKENS' },
    );
  }

  const token = mintToken();
  const createdAt = nowIso();
  const result = getDb()
    .prepare('INSERT INTO mcp_tokens (user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, trimmed, hashToken(token), createdAt);

  return {
    token,
    record: { id: Number(result.lastInsertRowid), label: trimmed, createdAt, lastUsedAt: null },
  };
}

export function listMcpTokens(userId) {
  return getDb()
    .prepare('SELECT id, label, created_at, last_used_at FROM mcp_tokens WHERE user_id = ? ORDER BY id DESC')
    .all(userId)
    .map(publicToken);
}

/** 吊销（删行）。返回是否真的删掉了一条。 */
export function revokeMcpToken(userId, tokenId) {
  return getDb()
    .prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?')
    .run(Number(tokenId), userId).changes;
}

/**
 * 用明文密钥换身份。返回 { tokenId, userId }，无效返回 null。
 *
 * 同时把用户的封禁状态一起判掉：账号被封后手里的密钥必须立刻失效，
 * 否则「封号」在 MCP 这条路上等于没做。
 *
 * last_used_at 节流落盘（默认 60 秒一次）：查询路径本来就要读这一行，
 * 顺手判断即可，不需要 emate 那套内存脏标记。
 */
export function authenticateMcpToken(raw, { now = Date.now() } = {}) {
  const value = String(raw ?? '').trim();
  if (!value.startsWith(MCP_TOKEN_PREFIX)) return null;

  const row = getDb()
    .prepare(
      `SELECT t.id AS token_id, t.user_id, t.last_used_at,
              u.status AS user_status
       FROM mcp_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
    )
    .get(hashToken(value));

  if (!row || row.user_status !== 'active') return null;

  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!Number.isFinite(last) || now - last > MCP_LAST_USED_THROTTLE_MS) {
    getDb()
      .prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date(now).toISOString(), row.token_id);
  }

  return { tokenId: row.token_id, userId: row.user_id };
}
