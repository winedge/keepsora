const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

router.get('/admin', requireAdmin, (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    events: db.prepare('SELECT COUNT(*) AS c FROM events').get().c,
    photos: db.prepare('SELECT COUNT(*) AS c FROM photos').get().c,
    openReports: db.prepare("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'").get().c,
  };

  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.plan, u.is_admin, u.is_suspended, u.suspended_reason, u.created_at,
           COUNT(e.id) AS event_count
    FROM users u LEFT JOIN events e ON e.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at DESC
  `).all();

  const events = db.prepare(`
    SELECT e.id, e.title, e.slug, e.created_at, u.email AS owner_email,
           (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) AS photo_count
    FROM events e JOIN users u ON u.id = e.user_id
    ORDER BY e.created_at DESC LIMIT 100
  `).all();

  const reports = db.prepare(`
    SELECT r.*, e.title AS event_title, e.slug AS event_slug
    FROM reports r JOIN events e ON e.id = r.event_id
    ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 100
  `).all();

  const leads = db.prepare('SELECT * FROM enterprise_leads ORDER BY created_at DESC LIMIT 50').all();

  res.render('admin', { stats, users, events, reports, leads, notice: req.query.notice || null });
});

router.post('/admin/users/:id/suspend', requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.redirect('/admin?notice=You+cannot+suspend+your+own+account.');
  }
  const reason = (req.body.reason || '').trim().slice(0, 300) || null;
  db.prepare('UPDATE users SET is_suspended = 1, suspended_reason = ? WHERE id = ?').run(reason, targetId);
  res.redirect('/admin?notice=User+suspended.');
});

router.post('/admin/users/:id/unsuspend', requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET is_suspended = 0, suspended_reason = NULL WHERE id = ?').run(Number(req.params.id));
  res.redirect('/admin?notice=User+unsuspended.');
});

router.post('/admin/events/:id/delete', requireAdmin, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.redirect('/admin?notice=Event+not+found.');

  const photos = db.prepare('SELECT * FROM photos WHERE event_id = ?').all(event.id);
  db.prepare('DELETE FROM faces WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM photos WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM reports WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM billing_ledger WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(event.id);

  for (const p of photos) {
    fs.unlink(path.join(UPLOADS_DIR, event.slug, p.filename), () => {});
  }
  fs.rmdir(path.join(UPLOADS_DIR, event.slug), () => {});

  res.redirect('/admin?notice=Event+deleted.');
});

router.post('/admin/reports/:id/resolve', requireAdmin, (req, res) => {
  db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(req.params.id);
  res.redirect('/admin?notice=Report+marked+resolved.');
});

module.exports = router;
