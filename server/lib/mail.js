/**
 * Provider-agnostic outbound mail.
 *
 * Activation by env:
 *   MAIL_PROVIDER=resend       → POST https://api.resend.com/emails  (needs RESEND_API_KEY)
 *   MAIL_PROVIDER=sendgrid     → POST https://api.sendgrid.com/v3   (needs SENDGRID_API_KEY)
 *   MAIL_PROVIDER=ses          → AWS SES via @aws-sdk/client-ses    (needs IAM credentials)
 *   MAIL_PROVIDER=console / unset → log to stdout, return ok
 *
 * The 'console' default means dev / local / un-configured deploys never fail
 * an auth flow because email is broken — they just don't actually send. The
 * verification link still gets logged so you can copy-paste it from the
 * server logs during development.
 *
 * Required adjacent env:
 *   MAIL_FROM        the From: address
 *   APP_BASE_URL     used to build verify / reset URLs in templates
 */

const PROVIDER = (process.env.MAIL_PROVIDER || 'console').toLowerCase();
const FROM = process.env.MAIL_FROM || 'noreply@example.com';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

/**
 * Low-level send. Returns { ok, provider, id? } on success or throws.
 * Callers (sendVerificationEmail / sendPasswordResetEmail) typically catch
 * and convert to non-fatal errors — auth flows should not fail just because
 * email is down; the user can request a resend.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!to || !subject || !(text || html)) {
    throw new Error('sendMail: to, subject, and text|html required');
  }

  if (PROVIDER === 'console' || PROVIDER === '') {
    console.log('━━━━━ [mail STUB — not sent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`To:      ${to}`);
    console.log(`From:    ${FROM}`);
    console.log(`Subject: ${subject}`);
    console.log('');
    console.log(text || stripHtml(html));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return { ok: true, provider: 'console' };
  }

  if (PROVIDER === 'resend')   return sendViaResend({ to, subject, text, html });
  if (PROVIDER === 'sendgrid') return sendViaSendgrid({ to, subject, text, html });
  if (PROVIDER === 'ses')      return sendViaSes({ to, subject, text, html });

  throw new Error(`Unknown MAIL_PROVIDER: ${PROVIDER}`);
}

// ─── Provider adapters (lazy-loaded so unused providers don't need deps) ────

async function sendViaResend({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json().catch(() => ({}));
  return { ok: true, provider: 'resend', id: data.id };
}

async function sendViaSendgrid({ to, subject, text, html }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY not set');
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: { email: FROM },
      personalizations: [{ to: [{ email: to }] }],
      subject,
      content: [
        { type: 'text/plain', value: text || stripHtml(html) },
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`SendGrid ${r.status}: ${body.slice(0, 200)}`);
  }
  // SendGrid returns the message id in the X-Message-Id header
  return { ok: true, provider: 'sendgrid', id: r.headers.get('x-message-id') };
}

async function sendViaSes({ to, subject, text, html }) {
  const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
  const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const cmd = new SendEmailCommand({
    Source: FROM,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: text || stripHtml(html) },
        ...(html ? { Html: { Data: html } } : {}),
      },
    },
  });
  const res = await ses.send(cmd);
  return { ok: true, provider: 'ses', id: res.MessageId };
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Templates ──────────────────────────────────────────────────────────────

export async function sendVerificationEmail({ to, token }) {
  const url = `${APP_BASE_URL}/?verify=${encodeURIComponent(token)}`;
  return sendMail({
    to,
    subject: 'Verify your knowl email',
    text:
`Welcome to knowl.

Click the link below to verify your email:
${url}

This link expires in 7 days. If you didn't sign up, ignore this email.`,
  });
}

export async function sendPasswordResetEmail({ to, token }) {
  const url = `${APP_BASE_URL}/?reset=${encodeURIComponent(token)}`;
  return sendMail({
    to,
    subject: 'Reset your knowl password',
    text:
`Someone requested a password reset for the knowl account associated with this email.

If that was you, click here to choose a new password:
${url}

This link expires in 1 hour. If it wasn't you, ignore this email — your password is unchanged.`,
  });
}
