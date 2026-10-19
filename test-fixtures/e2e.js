const { chromium } = require('/opt/node-tools/node_modules/playwright');
const path = require('path');

const BASE = 'http://localhost:3000';
const FIX = __dirname;

function log(...args) { console.log('[e2e]', ...args); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') log('PAGE ERROR:', msg.text()); });
  page.on('pageerror', (err) => log('PAGE EXCEPTION:', err.message));

  const email = `tester${Date.now()}@example.com`;

  log('signup...');
  await page.goto(`${BASE}/signup`);
  await page.fill('input[name=name]', 'Test Organizer');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'password123');
  await page.check('input[name=agreeToTerms]');
  await page.click('.auth-card button[type=submit]');
  await page.waitForURL(`${BASE}/dashboard`);
  log('signed up & on dashboard');

  log('creating event...');
  await page.goto(`${BASE}/events/new`);
  await page.fill('input[name=title]', 'Test Wedding E2E');
  await page.click('.auth-card button[type=submit]');
  await page.waitForURL(/\/events\/\d+\/manage/);
  log('event created, on manage page:', page.url());

  await page.waitForFunction(() => document.getElementById('modelStatus').textContent.includes('Ready'), { timeout: 30000 });
  log('models ready on manage page');

  const shareLink = await page.inputValue('#shareLink');
  log('share link:', shareLink);
  const slug = shareLink.split('/e/')[1];

  log('uploading 3 event photos...');
  const files = [
    path.join(FIX, 'event-photo-obama-solo.jpg'),
    path.join(FIX, 'event-photo-biden-different-person.jpg'),
    path.join(FIX, 'event-photo-stranger.jpg'),
  ];
  await page.setInputFiles('#fileInput', files);

  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll('#uploadList .upload-status');
      if (items.length < 3) return false;
      return [...items].every((el) => /Done|failed|Error/.test(el.textContent));
    },
    { timeout: 60000 }
  );

  const uploadResults = await page.$$eval('#uploadList .upload-item', (items) =>
    items.map((i) => ({ name: i.querySelector('.upload-name').textContent, status: i.querySelector('.upload-status').textContent }))
  );
  log('upload results:', JSON.stringify(uploadResults, null, 2));

  const managePhotos = await page.$$eval('#photoGrid .photo-tile', (els) =>
    els.map((el) => ({ id: el.dataset.photoId, src: el.querySelector('img').getAttribute('src') }))
  );
  log('photo tiles in manage grid:', JSON.stringify(managePhotos));

  // Uploaded in order: solo (Obama), biden (different person), stranger (Messi). Tiles are prepended, so grid order is reversed.
  const urlStranger = managePhotos[0].src;
  const urlBiden = managePhotos[1].src;
  const urlSolo = managePhotos[2].src;

  log('navigating to guest gallery...');
  await page.goto(`${BASE}/e/${slug}`);
  await page.waitForFunction(() => document.getElementById('matchStatus').textContent.includes('Ready'), { timeout: 30000 });

  const allPhotosCount = await page.waitForFunction(
    () => document.querySelectorAll('#photoGrid .photo-tile').length > 0 && document.querySelectorAll('#photoGrid .photo-tile').length
  ).then((h) => h.jsonValue());
  log('all photos shown in gallery:', allPhotosCount);

  log('uploading selfie to find matches...');
  await page.setInputFiles('#selfieInput', path.join(FIX, 'selfie-obama.jpg'));

  await page.waitForFunction(
    () => {
      const t = document.getElementById('matchStatus').textContent;
      return t.includes('Here are the photos') || t.includes("didn't find") || t.includes('Error');
    },
    { timeout: 30000 }
  );

  const matchStatusText = await page.$eval('#matchStatus', (el) => el.textContent);
  const gridLabelText = await page.$eval('#gridLabel', (el) => el.textContent);
  const matchedUrls = await page.$$eval('#photoGrid .photo-tile img', (imgs) => imgs.map((i) => i.getAttribute('src')));

  log('match status:', matchStatusText);
  log('grid label:', gridLabelText);
  log('matched photo urls:', matchedUrls);

  const gotSolo = matchedUrls.includes(urlSolo);
  const gotBiden = matchedUrls.includes(urlBiden);
  const gotStranger = matchedUrls.includes(urlStranger);
  const pass = gotSolo && !gotBiden && !gotStranger && matchedUrls.length === 1;

  console.log('\n=== RESULT SUMMARY ===');
  console.log('Matched second photo of the SAME person (Obama):', gotSolo, '(expected true)');
  console.log('Matched different person (Biden) photo:', gotBiden, '(expected false)');
  console.log('Matched unrelated stranger (Messi) photo:', gotStranger, '(expected false)');
  console.log('Total matches:', matchedUrls.length, '(expected 1)');
  console.log(pass ? 'PASS: face matching worked correctly end-to-end.' : 'FAIL: unexpected match results.');
  console.log('===\n');

  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error('[e2e] FAILED:', err);
  process.exit(1);
});
