// One-off maintenance script: generates the thumbs/ variant for every photo
// stored before thumbnail support existed. Safe to re-run — skips any photo
// that already has a thumbnail. Run manually on the server after deploying
// the thumbnail change:
//   node scripts/backfill-thumbnails.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const db = require('../db');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const THUMB_MAX = 400;

async function main() {
  const rows = db.prepare(`
    SELECT p.filename, e.slug FROM photos p JOIN events e ON e.id = p.event_id
  `).all();

  let created = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  for (const row of rows) {
    const fullPath = path.join(UPLOADS_DIR, row.slug, row.filename);
    const thumbDir = path.join(UPLOADS_DIR, row.slug, 'thumbs');
    const thumbPath = path.join(thumbDir, row.filename);

    if (fs.existsSync(thumbPath)) {
      skipped += 1;
      continue;
    }
    if (!fs.existsSync(fullPath)) {
      missing += 1;
      continue;
    }

    try {
      fs.mkdirSync(thumbDir, { recursive: true });
      await sharp(fullPath)
        .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toFile(thumbPath);
      created += 1;
      if (created % 50 === 0) console.log(`  ...${created} thumbnails created so far`);
    } catch (err) {
      console.error(`Failed to thumbnail ${row.slug}/${row.filename}:`, err.message);
      failed += 1;
    }
  }

  console.log(`Done. Created ${created}, already had one ${skipped}, source file missing ${missing}, failed ${failed} (of ${rows.length} total).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
