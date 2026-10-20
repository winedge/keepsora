const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'keepsora.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'single_event',
  plan_started_at TEXT,
  credit_balance_cents INTEGER NOT NULL DEFAULT 0,
  pro_period_start TEXT,
  pro_period_photos_used INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_suspended INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  event_date TEXT,
  guest_password TEXT,
  cover_photo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER REFERENCES events(id),
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enterprise_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Guest-submitted reports of an event gallery (inappropriate/illegal content,
-- someone's photos shared without consent, etc.) so misuse an operator
-- wouldn't otherwise see has a path to get surfaced and reviewed in /admin.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  filename TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  faces_processed INTEGER NOT NULL DEFAULT 0,
  drive_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL REFERENCES photos(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  descriptor TEXT NOT NULL,
  box_x REAL, box_y REAL, box_w REAL, box_h REAL
);

-- Processed Stripe webhook event ids, so a retried delivery (Stripe retries
-- on anything but a 2xx) can't double-credit a wallet or double-activate a
-- subscription.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_event ON photos(event_id);
CREATE INDEX IF NOT EXISTS idx_faces_event ON faces(event_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON billing_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_event ON reports(event_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
`);

// Added after the initial release — guarded so it's safe to run against an
// existing database that predates Dropbox sync (SQLite has no
// "ADD COLUMN IF NOT EXISTS", so a duplicate-column error is just ignored).
try {
  db.exec('ALTER TABLE photos ADD COLUMN dropbox_file_id TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) throw err;
}

// Promote a designated admin account by email (e.g. after it's set for the
// first time, or if the account was created before ADMIN_EMAIL was set).
if (process.env.ADMIN_EMAIL) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(process.env.ADMIN_EMAIL.trim().toLowerCase());
}

module.exports = db;
