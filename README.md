# Keepsora

An event photo-sharing app where guests take a selfie and instantly get back only the photos
they're in, using face recognition. No app install needed; everything runs in the browser.

(Originally built as a clone of [memzo.ai](https://memzo.ai)'s product concept, now developed
under its own name and brand, Keepsora.)

## How it works

- **Organizers** sign up, create an event, and bulk-upload the event's photos.
- On upload, [face-api.js](https://github.com/vladmandic/face-api) runs **in the browser**
  (tiny face detector + 68-point landmarks + a ResNet face recognition model) to turn every
  face in every photo into a 128-number descriptor. Those descriptors are sent to the server
  and stored in SQLite — the photos themselves are just resized and saved to disk.
- Organizers get one shareable gallery link, optionally protected with a password.
- **Guests** open that link, take or upload a selfie. The selfie is turned into a descriptor
  *in their own browser* (never uploaded) and sent to the server, which compares it against
  every stored face descriptor for that event (Euclidean distance, threshold 0.55) and returns
  only the matching photos.
- Guests can also favorite photos (saved locally) and download them.
- Organizers can also bulk-import photos from a **public Google Drive folder** link instead
  of (or in addition to) uploading files directly.

All face-recognition model weights and the face-api.js library are vendored locally under
`public/models` and `public/vendor` — the app works fully offline, no external CDN required.

The whole UI is responsive (phone/tablet/desktop) and has been checked with a headless-browser
script for horizontal overflow on every page.

## Pricing & billing

`/pricing` and `/billing` reconstruct memzo.ai's public pricing model (the live site wasn't
reachable to scrape directly, so this is based on what its pricing/FAQ pages and third-party
write-ups say — treat exact numbers as approximate, not a guaranteed-current quote):

- **Single Event** (default, free to start) — first 300 photos per event are free, then
  $0.03/photo pay-as-you-go. 0% commission if you sell photos to guests. 2-year retention.
- **Pro / Multi-Event** — $29/month, 3,000 photos included per month across unlimited events,
  then $0.02/photo overage. Unlocks Google Drive sync.
- **Enterprise** — contact-sales only, no self-serve pricing (matches the real product).

There's a per-user wallet (`credit_balance_cents`) that pay-as-you-go photo overage is deducted
from, and a ledger (`billing_ledger` table) recording every top-up, subscription event, and
overage charge. Uploading or Drive-importing more photos than a plan's free quota allows is
blocked with a 402 response until the organizer adds funds. `SINGLE_EVENT_FREE_PHOTOS` env var
overrides the free quota (useful for testing the overage flow without uploading 300 photos).

**Two modes, same codebase:**
- **No `STRIPE_SECRET_KEY` set (default):** a self-contained demo — the "top up" form always
  succeeds instantly (it doesn't store or transmit whatever's typed into the fake card fields,
  there's no real payment processor involved) and "Upgrade to Pro" charges the demo wallet
  directly. Nothing here ever touches a real payment network. This is what runs out of the box.
- **`STRIPE_SECRET_KEY` set:** real payments via Stripe Checkout (see below) — the demo card
  fields disappear, "Add funds" and "Upgrade to Pro" redirect to Stripe's hosted checkout, and a
  webhook credits the wallet / activates the subscription once Stripe confirms payment.

## Real payments (Stripe)

Set these to switch wallet top-ups and the Pro subscription from the demo flow above to real
Stripe Checkout — no code changes needed, no Stripe Dashboard setup required (prices are created
inline via the API on first use):

```bash
STRIPE_SECRET_KEY=sk_test_...        # from your Stripe dashboard, test mode is free
STRIPE_WEBHOOK_SECRET=whsec_...      # from `stripe listen` locally, or a configured endpoint in prod
npm start
```

**What's wired up:**
- **Wallet top-ups** — a one-time Stripe Checkout session (`mode: 'payment'`) for whatever amount
  the organizer picks.
- **Pro plan subscription** — a recurring Stripe Checkout session (`mode: 'subscription'`,
  $29/month) that keeps renewing until cancelled.
- **Downgrading** — calls `stripe.subscriptions.cancel` directly so the organizer actually stops
  being charged, not just a local DB flip.
- **"Manage billing on Stripe"** — a Stripe-hosted Billing Portal session, so card updates and
  self-serve cancellation need no UI of our own.
- **Webhook** (`POST /webhooks/stripe`, raw body + signature-verified via
  `stripe.webhooks.constructEvent`) handles `checkout.session.completed` (credits the wallet for a
  topup, or activates Pro for a subscription) and `customer.subscription.deleted` (downgrades back
  to Single Event if Stripe cancels it — failed renewal, etc.). Every event is checked against a
  `stripe_events` table first so a retried webhook delivery can't double-credit a wallet or
  double-activate a subscription.

**Local webhook testing:** install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then:
```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```
It prints a `whsec_...` value — use that as `STRIPE_WEBHOOK_SECRET` for local testing.

**Testing note:** this was built and the webhook logic was fully verified (topup crediting,
duplicate-event idempotency, Pro activation, Pro cancellation) by simulating correctly-signed
webhook deliveries locally — this sandbox's network couldn't reach `api.stripe.com` directly, so
a real end-to-end Checkout round-trip hasn't been exercised here. The integration follows Stripe's
documented API closely enough that this should work as-is, but **test it yourself in Stripe test
mode with a real test card (`4242 4242 4242 4242`) before processing a real organizer's payment.**

## Google Drive sync

Set `GOOGLE_API_KEY` (a Google Cloud API key with the **Drive API** enabled) as an environment
variable to turn this on. It only needs an API key, not OAuth, because it only reads folders
shared as "Anyone with the link can view." Without the key set, the sync form on the event
management page shows a clear "not configured" message instead of failing silently.

```bash
GOOGLE_API_KEY=your-key-here npm start
```

Already-imported files are tracked by Google Drive file ID so re-running a sync only pulls in
new photos. Imported photos go through the same resize → face-detect pipeline as a normal
upload (detection runs client-side on the organizer's next page load/sync, since it needs a
browser).

## Security

- **Rate limiting** (`express-rate-limit`) on every state-changing or abuse-prone endpoint:
  login/signup share a combined 20-per-15-min limit per IP, the guest password gate is capped
  at 20 attempts per 10 min, photo uploads at 300/15 min, Google Drive sync at 10/10 min (it
  triggers real external API calls), selfie matching at 60/10 min, event creation at 30/hour,
  billing actions at 30/15 min, the enterprise contact form at 10/hour, plus a 600/15 min
  global baseline on every request. Limited responses return `429` with a small JSON/text body.
- **Security headers** via `helmet`, including a strict Content-Security-Policy (`script-src
  'self'` only — no inline scripts anywhere in the app, no external CDNs) and
  `X-Frame-Options: SAMEORIGIN` to prevent clickjacking.
- **Session cookies** are `httpOnly`, `sameSite: 'lax'` (the primary CSRF defense — it blocks
  cookies on cross-site form POSTs while allowing the app's own same-origin requests), and
  `secure` when `NODE_ENV=production`. `app.set('trust proxy', 1)` so this and the rate limiter
  work correctly behind a reverse proxy.
- **Auth hardening**: passwords require 8–200 characters, email format is validated, bcrypt
  (cost 10) for password hashes, generic "incorrect email or password" errors (no account
  enumeration).
- **Guest event password** is compared with a constant-time check (`crypto.timingSafeEqual`
  over SHA-256 digests) instead of `===`, so response timing can't be used to guess it
  character-by-character.
- **Upload validation** is defense-in-depth: multer's `fileFilter` rejects anything but
  declared `image/jpeg|png|webp`, then `sharp` has to successfully decode the actual bytes as a
  real image before anything is stored — a spoofed `Content-Type` on a non-image file fails
  cleanly at the sharp step instead of getting written to disk.
- **Input length caps** everywhere user text is stored (names, event titles, passwords, contact
  form fields, etc.) and strict type/length checks on face descriptors and bounding boxes before
  they're persisted.
- **Error responses** don't leak internals in production (`NODE_ENV=production` swaps raw error
  messages for a generic one on unexpected 500s; multer errors like "file too large" are
  returned as clean 400s instead of propagating as server errors).
- Billing "notice"/"error" banners use fixed message codes resolved server-side rather than
  reflecting free-form query-string text back into the page (even though EJS already
  auto-escapes it, this avoids using the app's own links as a phishing/content-spoofing vector).

**Not implemented** (reasonable next steps for a production deployment, out of scope for this
demo): CSRF tokens (relying on `SameSite=Lax` instead — fine for this app's same-origin usage,
but a token-based scheme is more robust if the app grows), a persistent/shared rate-limit store
(the in-memory store resets on restart and doesn't share state across multiple server
instances — swap in a Redis-backed store for horizontal scaling), and account lockout/alerting
on repeated failed logins beyond what the rate limiter already provides.

## Bot protection & misuse prevention

- **Honeypot fields** on signup and the enterprise contact form — an invisible input real users
  never see or fill; any request that fills it is silently accepted-but-discarded rather than
  telling the bot it was caught.
- **Disposable email blocking** on signup (`utils/botProtection.js`), with a built-in list of
  common temp-mail domains, extendable via `DISPOSABLE_EMAIL_DOMAINS`.
- **Optional Cloudflare Turnstile** (a free, privacy-respecting CAPTCHA alternative) on signup —
  set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to turn it on; the CSP only allow-lists
  Cloudflare's domain when these are configured, so the default (no keys) CSP stays maximally
  strict. Untested against live Turnstile in this environment (no keys available here) but
  implemented per Cloudflare's documented siteverify API.
- **`robots.txt` + `X-Robots-Tag: noindex`** on `/e/*`, `/uploads/*`, `/api/*` so guest galleries
  and raw photos don't end up indexed by search engines or casually scraped.
- **Guest reporting**: every gallery has a "Report this gallery" link (no consent / inappropriate
  content / spam / other) that lands in `/admin` for review — this is the main way an operator
  finds out about misuse they wouldn't otherwise see.
- **Admin panel** (`/admin`, gated by `is_admin`): view every user/event/report/enterprise lead,
  suspend or unsuspend a user (with a reason), delete an abusive event outright. Set
  `ADMIN_EMAIL` to the account that should be promoted to admin (applied on signup, and
  retroactively to an existing account on server start).
- **Suspension enforcement**: a suspended account can't log in (shown the reason), an
  already-logged-in session is killed on its very next request, and every one of that account's
  event galleries immediately 404s for guests (same response as a gallery that never existed —
  doesn't reveal why).
- **Consent checkbox + biometric data notice**: signup requires confirming the organizer has the
  right to share the photos and will tell guests about face recognition before uploading, linking
  to a `/terms` page that explains what the app does with faces and flags the real legal exposure
  around biometric data (BIPA, GDPR, etc. — see that page, and the caveats in the SOC 2 doc below).

None of this replaces actual content moderation (e.g. automated NSFW/illegal-content scanning via
a vision API) — that's a reasonable next addition if this were deployed for real, uncurated
public uploads, but it requires a paid third-party service this environment couldn't set up.

## Running it

```bash
npm install
npm start
```

Then open http://localhost:3000. Useful environment variables (all optional):

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL` | Promotes the matching account to admin (`/admin` access) |
| `GOOGLE_API_KEY` | Enables Google Drive folder sync |
| `DROPBOX_ACCESS_TOKEN` | Enables Dropbox folder sync (generate from a Dropbox App Console app) |
| `STRIPE_SECRET_KEY` | Enables real Stripe Checkout for top-ups and the Pro subscription |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook signatures (required alongside the above) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Enables Cloudflare Turnstile on signup |
| `DISPOSABLE_EMAIL_DOMAINS` | Comma-separated extra domains to block at signup |
| `SINGLE_EVENT_FREE_PHOTOS` | Overrides the free-photo quota (default 300), handy for testing |
| `SESSION_SECRET` | Session cookie signing key — set a long random value in production |
| `NODE_ENV=production` | Enables secure cookies and hides internal error messages |

## Tech stack

- Express + EJS (server-rendered pages, no build step)
- better-sqlite3 for storage
- sharp for image resizing on upload
- face-api.js (client-side, TensorFlow.js) for all face detection/recognition
- cookie-session for organizer auth and the guest password gate
- Google Drive API v3 (REST, via an API key) for folder sync
- express-rate-limit + helmet for rate limiting and security headers
- Optional: Cloudflare Turnstile for bot-resistant signup
- Optional: Stripe (official `stripe` SDK) for real Checkout + subscriptions + webhooks

## Project layout

```
server.js            entry point
db.js                SQLite schema
routes/               auth.js, events.js (organizer + uploads + Drive sync),
                      guest.js (public gallery + matching API + reports),
                      billing.js (pricing/billing/Stripe Checkout), admin.js (moderation panel),
                      stripeWebhook.js (webhook handler, mounted on raw-body route in server.js)
middleware/           auth.js (session -> req.user, requireAuth/requireAdmin guards),
                      rateLimiters.js (per-route express-rate-limit configs)
utils/                slug generation, multer config, match distance helper,
                      plans.js (pricing config), billing.js (wallet/quota logic),
                      googleDrive.js (Drive API v3 client), safeCompare.js (constant-time
                      compare), botProtection.js (honeypot/disposable-email/Turnstile),
                      stripe.js (Checkout sessions, Billing Portal, subscription cancel)
views/                EJS templates (including admin.ejs, terms.ejs)
public/css, public/js upload.js (organizer face enrollment + Drive sync UI),
                      match.js (guest selfie search + report form), billing.js (top-up form),
                      admin.js (delete-confirmation, CSP-safe — no inline handlers)
public/models         vendored face-api.js model weights
public/vendor         vendored face-api.js library
public/images         brand logo assets (logo-icon.png used in the nav)
public/favicon*, apple-touch-icon.png   generated from the logo mark
uploads/              event photo storage (gitignored)
test-fixtures/        e2e.js — a Playwright script that signs up, creates an event,
                      uploads real photos of two different people, and verifies a
                      selfie match returns only the correct person's photo
```

## Known simplifications vs. the real memzo.ai

- Photos are served from predictable (but random-suffixed) URLs rather than behind
  per-request signed access control.
- Real Stripe Checkout/subscriptions/webhooks are wired up (see "Real payments" above) but
  haven't been exercised in a live end-to-end test from this environment — verify in Stripe test
  mode before taking real organizer payments.
- Pricing numbers are reconstructed from public search results, not scraped live from the
  site, since it wasn't reachable from this environment.
- Matching threshold (0.55) is fixed rather than auto-tuned per event.
