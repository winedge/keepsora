const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PLANS, formatCents } = require('../utils/plans');
const { getUser, addLedgerEntry, ensureProPeriodCurrent, usageSummary } = require('../utils/billing');
const { billingLimiter, contactFormLimiter } = require('../middleware/rateLimiters');
const { isHoneypotTripped } = require('../utils/botProtection');
const stripeUtil = require('../utils/stripe');

const router = express.Router();

const TOPUP_PRESETS_CENTS = [500, 1000, 2500, 5000];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fixed message codes instead of reflecting free-form query-string text back
// into the page — avoids using this account's own billing page as a vehicle
// for arbitrary (if auto-escaped) attacker-supplied text via a crafted link.
const NOTICES = {
  topup_ok: (cents) => `Added ${formatCents(cents)} to your balance.`,
  already_pro: () => 'You are already on the Pro plan.',
  upgraded: () => 'Welcome to Pro! Unlimited events are now unlocked.',
  downgraded: () => 'Moved back to the Single Event plan.',
  stripe_success: () => "Payment received — this can take a few seconds to show up below while Stripe confirms it.",
  stripe_cancelled: () => 'Checkout was cancelled — nothing was charged.',
};
const ERRORS = {
  invalid_amount: () => 'Enter a valid amount (between $0.01 and $1,000).',
  need_more_for_upgrade: (cents) => `Add at least ${formatCents(cents)} to upgrade to Pro.`,
  stripe_error: () => 'Something went wrong talking to Stripe. Please try again.',
  stripe_not_configured: () => 'Payments are not configured on this server yet.',
};

function resolveMessage(map, code, amountParam) {
  const fn = map[code];
  if (!fn) return null;
  const amount = parseInt(amountParam, 10);
  return fn(Number.isFinite(amount) ? amount : 0);
}

function baseUrlFor(req) {
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/pricing', (req, res) => {
  const currentPlan = req.user ? getUser(req.user.id).plan : null;
  res.render('pricing', { plans: PLANS, currentPlan });
});

router.get('/billing', requireAuth, (req, res) => {
  const user = ensureProPeriodCurrent(getUser(req.user.id));
  const ledger = db.prepare(`
    SELECT l.*, e.title AS event_title FROM billing_ledger l
    LEFT JOIN events e ON e.id = l.event_id
    WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 50
  `).all(user.id);

  res.render('billing', {
    user,
    plans: PLANS,
    ledger,
    formatCents,
    presets: TOPUP_PRESETS_CENTS,
    usage: usageSummary(user.id, null),
    stripeConfigured: stripeUtil.stripeConfigured(),
    notice: resolveMessage(NOTICES, req.query.notice, req.query.amt),
    error: resolveMessage(ERRORS, req.query.error, req.query.amt),
  });
});

router.post('/billing/topup', requireAuth, billingLimiter, async (req, res) => {
  const amountCents = parseInt(req.body.amountCents, 10);
  if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 100000) {
    return res.redirect('/billing?error=invalid_amount');
  }

  if (stripeUtil.stripeConfigured()) {
    try {
      const session = await stripeUtil.createTopupCheckout({ user: getUser(req.user.id), amountCents, baseUrl: baseUrlFor(req) });
      // Persist the Stripe customer id the first time it's created.
      db.prepare('UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?').run(session.customer, req.user.id);
      return res.redirect(303, session.url);
    } catch (err) {
      console.error('Stripe topup checkout error:', err.message);
      return res.redirect('/billing?error=stripe_error');
    }
  }

  // Demo billing (no STRIPE_SECRET_KEY set): any "card" instantly succeeds —
  // no real payment is processed.
  addLedgerEntry({
    userId: req.user.id,
    type: 'topup',
    amountCents,
    description: `Added funds (demo checkout, no real charge) — ${formatCents(amountCents)}`,
  });

  res.redirect(`/billing?notice=topup_ok&amt=${amountCents}`);
});

