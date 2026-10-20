// Reconstructed from memzo.ai's public pricing page and FAQ (single-event
// pay-per-photo plan, a multi-event subscription, and contact-only enterprise
// tier). Exact live numbers may have since changed — see README for sourcing
// notes. SINGLE_EVENT_FREE_PHOTOS can be overridden for local testing.

const SINGLE_EVENT_FREE_PHOTOS = Number(process.env.SINGLE_EVENT_FREE_PHOTOS) || 300;

const PLANS = {
  single_event: {
    key: 'single_event',
    name: 'Single Event',
    tagline: 'For couples and one-off hosts running 1–3 events a year',
    monthlyFeeCents: 0,
    freePhotos: SINGLE_EVENT_FREE_PHOTOS, // free photos, per event
    overagePerPhotoCents: 3, // $0.03/photo pay-as-you-go beyond the free quota
    commissionPct: 0, // 0% commission if you sell photos to guests
    retentionYears: 2,
    features: [
      `First ${SINGLE_EVENT_FREE_PHOTOS} photos free per event (face recognition included)`,
      '$0.03 per photo after that - pay only for what you use',
      'Unlimited guests per event',
      'Sell photos to guests, keep 100% - 0% commission',
      '2 years of photo storage & access',
      'Optional password-protected gallery',
    ],
  },
  pro: {
    key: 'pro',
    name: 'Pro / Multi-Event',
    tagline: 'For photographers & organizers running multiple events a year',
    monthlyFeeCents: 2900, // $29/mo
    includedPhotosPerMonth: 3000,
    overagePerPhotoCents: 2, // discounted $0.02/photo beyond the bundle
    commissionPct: 0,
    retentionYears: 2,
    features: [
      'Unlimited events',
      '3,000 photos included every month',
      '$0.02 per photo beyond that - cheaper than pay-as-you-go',
      'Everything in Single Event, plus priority support',
      'Google Drive folder sync for bulk imports',
    ],
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    tagline: 'Custom volume, invoicing & SLAs for large organizations',
    contactOnly: true,
    features: [
      'Custom photo & event volume',
      'Dedicated support & onboarding',
      'Custom contracts & invoicing',
      'Everything in Pro',
    ],
  },
};

function getPlan(key) {
  return PLANS[key] || PLANS.single_event;
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

module.exports = { PLANS, getPlan, formatCents, SINGLE_EVENT_FREE_PHOTOS };
