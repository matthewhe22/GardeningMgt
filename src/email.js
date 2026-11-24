/**
 * Outgoing email (invoices, job reports, owner reports, reminders).
 *
 * Admins configure this on /admin/settings. Two ways to send:
 *   email_provider = 'smtp2go'  SMTP2GO's HTTPS API (api.smtp2go.com) — works
 *                               from serverless hosts with no SMTP socket.
 *                     smtp2go_api_key  API key (SMTP2GO → Sending → API Keys)
 *   email_provider = 'smtp'     any SMTP server, via nodemailer (the default
 *                               when nothing is chosen, for older setups):
 *                     smtp_host, smtp_port (465 = implicit TLS, 587/25 =
 *                     STARTTLS), smtp_user, smtp_password
 * Both use:
 *   smtp_from_email  address mail is sent from (a verified sender in SMTP2GO)
 *   smtp_from_name   display name for the From header (optional)
 *
 * Sends are best-effort: callers treat failures as non-fatal and log them,
 * same convention as onedrive.js's uploadFile.
 */
const { getSettings } = require('./settings');

const SETTING_KEYS = ['email_provider', 'smtp2go_api_key',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_from_email', 'smtp_from_name'];

const SMTP2GO_URL = 'https://api.smtp2go.com/v3/email/send';

const providerOf = (s) => (s.email_provider === 'smtp2go' ? 'smtp2go' : 'smtp');

async function getConfig() {
  const s = await getSettings(SETTING_KEYS);
  const provider = providerOf(s);
  if (!s.smtp_from_email) return null;
  if (provider === 'smtp2go' && !s.smtp2go_api_key) return null;
  if (provider === 'smtp' && (!s.smtp_host || !s.smtp_port)) return null;
  return { ...s, provider };
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
    // Fail a stuck mail server in seconds rather than holding the request.
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
  });
}

function fromHeader(cfg) {
  return cfg.smtp_from_name ? `"${cfg.smtp_from_name.replace(/"/g, '')}" <${cfg.smtp_from_email}>` : cfg.smtp_from_email;
}

/** "a@x.com, b@y.com" or an array → ['a@x.com', 'b@y.com'] */
function recipients(to) {
  return (Array.isArray(to) ? to : String(to || '').split(','))
    .map((a) => String(a).trim()).filter(Boolean);
}

/** Send one message through SMTP2GO's API. Throws with SMTP2GO's reason on failure. */
async function sendViaSmtp2go(cfg, msg) {
  const to = recipients(msg.to);
  if (!to.length) throw new Error('No recipient');
  const body = {
    sender: fromHeader(cfg).replace(/^"([^"]*)"/, '$1'),
    to,
    subject: msg.subject || '',
  };
  if (msg.text) body.text_body = msg.text;
  if (msg.html) body.html_body = msg.html;
  if (!body.text_body && !body.html_body) body.text_body = '';
  if (msg.attachments && msg.attachments.length) {
    body.attachments = msg.attachments.map((a) => ({
      filename: a.filename,
      fileblob: Buffer.from(a.content).toString('base64'),
      mimetype: a.contentType || 'application/octet-stream',
    }));
  }
  let res;
  try {
    res = await fetch(SMTP2GO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Smtp2go-Api-Key': cfg.smtp2go_api_key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Could not reach SMTP2GO: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  const data = ((await res.json().catch(() => null)) || {}).data || {};
  if (!res.ok || !(data.succeeded > 0)) {
    const why = data.error || (data.failures && data.failures.length && data.failures.join('; '))
      || `HTTP ${res.status}`;
    throw new Error(`SMTP2GO refused the email: ${why}${data.error_code ? ` (${data.error_code})` : ''}`);
  }
  return { ok: true, messageId: data.email_id || null };
}

/**
 * Send one email.
 * @param {{to: string|string[], subject: string, text?: string, html?: string,
 *   attachments?: Array<{filename: string, content: Buffer|string, contentType?: string}>}} msg
 */
async function sendMail(msg) {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, skipped: true, reason: 'Email not configured' };
  if (cfg.provider === 'smtp2go') return sendViaSmtp2go(cfg, msg);
  const transport = makeTransport(cfg);
  const info = await transport.sendMail({ from: fromHeader(cfg), ...msg });
  return { ok: true, messageId: info.messageId };
}

/**
 * Check the email setup. SMTP: connect and sign in. SMTP2GO (an HTTPS API
 * with nothing to connect to): send a short test email to `testTo`.
 */
async function testConnection(testTo) {
  const cfg = await getConfig();
  if (!cfg) {
    return { ok: false, message: 'Not configured — choose how to send, then fill in the from-email and '
      + 'either the SMTP2GO API key or the SMTP host and port.' };
  }
  try {
    if (cfg.provider === 'smtp2go') {
      if (!testTo) return { ok: false, message: 'Your account has no email address to send the test to.' };
      await sendViaSmtp2go(cfg, {
        to: testTo,
        subject: 'GardeningMgt test email',
        text: 'This is a test from GardeningMgt Settings. Email sending through SMTP2GO works.',
      });
      return { ok: true, message: `Sent a test email to ${testTo} through SMTP2GO, from ${cfg.smtp_from_email}. Check that inbox.` };
    }
    const transport = makeTransport(cfg);
    await transport.verify();
    return { ok: true, message: `Connected to ${cfg.smtp_host}:${cfg.smtp_port} as ${cfg.smtp_from_email}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

module.exports = { sendMail, testConnection, getConfig, recipients, SETTING_KEYS, SMTP2GO_URL };
