const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const multer = require('multer');

const { loadUser } = require('./middleware/auth');
const { globalLimiter } = require('./middleware/rateLimiters');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Running behind a reverse proxy (common in production) is assumed so that
// req.secure / req.protocol and the rate limiter's IP detection are correct.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Cloudflare Turnstile (optional bot-check widget) needs its script, iframe
// and verify XHR allow-listed — only added to the CSP when it's actually
// configured, so the default (no keys set) CSP stays maximally strict.
const turnstileEnabled = Boolean(process.env.TURNSTILE_SITE_KEY);
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...(turnstileEnabled ? [TURNSTILE_ORIGIN] : [])],
        // Inline style attributes are used for a couple of server-computed
        // numeric widths (progress bars) — no user input ever lands in a
        // style attribute, so this is a low-risk, narrowly-scoped relaxation.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...(turnstileEnabled ? [TURNSTILE_ORIGIN] : [])],
        frameSrc: turnstileEnabled ? [TURNSTILE_ORIGIN] : ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Stripe webhooks: raw body (needed for signature verification) and no rate
// limiting (a payment confirmation must never get dropped) — registered
// before the JSON body parser and the global rate limiter apply to everything
// else below.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), require('./routes/stripeWebhook'));

app.use(globalLimiter);

// Keep search engines and well-behaved crawlers out of private event galleries
// and raw uploaded photos. This is not an access control (the password gate
// and unguessable slugs are), just a defense against guest photos showing up
// in image search or being bulk-scraped by a crawler that ignores robots.txt.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /e/\nDisallow: /uploads/\nDisallow: /api/\n');
});
app.use(['/e', '/uploads', '/api'], (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '2mb' }));

app.use(cookieSession({
  name: 'keepsora.sid',
  keys: [process.env.SESSION_SECRET || 'dev-secret-change-me'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
}));

if (!process.env.SESSION_SECRET && isProduction) {
  console.warn('WARNING: SESSION_SECRET is not set. Set it to a long random value in production.');
}

app.use(loadUser);

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/models', express.static(path.join(__dirname, 'public', 'models')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.render('landing'));
app.get('/terms', (req, res) => res.render('terms'));

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/events'));
app.use('/', require('./routes/guest'));
app.use('/', require('./routes/billing'));
app.use('/', require('./routes/admin'));

app.use((req, res) => res.status(404).render('404'));

function wantsJson(req) {
  return /^\/(api|events)\//.test(req.path) || req.xhr || req.accepts(['html', 'json']) === 'json';
}

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (max 15MB).' : err.message;
    return res.status(400).json({ error: 'upload_error', message });
  }

  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  const message = isProduction && status === 500 ? 'Something went wrong. Please try again.' : err.message;

  if (wantsJson(req)) {
    return res.status(status).json({ error: 'server_error', message });
  }
  res.status(status).send(message);
});

app.listen(PORT, () => {
  console.log(`Keepsora listening on http://localhost:${PORT}`);
});
