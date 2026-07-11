const crypto = require('crypto');
const { q, q1 } = require('./db');

// Secret-valued settings are encrypted at rest with AES-256-GCM using a key
// derived from SETTINGS_KEY (or SESSION_SECRET as a fallback). Stored as
// enc:<iv>:<tag>:<ciphertext> (all base64). Plaintext legacy values still read.
const SECRET_KEYS = new Set(['onedrive_client_secret']);

// Fail closed, same rule as server.js's SESSION_SECRET guard (duplicated
// rather than imported to avoid a circular require: server.js -> routes/admin
// -> settings.js -> server.js). Without this, an unset SETTINGS_KEY/
// SESSION_SECRET silently derives the encryption key from a literal string in
// the public repo, so anyone who reads the source can decrypt stored secrets
// (e.g. the OneDrive client secret) straight out of the settings table.
const KEY_MATERIAL = process.env.SETTINGS_KEY || process.env.SESSION_SECRET;
if (!KEY_MATERIAL && process.env.ALLOW_INSECURE_SECRET !== '1') {
  throw new Error(
    'SETTINGS_KEY or SESSION_SECRET must be set — refusing to start and derive the settings ' +
    'encryption key from the default insecure value. Set one of them, or set ' +
    'ALLOW_INSECURE_SECRET=1 for local dev only.'
  );
}
const KEY = crypto.createHash('sha256').update(KEY_MATERIAL || 'dev-only-insecure-secret').digest();

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
