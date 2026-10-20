const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { slugify } = require('../utils/slug');
const upload = require('../utils/upload');
const { chargeForPhotos, usageSummary } = require('../utils/billing');
const { formatCents } = require('../utils/plans');
const googleDrive = require('../utils/googleDrive');
const dropbox = require('../utils/dropbox');
const syncJobs = require('../utils/syncJobs');
const { eventCreateLimiter, uploadLimiter, driveImportLimiter, dropboxImportLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function getOwnedEvent(req) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event || event.user_id !== req.user.id) return null;
  return event;
}

// Grid/gallery views only ever need a small preview — serving the full
// 1600px image for every tile is what made a 1000+ photo gallery painfully
// slow to load even with lazy loading (the browser still fetches the full
// file for anything that scrolls into view). Thumbnails live alongside the
// full image under a thumbs/ subfolder, named identically, so no DB column
// is needed to track the relationship — just swap the path segment.
const THUMB_MAX = 400;

async function storeImageBuffer(event, buffer, { driveFileId = null, dropboxFileId = null } = {}) {
  const eventDir = path.join(UPLOADS_DIR, event.slug);
  const thumbDir = path.join(eventDir, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });

  const filename = `${nanoid(12)}.jpg`;
  const outPath = path.join(eventDir, filename);
  const meta = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(outPath);

  await sharp(buffer)
    .rotate()
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toFile(path.join(thumbDir, filename));

  const info = db.prepare(`
    INSERT INTO photos (event_id, filename, width, height, drive_file_id, dropbox_file_id) VALUES (?, ?, ?, ?, ?, ?)
  `).run(event.id, filename, meta.width, meta.height, driveFileId, dropboxFileId);

  return {
    photoId: info.lastInsertRowid,
    url: `/uploads/${event.slug}/${filename}`,
    thumbUrl: `/uploads/${event.slug}/thumbs/${filename}`,
    width: meta.width,
    height: meta.height,
  };
}

router.get('/dashboard', requireAuth, (req, res) => {
  const events = db.prepare(`
    SELECT e.*, COUNT(p.id) AS photo_count
    FROM events e LEFT JOIN photos p ON p.event_id = e.id
    WHERE e.user_id = ?
    GROUP BY e.id ORDER BY e.created_at DESC
  `).all(req.user.id);
  res.render('dashboard', { events });
});

router.get('/events/new', requireAuth, (req, res) => {
  res.render('event-new', { error: null, title: '', eventDate: '', guestPassword: '' });
});

router.post('/events', requireAuth, eventCreateLimiter, (req, res) => {
  const title = (req.body.title || '').trim().slice(0, 150);
  const eventDate = (req.body.eventDate || '').trim().slice(0, 40);
  const guestPassword = (req.body.guestPassword || '').trim().slice(0, 200);

  if (!title) {
    return res.render('event-new', { error: 'Please give your event a name.', title, eventDate, guestPassword });
  }

  const slug = slugify(title);
  const info = db.prepare(`
    INSERT INTO events (user_id, title, slug, event_date, guest_password)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, title, slug, eventDate || null, guestPassword || null);

  fs.mkdirSync(path.join(UPLOADS_DIR, slug), { recursive: true });
  res.redirect(`/events/${info.lastInsertRowid}/manage`);
});

router.get('/events/:id/manage', requireAuth, (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).render('404');
  const photos = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM faces f WHERE f.photo_id = p.id) AS face_count
    FROM photos p WHERE p.event_id = ? ORDER BY p.created_at DESC
  `).all(event.id);
  res.render('event-manage', {
    event,
    photos,
    host: `${req.protocol}://${req.get('host')}`,
    usage: usageSummary(req.user.id, event),
    driveConfigured: Boolean(process.env.GOOGLE_API_KEY),
    dropboxConfigured: Boolean(process.env.DROPBOX_ACCESS_TOKEN),
  });
});

// Banner dimensions are fixed (not just a suggested aspect ratio) per the
// design spec — the upload is cropped to exactly fill this box, centered on
// whatever region of the source image sharp's entropy-based "attention"
// strategy finds most interesting, rather than a naive center crop.
const BANNER_WIDTH = 1905;
const BANNER_HEIGHT = 893;

