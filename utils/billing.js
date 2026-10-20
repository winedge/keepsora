const db = require('../db');
const { getPlan } = require('./plans');

const PRO_PERIOD_DAYS = 30;

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function addLedgerEntry({ userId, eventId = null, type, amountCents, description }) {
  db.prepare(`
    INSERT INTO billing_ledger (user_id, event_id, type, amount_cents, description) VALUES (?, ?, ?, ?, ?)
  `).run(userId, eventId, type, amountCents, description);
  db.prepare('UPDATE users SET credit_balance_cents = credit_balance_cents + ? WHERE id = ?').run(amountCents, userId);
}

function daysBetween(aIso, bIso) {
  return (new Date(bIso) - new Date(aIso)) / (1000 * 60 * 60 * 24);
}

// Rolls a Pro subscriber into their next monthly period if the current one has
// elapsed, charging the renewal fee from their wallet. If the wallet can't
// cover it, the account lapses back to Single Event (mirrors a failed-renewal
// downgrade on a real billing system).
function ensureProPeriodCurrent(user) {
  if (user.plan !== 'pro' || !user.pro_period_start) return user;

  const now = new Date().toISOString();
  if (daysBetween(user.pro_period_start, now) < PRO_PERIOD_DAYS) return user;

  const plan = getPlan('pro');
  db.prepare('UPDATE users SET pro_period_start = ?, pro_period_photos_used = 0 WHERE id = ?').run(now, user.id);

  const fresh = getUser(user.id);
  if (fresh.credit_balance_cents >= plan.monthlyFeeCents) {
    addLedgerEntry({
      userId: user.id,
      type: 'subscription_renewal',
      amountCents: -plan.monthlyFeeCents,
      description: `Pro plan renewal (${plan.monthlyFeeCents > 0 ? `$${(plan.monthlyFeeCents / 100).toFixed(2)}` : 'free'})`,
    });
  } else {
    db.prepare("UPDATE users SET plan = 'single_event' WHERE id = ?").run(user.id);
    addLedgerEntry({
      userId: user.id,
      type: 'plan_lapsed',
      amountCents: 0,
      description: 'Pro renewal failed (insufficient balance) - moved back to Single Event',
    });
  }

  return getUser(user.id);
}

// Checks whether `count` newly uploaded/imported photos are covered by the
// event owner's plan, charging overage from their wallet balance as needed.
// Returns { ok: true, charged } on success (charge already applied), or
// { ok: false, error, needed, balance } if the wallet can't cover the overage
// — callers should reject the upload in that case, nothing is charged.
function chargeForPhotos(userId, event, count) {
  if (count <= 0) return { ok: true, charged: 0 };

  let user = ensureProPeriodCurrent(getUser(userId));

  if (user.plan === 'enterprise') {
    return { ok: true, charged: 0 };
  }

  if (user.plan === 'pro') {
    const plan = getPlan('pro');
    const includedRemaining = Math.max(0, plan.includedPhotosPerMonth - user.pro_period_photos_used);
    const billable = Math.max(0, count - includedRemaining);
    const cost = billable * plan.overagePerPhotoCents;

    if (cost > user.credit_balance_cents) {
      return { ok: false, error: 'insufficient_credit', needed: cost, balance: user.credit_balance_cents, billable };
    }

    if (cost > 0) {
      addLedgerEntry({
        userId,
        eventId: event.id,
        type: 'photo_overage',
        amountCents: -cost,
        description: `${billable} photo${billable === 1 ? '' : 's'} over your monthly Pro bundle for "${event.title}" ($${(plan.overagePerPhotoCents / 100).toFixed(2)}/photo)`,
      });
    }
    db.prepare('UPDATE users SET pro_period_photos_used = pro_period_photos_used + ? WHERE id = ?').run(count, userId);
    return { ok: true, charged: cost };
  }

  // single_event (default)
  const plan = getPlan('single_event');
  const existing = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE event_id = ?').get(event.id).c;
  const freeRemaining = Math.max(0, plan.freePhotos - existing);
  const billable = Math.max(0, count - freeRemaining);
  const cost = billable * plan.overagePerPhotoCents;

  if (cost > user.credit_balance_cents) {
    return { ok: false, error: 'insufficient_credit', needed: cost, balance: user.credit_balance_cents, billable };
  }

  if (cost > 0) {
    addLedgerEntry({
      userId,
      eventId: event.id,
      type: 'photo_overage',
      amountCents: -cost,
      description: `${billable} photo${billable === 1 ? '' : 's'} over the free ${plan.freePhotos} for "${event.title}" ($${(plan.overagePerPhotoCents / 100).toFixed(2)}/photo)`,
    });
  }
  return { ok: true, charged: cost };
}

function usageSummary(userId, event) {
  const user = ensureProPeriodCurrent(getUser(userId));
  if (user.plan === 'pro') {
    const plan = getPlan('pro');
    return {
      plan: 'pro',
      used: user.pro_period_photos_used,
      included: plan.includedPhotosPerMonth,
      overagePerPhotoCents: plan.overagePerPhotoCents,
    };
  }
  if (user.plan === 'enterprise') {
    return { plan: 'enterprise', unlimited: true };
  }
  const plan = getPlan('single_event');
  const used = event ? db.prepare('SELECT COUNT(*) AS c FROM photos WHERE event_id = ?').get(event.id).c : 0;
  return {
    plan: 'single_event',
    used,
    included: plan.freePhotos,
    overagePerPhotoCents: plan.overagePerPhotoCents,
  };
}

module.exports = { getUser, addLedgerEntry, ensureProPeriodCurrent, chargeForPhotos, usageSummary };
