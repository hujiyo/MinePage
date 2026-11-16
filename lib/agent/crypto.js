// 模型 API Key 的加解密（AES-256-GCM）。
//
// 为什么必须加密：后台填的 key 要落库，而数据库会被备份、会被 `mysqldump` 导出、
// 运维同学可能要连上去看数据。明文存等于把这些 key 一起发了出去。
//
// 主密钥从环境变量 MODEL_SECRET 读，**永远不落库**：
//   - 库被拖走但没有服务器上的环境变量 → 密文解不开，等于一堆乱码
//   - 换服务器时把同一串 MODEL_SECRET 配过去，历史 key 照样能用
//
// 存储格式：`v1:<iv_b64>:<tag_b64>:<cipher_b64>`
//   前缀 v1 是为了将来换算法时能识别旧数据。GCM 自带完整性校验，
//   密文被改过一个字节，解密就会抛错而不是返回垃圾。
//
// 加密是「可逆」的，所以它防的是「数据库泄露」，不防「服务器被完全控制」——
// 那种情况下攻击者能直接读进程内存。这个边界要在文档里写清楚，别给人虚假安全感。

import crypto from 'node:crypto';

const PREFIX = 'v1';
// 固定盐：它不是密钥的一部分，只是让同一串 secret 在不同用途下派生出不同的 key。
const SALT = 'minepage/agent-model';

let cachedKey = null;
let cachedSecret = '';

/**
 * 从 MODEL_SECRET 派生出 32 字节密钥。
 * 没配 secret 时返回 null —— 调用方据此判断「能不能加密」，而不是直接崩。
 */
function masterKey() {
  const secret = String(process.env.MODEL_SECRET ?? '').trim();
  if (!secret) return null;
  // secret 没变就复用派生结果（scrypt 是故意的慢，别每次都算）
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = crypto.scryptSync(secret, SALT, 32);
  cachedSecret = secret;
  return cachedKey;
}

/** 现在能不能加密（后台保存带 key 的模型前要先问一句）。 */
export function canEncrypt() {
  return masterKey() !== null;
}

/**
 * 加密一段明文。
 * @param {string} plain
 * @returns {string} `v1:iv:tag:cipher`，空串进空串出
 * @throws 没配 MODEL_SECRET 时抛错（这是配置问题，不该静默降级成明文）
 */
export function encryptSecret(plain) {
  const text = String(plain ?? '');
  if (!text) return '';

  const key = masterKey();
  if (!key) {
    throw Object.assign(
      new Error('没有配置 MODEL_SECRET，无法加密保存 API Key。请在服务器环境变量里加一行 MODEL_SECRET=<一串随机字符> 再试。'),
      { code: 'NO_SECRET' },
    );
  }

  const iv = crypto.randomBytes(12);           // GCM 推荐 96 位 IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/**
 * 解密。
 * 空串 / 格式不对 / 密钥换了 / 密文被改 → 一律返回空串。
 * 刻意不抛错：一个 key 解不开不该让整页模型列表炸掉，
 * 界面上显示成「未配置 key」让管理员重填就好。
 */
export function decryptSecret(stored) {
  const s = String(stored ?? '');
  if (!s) return '';

  const parts = s.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return '';

  const key = masterKey();
  if (!key) return '';

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // 换了 MODEL_SECRET / 密文损坏都会走到这里
    return '';
  }
}

/** 给界面看的掩码：sk-abcd…wxyz。太短就整段打码，别泄露长度信息。 */
export function maskSecret(plain) {
  const s = String(plain ?? '');
  if (!s) return '';
  if (s.length <= 12) return '****';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/** 测试用：清掉派生缓存（改完 MODEL_SECRET 后要重新派生）。 */
export function resetMasterKey() {
  cachedKey = null;
  cachedSecret = '';
}
