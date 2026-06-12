/**
 * External notification delivery (SMS + email). Both are best-effort and
 * no-op unless the relevant provider env vars are set, so the app runs fine
 * without them and never throws into a request path.
 *
 * SMS  — Twilio REST API: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 * Email — generic SMTP-over-HTTP not assumed; uses Resend if RESEND_API_KEY +
 *         RESEND_FROM are set (simple HTTPS API, no SMTP socket needed on Vercel).
 */

async function sendSms(toPhone, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;
  if (!toPhone || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) return false;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
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

async function sendEmail(toEmail, subject, text) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!toEmail || !RESEND_API_KEY || !RESEND_FROM) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: toEmail, subject, text }),
    });
    return res.ok;
  } catch (e) {
    console.error('[notify] email failed:', e.message);
    return false;
  }
}

module.exports = { sendSms, sendEmail };
