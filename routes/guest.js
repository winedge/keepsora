const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('../db');
const { euclideanDistance, MATCH_THRESHOLD } = require('../utils/match');
const { safeEqual } = require('../utils/safeCompare');
const { guestUnlockLimiter, matchLimiter, reportLimiter, zipDownloadLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const MAX_ZIP_PHOTOS = 300;

function findEvent(slug) {
  // Hide galleries belonging to a suspended organizer — same 404 guests would
  // see for a slug that never existed, so it doesn't signal anything about
  // why (consistent with not revealing more than necessary).
  return db.prepare(`
    SELECT e.* FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.slug = ? AND u.is_suspended = 0
  `).get(slug);
}

function isUnlocked(req, event) {
  if (!event.guest_password) return true;
  return Array.isArray(req.session.unlockedEvents) && req.session.unlockedEvents.includes(event.id);
}

router.get('/e/:slug', (req, res) => {
  const event = findEvent(req.params.slug);
  if (!event) return res.status(404).render('404');

  if (!isUnlocked(req, event)) {
    return res.render('event-gate', { event, error: null });
  }

  res.render('event-gallery', { event });
});

router.post('/e/:slug/unlock', guestUnlockLimiter, (req, res) => {
  const event = findEvent(req.params.slug);
  if (!event) return res.status(404).render('404');

  const password = (req.body.password || '').trim().slice(0, 200);
  if (event.guest_password && !safeEqual(password, event.guest_password)) {
    return res.render('event-gate', { event, error: 'That password is incorrect.' });
  }

  req.session.unlockedEvents = req.session.unlockedEvents || [];
  if (!req.session.unlockedEvents.includes(event.id)) {
    req.session.unlockedEvents.push(event.id);
  }
  res.redirect(`/e/${event.slug}`);
});

router.get('/api/events/:slug/photos', (req, res) => {
  const event = findEvent(req.params.slug);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!isUnlocked(req, event)) return res.status(403).json({ error: 'locked' });

  const photos = db.prepare('SELECT id, filename, width, height FROM photos WHERE event_id = ? ORDER BY created_at DESC').all(event.id);
  res.json({
    event: { title: event.title, date: event.event_date },
    photos: photos.map((p) => ({
      id: p.id,
      url: `/uploads/${event.slug}/${p.filename}`,
      thumbUrl: `/uploads/${event.slug}/thumbs/${p.filename}`,
      width: p.width,
      height: p.height,
    })),
  });
});

router.post('/api/events/:slug/match', matchLimiter, (req, res) => {
  const event = findEvent(req.params.slug);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!isUnlocked(req, event)) return res.status(403).json({ error: 'locked' });

  const descriptor = req.body.descriptor;
  if (!Array.isArray(descriptor) || descriptor.length !== 128 || !descriptor.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return res.status(400).json({ error: 'A valid 128-length face descriptor is required.' });
  }

  const faces = db.prepare(`
    SELECT f.photo_id, f.descriptor, p.filename, p.width, p.height
    FROM faces f JOIN photos p ON p.id = f.photo_id
    WHERE f.event_id = ?
  `).all(event.id);

  const bestByPhoto = new Map();
  for (const row of faces) {
    let vec;
    try {
      vec = JSON.parse(row.descriptor);
    } catch {
      continue;
    }
    const dist = euclideanDistance(descriptor, vec);
    if (dist > MATCH_THRESHOLD) continue;
    const prev = bestByPhoto.get(row.photo_id);
    if (!prev || dist < prev.dist) {
      bestByPhoto.set(row.photo_id, { dist, filename: row.filename, width: row.width, height: row.height });
    }
  }

  const matches = [...bestByPhoto.entries()]
    .sort((a, b) => a[1].dist - b[1].dist)
    .map(([photoId, v]) => ({
      id: photoId,
      url: `/uploads/${event.slug}/${v.filename}`,
      thumbUrl: `/uploads/${event.slug}/thumbs/${v.filename}`,
      width: v.width,
      height: v.height,
      distance: v.dist,
    }));

  res.json({ matches, threshold: MATCH_THRESHOLD });
});

router.post('/e/:slug/download-zip', zipDownloadLimiter, (req, res) => {
  const event = findEvent(req.params.slug);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!isUnlocked(req, event)) return res.status(403).json({ error: 'locked' });

  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((n) => Number.isInteger(n)).slice(0, MAX_ZIP_PHOTOS) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'no_photos', message: 'No photos selected.' });

  const placeholders = ids.map(() => '?').join(',');
  const photos = db.prepare(`
    SELECT id, filename FROM photos WHERE event_id = ? AND id IN (${placeholders})
  `).all(event.id, ...ids);

  if (photos.length === 0) return res.status(404).json({ error: 'not_found', message: 'None of those photos were found.' });

  res.attachment(`${event.slug}-photos.zip`);
  res.type('application/zip');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('Zip download failed:', err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  for (const photo of photos) {
    const filePath = path.join(UPLOADS_DIR, event.slug, photo.filename);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: photo.filename });
    }
  }

  archive.finalize();
});

const REPORT_REASONS = new Set(['inappropriate', 'no_consent', 'spam_or_scam', 'other']);

router.post('/e/:slug/report', reportLimiter, (req, res) => {
  const event = findEvent(req.params.slug);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const reason = REPORT_REASONS.has(req.body.reason) ? req.body.reason : 'other';
  const details = (req.body.details || '').trim().slice(0, 1000) || null;

  db.prepare('INSERT INTO reports (event_id, reason, details) VALUES (?, ?, ?)').run(event.id, reason, details);
  res.json({ ok: true });
});

module.exports = router;
