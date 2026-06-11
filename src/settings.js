const { q, q1 } = require('./db');

async function getSetting(key) {
  const row = await q1('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : null;
}

async function getSettings(keys) {
  const rows = await q('SELECT key, value FROM settings WHERE key = ANY($1)', [keys]);
  const out = {};
  for (const k of keys) out[k] = null;
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function setSetting(key, value) {
  await q(`
    INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]);
}

module.exports = { getSetting, getSettings, setSetting };
