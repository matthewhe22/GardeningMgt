const crypto = require('crypto');
const { q, q1 } = require('./db');

// Secret-valued settings are encrypted at rest with AES-256-GCM using a key
// derived from SETTINGS_KEY (or SESSION_SECRET as a fallback). Stored as
// enc:<iv>:<tag>:<ciphertext> (all base64). Plaintext legacy values still read.
const SECRET_KEYS = new Set(['onedrive_client_secret']);
const KEY = crypto.createHash('sha256')
  .update(process.env.SETTINGS_KEY || process.env.SESSION_SECRET || 'dev-only-insecure-secret')
  .digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc:')) return stored; // legacy plaintext
  try {
    const [, ivB, tagB, ctB] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key / corrupt
  }
}

async function getSetting(key) {
  const row = await q1('SELECT value FROM settings WHERE key = $1', [key]);
  if (!row) return null;
  return SECRET_KEYS.has(key) ? decrypt(row.value) : row.value;
}

async function getSettings(keys) {
  const rows = await q('SELECT key, value FROM settings WHERE key = ANY($1)', [keys]);
  const out = {};
  for (const k of keys) out[k] = null;
  for (const r of rows) out[r.key] = SECRET_KEYS.has(r.key) ? decrypt(r.value) : r.value;
  return out;
}

async function setSetting(key, value) {
  const stored = SECRET_KEYS.has(key) && value != null ? encrypt(value) : value;
  await q(`
    INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, stored]);
}

module.exports = { getSetting, getSettings, setSetting };
