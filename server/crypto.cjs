/**
 * crypto.cjs — AES-256-GCM 加密工具
 *
 * 用来把 settings 表里的敏感凭据（API key、SMTP 密码）以加密形式存储。
 * 主密钥从环境变量 ENCRYPTION_KEY 派生；如果未设置，使用项目根目录
 * .encryption_key 文件做 fallback（首次启动自动生成）。
 *
 * 加密格式: enc:v1:<iv-base64>:<ciphertext-base64>:<auth-tag-base64>
 * 包含版本号方便将来升级算法。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..');
const KEY_FILE = path.join(DATA_DIR, '.encryption_key');

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey.length >= 16) {
    cachedKey = crypto.scryptSync(envKey, 'fund-monitor-salt', KEY_BYTES);
    return cachedKey;
  }
  // Fallback: 持久化到本地文件
  if (fs.existsSync(KEY_FILE)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'base64');
    return cachedKey;
  }
  const fresh = crypto.randomBytes(KEY_BYTES);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, fresh.toString('base64'), { mode: 0o600 });
    console.log('[crypto] 生成新加密密钥:', KEY_FILE);
  } catch (e) {
    console.warn('[crypto] 无法写入密钥文件:', e.message);
  }
  cachedKey = fresh;
  return cachedKey;
}

/**
 * 加密：明文 → "enc:v1:<iv>:<cipher>:<tag>" (base64 段)
 * 明文为空则直接返回空字符串
 */
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

/**
 * 解密：encrypted → 明文。若不是加密格式则原样返回（兼容明文配置）
 */
function decrypt(encrypted) {
  if (!encrypted || typeof encrypted !== 'string') return '';
  if (!encrypted.startsWith('enc:v1:')) return encrypted;
  const parts = encrypted.split(':');
  if (parts.length !== 5) return encrypted;
  const [, , ivB64, ctB64, tagB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    console.warn('[crypto] decrypt failed:', e.message);
    return '';
  }
}

/** 检测是否已加密 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

module.exports = { encrypt, decrypt, isEncrypted };
