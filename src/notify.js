/**
 * External notification delivery (SMS + email). Both are best-effort and
 * no-op unless the relevant provider env vars are set, so the app runs fine
 * without them and never throws into a request path.
 *
 * SMS  — Twilio REST API: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 * Email — the provider chosen in Settings (SMTP2GO or SMTP, see email.js);
 *         otherwise Resend if RESEND_API_KEY + RESEND_FROM are set.
 */

async function sendSms(toPhone, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;
  if (!toPhone || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) return false;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: toPhone, From: TWILIO_FROM, Body: body }),
      }
    );
    return res.ok;
  } catch (e) {
    console.error('[notify] SMS failed:', e.message);
    return false;
  }
}

/** True when the Resend fallback is configured (Settings email is checked by callers / sendEmail). */
const emailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM);

/**
 * Send one email. Optional html body and attachments
 * ([{ filename, content: Buffer|string }]).
 */
async function sendEmail(toEmail, subject, text, { html, attachments } = {}) {
  if (!toEmail) return false;
  // The provider configured in Settings wins.
  const email = require('./email');
  try {
    if (await email.getConfig()) {
      const r = await email.sendMail({ to: toEmail, subject, text, html, attachments });
      return !!r.ok;
    }
  } catch (e) {
    console.error('[notify] email failed:', e.message);
    return false;
  }
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!toEmail || !RESEND_API_KEY || !RESEND_FROM) return false;
  try {
    const payload = { from: RESEND_FROM, to: toEmail, subject, text };
    if (html) payload.html = html;
    if (attachments && attachments.length) {
      payload.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content).toString('base64'),
      }));
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) console.error('[notify] email rejected:', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error('[notify] email failed:', e.message);
    return false;
  }
}

module.exports = { sendSms, sendEmail, emailConfigured };
