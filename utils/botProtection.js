// Lightweight, zero-dependency bot defenses that work with no configuration,
// plus an optional Cloudflare Turnstile check for operators who want stronger
// protection. None of this replaces rate limiting (middleware/rateLimiters.js)
// — it's defense-in-depth against scripted signup/spam bots specifically.

const HONEYPOT_FIELD = 'company_website';

// A small built-in list of common disposable/temp-mail domains. Not
// exhaustive — operators can extend it via DISPOSABLE_EMAIL_DOMAINS (a
// comma-separated list) without a code change.
const BUILTIN_DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'yopmail.com', 'trashmail.com', 'throwawaymail.com', 'fakeinbox.com',
  'getnada.com', 'maildrop.cc', 'dispostable.com', 'sharklasers.com',
  'grr.la', 'spam4.me', 'mohmal.com', 'temp-mail.org', 'discard.email',
  '33mail.com', 'mailnesia.com', 'mintemail.com',
]);

const extraDomains = (process.env.DISPOSABLE_EMAIL_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
for (const d of extraDomains) BUILTIN_DISPOSABLE_DOMAINS.add(d);

function isHoneypotTripped(body) {
  return Boolean((body[HONEYPOT_FIELD] || '').trim());
}

function isDisposableEmail(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  return BUILTIN_DISPOSABLE_DOMAINS.has(domain);
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function turnstileConfigured() {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

// Returns true if Turnstile isn't configured (no-op pass-through) or if the
// token verifies; false if it's configured and the token is missing/invalid.
async function verifyTurnstile(token, remoteip) {
  if (!turnstileConfigured()) return true;
  if (!token) return false;

  try {
    const params = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
    if (remoteip) params.set('remoteip', remoteip);

    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: params });
    const data = await res.json();
    return Boolean(data.success);
  } catch {
    // Fail closed on verification errors when Turnstile is configured — an
    // unreachable verify endpoint shouldn't silently let bots through.
    return false;
  }
}

module.exports = {
  HONEYPOT_FIELD,
  isHoneypotTripped,
  isDisposableEmail,
  turnstileConfigured,
  verifyTurnstile,
};