router.post('/billing/upgrade', requireAuth, billingLimiter, async (req, res) => {
  const user = getUser(req.user.id);
  const plan = PLANS.pro;

  if (user.plan === 'pro') {
    return res.redirect('/billing?notice=already_pro');
  }

  if (stripeUtil.stripeConfigured()) {
    try {
      const session = await stripeUtil.createProSubscriptionCheckout({
        user, monthlyFeeCents: plan.monthlyFeeCents, baseUrl: baseUrlFor(req),
      });
      db.prepare('UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?').run(session.customer, user.id);
      return res.redirect(303, session.url);
    } catch (err) {
      console.error('Stripe subscription checkout error:', err.message);
      return res.redirect('/billing?error=stripe_error');
    }
  }

  // Demo billing: upgrade is charged instantly from the demo wallet balance.
  if (user.credit_balance_cents < plan.monthlyFeeCents) {
    return res.redirect(`/billing?error=need_more_for_upgrade&amt=${plan.monthlyFeeCents}`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET plan = 'pro', plan_started_at = ?, pro_period_start = ?, pro_period_photos_used = 0 WHERE id = ?
  `).run(now, now, user.id);

  addLedgerEntry({
    userId: user.id,
    type: 'subscription_charge',
    amountCents: -plan.monthlyFeeCents,
    description: `Upgraded to Pro — first month (${formatCents(plan.monthlyFeeCents)})`,
  });

  res.redirect('/billing?notice=upgraded');
});

router.post('/billing/downgrade', requireAuth, billingLimiter, async (req, res) => {
  const user = getUser(req.user.id);

  if (stripeUtil.stripeConfigured() && user.stripe_subscription_id) {
    try {
      await stripeUtil.cancelSubscription(user.stripe_subscription_id);
    } catch (err) {
      console.error('Stripe subscription cancel error:', err.message);
      return res.redirect('/billing?error=stripe_error');
    }
  }

  db.prepare("UPDATE users SET plan = 'single_event', stripe_subscription_id = NULL WHERE id = ?").run(req.user.id);
  res.redirect('/billing?notice=downgraded');
});

// Stripe-hosted portal for updating/cancelling payment methods — no UI of
// our own needed. Only reachable once a Stripe customer exists (i.e. after
// at least one real Checkout session).
router.get('/billing/portal', requireAuth, async (req, res) => {
  if (!stripeUtil.stripeConfigured()) {
    return res.redirect('/billing?error=stripe_not_configured');
  }
  const user = getUser(req.user.id);
  if (!user.stripe_customer_id) {
    return res.redirect('/billing?error=stripe_not_configured');
  }
  try {
    const session = await stripeUtil.createPortalSession({ user, baseUrl: baseUrlFor(req) });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe portal session error:', err.message);
    res.redirect('/billing?error=stripe_error');
  }
});

router.get('/billing/checkout/success', requireAuth, (req, res) => {
  res.redirect('/billing?notice=stripe_success');
});

router.get('/billing/checkout/cancel', requireAuth, (req, res) => {
  res.redirect('/billing?notice=stripe_cancelled');
});

router.get('/enterprise-contact', (req, res) => {
  res.render('enterprise-contact', { error: null, sent: false, name: '', email: '', company: '', message: '' });
});

router.post('/enterprise-contact', contactFormLimiter, (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 100);
  const email = (req.body.email || '').trim().slice(0, 254);
  const company = (req.body.company || '').trim().slice(0, 150);
  const message = (req.body.message || '').trim().slice(0, 2000);

  if (isHoneypotTripped(req.body)) {
    // Don't tip off the bot — pretend it was sent.
    return res.render('enterprise-contact', { error: null, sent: true, name: '', email: '', company: '', message: '' });
  }

  if (!name || !EMAIL_RE.test(email)) {
    return res.render('enterprise-contact', { error: 'Please share your name and email.', sent: false, name, email, company, message });
  }

  db.prepare(`
    INSERT INTO enterprise_leads (user_id, name, email, company, message) VALUES (?, ?, ?, ?, ?)
  `).run(req.user ? req.user.id : null, name, email, company || null, message || null);

  res.render('enterprise-contact', { error: null, sent: true, name: '', email: '', company: '', message: '' });
});

module.exports = router;
