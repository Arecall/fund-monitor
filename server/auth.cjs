/**
 * auth.cjs — 密码哈希与校验（基于 Node 内置 crypto.scrypt）
 *
 * 哈希格式：scrypt:<salt-base64>:<hash-base64>
 * scrypt 是内存硬化的 KDF，无需额外依赖，比 bcrypt 更轻量。
 *
 * 参数：N=16384, r=8, p=1（Node 默认值；平衡安全性与速度）
 */

const crypto = require('crypto');

const KEY_LEN = 64;
const SALT_LEN = 16;

function hashPassword(plain) {
  if (!plain || typeof plain !== 'string') {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = crypto.scryptSync(plain, salt, KEY_LEN);
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  if (!plain || !stored || typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, saltB64, hashB64] = parts;
  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const actual = crypto.scryptSync(plain, salt, KEY_LEN);
  // 时间恒定比较，防 timing attack
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * 简单的密码强度校验（前端 + 后端共用规则）
 * - 至少 4 个字符
 * - 至少包含字母
 * - 不强制复杂字符（个人工具，UX 优先）
 */
function passwordMeetsPolicy(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.length < 4) return false;
  // 至少一个字母（数字/特殊字符可选）
  if (!/[a-zA-Z]/.test(p)) return false;
  return true;
}

module.exports = { hashPassword, verifyPassword, passwordMeetsPolicy };