router.post('/events/:id/banner', requireAuth, upload.single('banner'), async (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'No image uploaded.' });

  const eventDir = path.join(UPLOADS_DIR, event.slug);
  fs.mkdirSync(eventDir, { recursive: true });
  const filename = 'banner.jpg';

  try {
    await sharp(req.file.buffer)
      .rotate()
      .resize({ width: BANNER_WIDTH, height: BANNER_HEIGHT, fit: 'cover', position: sharp.strategy.attention })
      .jpeg({ quality: 85 })
      .toFile(path.join(eventDir, filename));
  } catch (err) {
    return res.status(400).json({ error: 'invalid_image', message: 'Could not process that image.' });
  }

  db.prepare('UPDATE events SET cover_photo = ? WHERE id = ?').run(filename, event.id);
  res.json({ ok: true, url: `/uploads/${event.slug}/${filename}?v=${Date.now()}` });
});

router.post('/events/:id/photos', requireAuth, uploadLimiter, upload.array('photos', 40), async (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const charge = chargeForPhotos(req.user.id, event, req.files.length);
  if (!charge.ok) {
    return res.status(402).json({
      error: 'insufficient_credit',
      message: `You need ${formatCents(charge.needed)} more in your balance to upload ${charge.billable} photo${charge.billable === 1 ? '' : 's'} beyond your plan's free quota.`,
      needed: charge.needed,
      balance: charge.balance,
    });
  }

  const results = [];
  for (const file of req.files) {
    try {
      results.push(await storeImageBuffer(event, file.buffer));
    } catch (err) {
      results.push({ error: err.message, originalName: file.originalname });
    }
  }

  res.json({ photos: results });
});

router.get('/events/:id/unprocessed-photos', requireAuth, (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const photos = db.prepare(`
    SELECT id, filename, width, height FROM photos WHERE event_id = ? AND faces_processed = 0 ORDER BY created_at ASC
  `).all(event.id);

  res.json({
    photos: photos.map((p) => ({
      id: p.id,
      url: `/uploads/${event.slug}/${p.filename}`,
      thumbUrl: `/uploads/${event.slug}/thumbs/${p.filename}`,
      width: p.width,
      height: p.height,
    })),
  });
});

// Runs the actual per-file download/charge/store loop in the background —
// called after the HTTP response for the *-import route has already been
// sent, so a large folder isn't held open inside one request (that's what
// caused proxy timeouts). `job` (from utils/syncJobs) is mutated in place as
// progress happens; the client polls the matching GET .../status route.
async function runImportJob(job, userId, event, toImport, downloadFile) {
  try {
    for (const file of toImport) {
      const charge = chargeForPhotos(userId, event, 1);
      if (!charge.ok) {
        job.status = 'blocked_by_billing';
        job.billing = charge;
        return;
      }
      try {
        const buffer = await downloadFile(file);
        await storeImageBuffer(event, buffer, { driveFileId: file.driveFileId, dropboxFileId: file.dropboxFileId });
        job.imported += 1;
      } catch (err) {
        console.error(`Import failed for file "${file.name}":`, err);
        job.skipped += 1;
      }
    }
    job.status = 'done';
  } catch (err) {
    console.error('Background import job crashed:', err);
    job.status = 'error';
    job.error = err.message;
  }
}

router.post('/events/:id/drive-import', requireAuth, driveImportLimiter, async (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: 'not_configured',
      message: 'Google Drive sync is not configured on this server. An administrator needs to set GOOGLE_API_KEY (with the Drive API enabled) as an environment variable.',
    });
  }

  if (syncJobs.isRunning('drive', event.id)) {
    return res.status(409).json({ error: 'sync_in_progress', message: 'A Google Drive sync is already running for this event.' });
  }

  const driveUrl = (req.body.driveUrl || '').trim().slice(0, 2000);
  const folderId = googleDrive.parseFolderId(driveUrl);
  if (!folderId) {
    return res.status(400).json({ error: 'invalid_url', message: "That doesn't look like a Google Drive folder link." });
  }

  let files;
  try {
    files = await googleDrive.listImageFiles(folderId, apiKey);
  } catch (err) {
    return res.status(502).json({ error: 'drive_error', message: `Could not read that Drive folder: ${err.message}` });
  }

  const alreadyImported = new Set(
    db.prepare('SELECT drive_file_id FROM photos WHERE event_id = ? AND drive_file_id IS NOT NULL').all(event.id)
      .map((r) => r.drive_file_id)
  );
  const toImport = files.filter((f) => !alreadyImported.has(f.id));

  if (toImport.length === 0) {
    return res.json({ started: false, skipped: files.length, message: 'Nothing new to import — all photos in that folder are already synced.' });
  }

  const job = syncJobs.start('drive', event.id, toImport.length);
  res.json({ started: true, total: toImport.length });

  runImportJob(
    job,
    req.user.id,
    event,
    toImport.map((f) => ({ ...f, driveFileId: f.id })),
    (file) => googleDrive.downloadFile(file.id, apiKey)
  );
});

