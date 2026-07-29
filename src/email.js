/**
 * Invoice emailing via plain SMTP (nodemailer).
 *
 * Admins configure these settings on /admin/settings, mirroring the OneDrive
 * integration's pattern:
 *   smtp_host       SMTP server hostname
 *   smtp_port       SMTP port (465 = implicit TLS, 587/25 = STARTTLS)
 *   smtp_user       login username (omit for an open/unauthenticated relay)
 *   smtp_password   login password
 *   smtp_from_email address invoices are sent from
 *   smtp_from_name  display name for the From header (optional)
 *
 * Sends are best-effort: callers treat failures as non-fatal and log them,
 * same convention as onedrive.js's uploadFile.
 */
const { getSettings } = require('./settings');

const SETTING_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_from_email', 'smtp_from_name'];

async function getConfig() {
  const s = await getSettings(SETTING_KEYS);
  if (!s.smtp_host || !s.smtp_port || !s.smtp_from_email) return null; // not configured
  return s;
}

// nodemailer is required lazily so it never loads on cold start unless email
// is actually used, mirroring onedrive.js's lazy @microsoft graph-adjacent requires.
function makeTransport(cfg) {
  const nodemailer = require('nodemailer');
  const port = Number(cfg.smtp_port);
  return nodemailer.createTransport({
    host: cfg.smtp_host,
    port,
    secure: port === 465, // implicit TLS on 465; STARTTLS negotiated on 587/25/others
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_password || '' } : undefined,
  });
}

function fromHeader(cfg) {
  return cfg.smtp_from_name ? `"${cfg.smtp_from_name.replace(/"/g, '')}" <${cfg.smtp_from_email}>` : cfg.smtp_from_email;
}

/**
 * Send one email.
 * @param {{to: string, subject: string, text?: string, html?: string, attachments?: Array}} msg
 */
async function sendMail(msg) {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, skipped: true, reason: 'SMTP not configured' };
  const transport = makeTransport(cfg);
  const info = await transport.sendMail({ from: fromHeader(cfg), ...msg });
  return { ok: true, messageId: info.messageId };
}

/** Verify credentials: open a connection to the SMTP server and authenticate. */
async function testConnection() {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, message: 'Not configured — fill in host, port and from-email.' };
  try {
    const transport = makeTransport(cfg);
    await transport.verify();
    return { ok: true, message: `Connected to ${cfg.smtp_host}:${cfg.smtp_port} as ${cfg.smtp_from_email}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

module.exports = { sendMail, testConnection, getConfig, SETTING_KEYS };
