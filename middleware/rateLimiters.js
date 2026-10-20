const rateLimit = require('express-rate-limit');

// Shared options: key by IP, and respond with a small JSON/text body rather
// than leaking internals. standardHeaders adds RateLimit-* response headers.
const base = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429);
    if (req.accepts(['html', 'json']) === 'json') {
      res.json({ error: 'rate_limited', message: 'Too many requests. Please slow down and try again shortly.' });
    } else {
      res.type('text').send('Too many requests. Please slow down and try again shortly.');
    }
  },
};

// A generous baseline applied to every request, mainly to blunt blunt-force
// scripted abuse that ignores the more specific limiters below. Sized well
// above normal browsing because the organizer's own browser legitimately
// hits this a lot while processing a synced folder — each photo means at
// least one image fetch plus (if it has a face) one descriptor POST, so a
// folder of a thousand-plus photos alone can be 2000+ requests in one
// session.
const globalLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 6000 });

// Login/signup: the classic brute-force / credential-stuffing / signup-spam
// surface. Keyed on IP; deliberately strict.
const authLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 20 });

// Guest gallery password gate: limits brute-forcing an event's guest password.
const guestUnlockLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 20 });

// Per-photo upload endpoint (the client calls this once per file).
const uploadLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 300 });

// Google Drive / Dropbox sync hit an external API and can trigger real
// downloads — keep it tight to limit abuse/cost.
const driveImportLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 10 });
const dropboxImportLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 10 });

// Guest selfie matching: cheap to call but could be used to probe/enumerate
// an event's photos, so it's still worth limiting.
const matchLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 60 });

// Creating events / billing actions / the enterprise contact form: all
// low-frequency legitimate actions, so a strict cap costs nothing real.
const eventCreateLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 30 });
const billingLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 30 });
const contactFormLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 10 });

// Guests reporting an event gallery as inappropriate/misused.
const reportLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 10 });

// Zipping and streaming a batch of full-size photos is real CPU/bandwidth
// cost per request, unlike most guest endpoints — keep it tight.
const zipDownloadLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 10 });

module.exports = {
  globalLimiter,
  authLimiter,
  guestUnlockLimiter,
  uploadLimiter,
  driveImportLimiter,
  dropboxImportLimiter,
  matchLimiter,
  eventCreateLimiter,
  billingLimiter,
  contactFormLimiter,
  reportLimiter,
  zipDownloadLimiter,
};