router.get('/events/:id/drive-import/status', requireAuth, (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(syncJobs.get('drive', event.id) || { status: 'idle' });
});

router.post('/events/:id/dropbox-import', requireAuth, dropboxImportLimiter, async (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const accessToken = process.env.DROPBOX_ACCESS_TOKEN;
  if (!accessToken) {
    return res.status(400).json({
      error: 'not_configured',
      message: 'Dropbox sync is not configured on this server. An administrator needs to set DROPBOX_ACCESS_TOKEN as an environment variable.',
    });
  }

  if (syncJobs.isRunning('dropbox', event.id)) {
    return res.status(409).json({ error: 'sync_in_progress', message: 'A Dropbox sync is already running for this event.' });
  }

  const dropboxUrl = (req.body.dropboxUrl || '').trim().slice(0, 2000);
  if (!dropbox.isDropboxShareUrl(dropboxUrl)) {
    return res.status(400).json({ error: 'invalid_url', message: "That doesn't look like a Dropbox folder link." });
  }

  let files;
  try {
    files = await dropbox.listImageFiles(dropboxUrl, accessToken);
  } catch (err) {
    return res.status(502).json({ error: 'dropbox_error', message: `Could not read that Dropbox folder: ${err.message}` });
  }

  const alreadyImported = new Set(
    db.prepare('SELECT dropbox_file_id FROM photos WHERE event_id = ? AND dropbox_file_id IS NOT NULL').all(event.id)
      .map((r) => r.dropbox_file_id)
  );
  const toImport = files.filter((f) => !alreadyImported.has(f.id));

  if (toImport.length === 0) {
    return res.json({ started: false, skipped: files.length, message: 'Nothing new to import — all photos in that folder are already synced.' });
  }

  const job = syncJobs.start('dropbox', event.id, toImport.length);
  res.json({ started: true, total: toImport.length });

  runImportJob(
    job,
    req.user.id,
    event,
    toImport.map((f) => ({ ...f, dropboxFileId: f.id })),
    (file) => dropbox.downloadFile(dropboxUrl, file.path, accessToken)
  );
});

router.get('/events/:id/dropbox-import/status', requireAuth, (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(syncJobs.get('dropbox', event.id) || { status: 'idle' });
});

router.post('/events/:id/photos/:photoId/faces', requireAuth, (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND event_id = ?').get(req.params.photoId, event.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const numOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const faces = (Array.isArray(req.body.faces) ? req.body.faces : []).slice(0, 50);
  const insert = db.prepare(`
    INSERT INTO faces (photo_id, event_id, descriptor, box_x, box_y, box_w, box_h) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const f of rows) {
      if (!Array.isArray(f.descriptor) || f.descriptor.length !== 128) continue;
      if (!f.descriptor.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      const box = f.box || {};
      insert.run(photo.id, event.id, JSON.stringify(f.descriptor), numOr0(box.x), numOr0(box.y), numOr0(box.width), numOr0(box.height));
    }
  });
  tx(faces);

  db.prepare('UPDATE photos SET faces_processed = 1 WHERE id = ?').run(photo.id);
  res.json({ ok: true, facesStored: faces.length });
});

router.post('/events/:id/photos/:photoId/delete', requireAuth, (req, res) => {
  const event = getOwnedEvent(req);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND event_id = ?').get(req.params.photoId, event.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  db.prepare('DELETE FROM faces WHERE photo_id = ?').run(photo.id);
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  fs.unlink(path.join(UPLOADS_DIR, event.slug, photo.filename), () => {});
  fs.unlink(path.join(UPLOADS_DIR, event.slug, 'thumbs', photo.filename), () => {});

  res.json({ ok: true });
});

module.exports = router;
