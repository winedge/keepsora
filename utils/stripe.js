// Real Stripe integration, opt-in via STRIPE_SECRET_KEY — same graceful-
// degradation pattern as GOOGLE_API_KEY (Drive sync) and TURNSTILE_SITE_KEY
// (bot check). When the key isn't set, `stripeConfigured()` is false and
// routes/billing.js falls back to the original instant-demo billing so the
// app still works with zero setup.

let stripeClient = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) {
    // Lazy require + init so the `stripe` package never touches the network
    // (or needs a key) unless it's actually configured.
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function webhookConfigured() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

async function getOrCreateCustomer(stripe, user) {
  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: String(user.id) },
  });
  return customer.id;
}

// One-time payment Checkout session for a wallet top-up.
async function createTopupCheckout({ user, amountCents, baseUrl }) {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(stripe, user);

  return stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: { name: 'Keepsora wallet top-up' },
        },
        quantity: 1,
      },
    ],
    metadata: { userId: String(user.id), kind: 'topup', amountCents: String(amountCents) },
    success_url: `${baseUrl}/billing/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/billing/checkout/cancel`,
  });
}

// Recurring subscription Checkout session for the Pro plan. The price is
// created inline (price_data) so no Stripe Dashboard setup is required —
// consistent with this app's "just add an API key" setup pattern.
async function createProSubscriptionCheckout({ user, monthlyFeeCents, baseUrl }) {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(stripe, user);

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: monthlyFeeCents,
          recurring: { interval: 'month' },
          product_data: { name: 'Keepsora Pro' },
        },
        quantity: 1,
      },
    ],
    metadata: { userId: String(user.id), kind: 'pro_subscription' },
    success_url: `${baseUrl}/billing/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/billing/checkout/cancel`,
  });
}

// Stripe-hosted portal for managing/cancelling the subscription and payment
// methods — no UI of our own to build or maintain for this.
async function createPortalSession({ user, baseUrl }) {
  const stripe = getStripe();
  if (!user.stripe_customer_id) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${baseUrl}/billing`,
  });
  return session;
}

async function cancelSubscription(subscriptionId) {
  const stripe = getStripe();
  return stripe.subscriptions.cancel(subscriptionId);
}

module.exports = {
  getStripe,
  stripeConfigured,
  webhookConfigured,
  createTopupCheckout,
  createProSubscriptionCheckout,
  createPortalSession,
  cancelSubscription,
};
