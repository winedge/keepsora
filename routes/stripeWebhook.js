const db = require('../db');
const { getStripe, stripeConfigured, webhookConfigured } = require('../utils/stripe');
const { addLedgerEntry } = require('../utils/billing');

function alreadyProcessed(eventId) {
  const existing = db.prepare('SELECT id FROM stripe_events WHERE id = ?').get(eventId);
  if (existing) return true;
  db.prepare('INSERT INTO stripe_events (id) VALUES (?)').run(eventId);
  return false;
}

function handleTopupCompleted(session) {
  const userId = Number(session.metadata.userId);
  const amountCents = Number(session.metadata.amountCents);
  if (!userId || !Number.isFinite(amountCents) || amountCents <= 0) return;

  addLedgerEntry({
    userId,
    type: 'stripe_topup',
    amountCents,
    description: `Added funds via Stripe — $${(amountCents / 100).toFixed(2)} (session ${session.id})`,
  });
}

function handleProSubscriptionCompleted(session) {
  const userId = Number(session.metadata.userId);
  if (!userId) return;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users
    SET plan = 'pro', plan_started_at = ?, pro_period_start = ?, pro_period_photos_used = 0,
        stripe_customer_id = ?, stripe_subscription_id = ?
    WHERE id = ?
  `).run(now, now, session.customer, session.subscription, userId);

  addLedgerEntry({
    userId,
    type: 'stripe_subscription_started',
    amountCents: 0,
    description: `Pro subscription started via Stripe (subscription ${session.subscription})`,
  });
}

function handleSubscriptionDeleted(subscription) {
  const user = db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subscription.id);
  if (!user) return;

  db.prepare(`
    UPDATE users SET plan = 'single_event', stripe_subscription_id = NULL WHERE id = ?
  `).run(user.id);

  addLedgerEntry({
    userId: user.id,
    type: 'stripe_subscription_ended',
    amountCents: 0,
    description: 'Pro subscription ended (cancelled or payment failed) — moved back to Single Event',
  });
}

module.exports = function stripeWebhookHandler(req, res) {
  if (!stripeConfigured() || !webhookConfigured()) {
    return res.status(400).send('Stripe webhooks are not configured on this server.');
  }

  const stripe = getStripe();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (alreadyProcessed(event.id)) {
    return res.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'payment' && session.metadata?.kind === 'topup') {
          handleTopupCompleted(session);
        } else if (session.mode === 'subscription' && session.metadata?.kind === 'pro_subscription') {
          handleProSubscriptionCompleted(session);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        handleSubscriptionDeleted(event.data.object);
        break;
      }
      default:
        // Unhandled event types are acknowledged so Stripe stops retrying.
        break;
    }
  } catch (err) {
    console.error('Error processing Stripe webhook event', event.type, err);
    return res.status(500).json({ error: 'webhook_processing_failed' });
  }

  res.json({ received: true });
};
