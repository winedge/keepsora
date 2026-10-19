const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authLimiter } = require('../middleware/rateLimiters');
const { isHoneypotTripped, isDisposableEmail, turnstileConfigured, verifyTurnstile } = require('../utils/botProtection');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('signup', { error: null, name: '', email: '', turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null });
});

router.post('/signup', authLimiter, async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 100);
  const email = (req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password = req.body.password || '';
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || null;

  if (isHoneypotTripped(req.body)) {
    // Don't tip off the bot — pretend it worked.
    return res.redirect('/login');
  }

  if (!name || !EMAIL_RE.test(email) || password.length < 8 || password.length > 200) {
    return res.render('signup', {
      error: 'Please fill in your name, a valid email, and a password of 8–200 characters.',
      name, email, turnstileSiteKey,
    });
  }

  if (req.body.agreeToTerms !== 'on') {
    return res.render('signup', {
      error: 'Please confirm you have the right to share these photos and will inform guests about face recognition before uploading.',
      name, email, turnstileSiteKey,
    });
  }

  if (isDisposableEmail(email)) {
    return res.render('signup', {
      error: 'Please use a permanent email address (disposable/temporary email domains are not accepted).',
      name, email, turnstileSiteKey,
    });
  }

  if (turnstileConfigured()) {
    const verified = await verifyTurnstile(req.body['cf-turnstile-response'], req.ip);
    if (!verified) {
      return res.render('signup', { error: 'Please complete the verification and try again.', name, email, turnstileSiteKey });
    }
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.render('signup', { error: 'An account with that email already exists.', name, email, turnstileSiteKey });
  }

  const hash = bcrypt.hashSync(password, 10);
  const isAdmin = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.trim().toLowerCase() ? 1 : 0;
  const info = db.prepare('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)').run(email, name, hash, isAdmin);
  req.session.userId = info.lastInsertRowid;
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { error: null, email: '' });
});

router.post('/login', authLimiter, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password = (req.body.password || '').slice(0, 200);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Incorrect email or password.', email });
  }

  if (user.is_suspended) {
    return res.render('login', {
      error: `This account has been suspended${user.suspended_reason ? `: ${user.suspended_reason}` : '.'} Contact support if you believe this is a mistake.`,
      email,
    });
  }

  req.session.userId = user.id;
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = router;
