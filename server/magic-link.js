// Magic link generation, email sending (via Resend), and token verification.
// If RESEND_API_KEY is not set, magic link URLs are logged to the server console.

import { randomUUID } from 'crypto';
import db from './db.js';

// ── Configuration ────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = process.env.EMAIL_FROM || "Caleb's Hollow <noreply@calebshollow.com>";
const TOKEN_TTL_MS   = 15 * 60 * 1000; // 15 minutes

// Derive BASE_URL: explicit env var > Railway public domain > localhost fallback
function _baseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

// ── Prepared statements ──────────────────────────────────────────────────────

const _insertToken  = db.prepare(
  'INSERT INTO magic_tokens (token, email, player_id, expires_at) VALUES (?, ?, ?, ?)'
);
const _getToken     = db.prepare(
  'SELECT * FROM magic_tokens WHERE token = ? AND used = 0'
);
const _markUsed     = db.prepare(
  'UPDATE magic_tokens SET used = 1 WHERE token = ?'
);
const _pruneExpired = db.prepare(
  'DELETE FROM magic_tokens WHERE expires_at < ? OR used = 1'
);

// ── Token management ─────────────────────────────────────────────────────────

/**
 * Generate a magic link token for the given email.
 * @param {string} email     - The email address
 * @param {string|null} playerId - If linking to existing account; null for login-from-new-device
 * @returns {string} The generated token
 */
export function generateToken(email, playerId = null) {
  // Prune old tokens on each generation to keep the table clean
  _pruneExpired.run(Date.now());

  const token = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  _insertToken.run(token, email.toLowerCase().trim(), playerId, expiresAt);
  return token;
}

/**
 * Verify a magic link token. Returns { email, playerId } or null if invalid/expired.
 * Marks the token as used on success.
 */
export function verifyToken(token) {
  // Prune expired tokens
  _pruneExpired.run(Date.now());

  const row = _getToken.get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;

  _markUsed.run(token);
  return { email: row.email, playerId: row.player_id };
}

// ── Email sending ────────────────────────────────────────────────────────────

/**
 * Send a magic link email. Returns { ok, error? }.
 * Falls back to console logging if RESEND_API_KEY is not configured.
 */
export async function sendMagicLinkEmail(email, token, { isLink = false } = {}) {
  const verifyUrl = `${_baseUrl()}/auth/verify?token=${token}`;

  const subject = isLink
    ? "Link your Caleb's Hollow account"
    : "Sign in to Caleb's Hollow";

  const body = isLink
    ? `Click the link below to link this email to your Caleb's Hollow account:\n\n${verifyUrl}\n\nThis link expires in 15 minutes.`
    : `Click the link below to sign in to Caleb's Hollow:\n\n${verifyUrl}\n\nThis link expires in 15 minutes.`;

  if (!RESEND_API_KEY) {
    console.log(`[Magic Link] ${subject} for ${email}:`);
    console.log(`  ${verifyUrl}`);
    return { ok: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    EMAIL_FROM,
        to:      [email],
        subject,
        text:    body,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[Magic Link] Resend API error:', res.status, err);
      return { ok: false, error: 'Failed to send email. Please try again.' };
    }

    return { ok: true };
  } catch (err) {
    console.error('[Magic Link] Send error:', err);
    return { ok: false, error: 'Failed to send email. Please try again.' };
  }
}
