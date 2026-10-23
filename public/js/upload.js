(function () {
  const EVENT_ID = document.body.dataset.eventId;
  const modelStatus = document.getElementById('modelStatus');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const uploadList = document.getElementById('uploadList');
  const photoGrid = document.getElementById('photoGrid');
  const copyBtn = document.getElementById('copyLinkBtn');
  const shareLink = document.getElementById('shareLink');
  const photoCountLabel = document.getElementById('photoCountLabel');
  const faceDetectionBanner = document.getElementById('faceDetectionBanner');
  const faceDetectionStatus = document.getElementById('faceDetectionStatus');
  const billingBanner = document.getElementById('billingBanner');

  const driveForm = document.getElementById('driveForm');
  const driveUrlInput = document.getElementById('driveUrlInput');
  const driveStatus = document.getElementById('driveStatus');

  const dropboxForm = document.getElementById('dropboxForm');
  const dropboxUrlInput = document.getElementById('dropboxUrlInput');
  const dropboxStatus = document.getElementById('dropboxStatus');

  const bannerForm = document.getElementById('bannerForm');
  const bannerInput = document.getElementById('bannerInput');
  const bannerStatus = document.getElementById('bannerStatus');

  let photoCount = photoGrid.querySelectorAll('.photo-tile').length;
  function updatePhotoCount() {
    photoCountLabel.textContent = `${photoCount} photo${photoCount === 1 ? '' : 's'} in this event`;
  }

  function showBillingBanner(message) {
    if (!billingBanner) return;
    billingBanner.innerHTML = `${message} <a href="/billing">Go to billing →</a>`;
    billingBanner.hidden = false;
  }

  let modelsReady = false;

  async function loadModels() {
    const MODEL_URL = '/models';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    modelsReady = true;
    modelStatus.textContent = 'Ready - face detection will run automatically on upload.';
    startDetectionPoller();
  }

  function addListItem(name) {
    const li = document.createElement('li');
    li.className = 'upload-item';
    li.innerHTML = `<span class="upload-name">${name}</span><span class="upload-status">Uploading…</span>`;
    uploadList.prepend(li);
    return li;
  }

  function addPhotoTile(photoId, url, faceCount, thumbUrl) {
    const div = document.createElement('div');
    div.className = 'photo-tile';
    div.dataset.photoId = photoId;
    div.innerHTML = `
      <img src="${thumbUrl || url}" loading="lazy">
      <span class="face-badge">${faceCount} face${faceCount === 1 ? '' : 's'}</span>
      <button class="delete-btn" data-id="${photoId}" title="Delete photo">✕</button>
    `;
    photoGrid.prepend(div);
    wireDelete(div.querySelector('.delete-btn'));
    photoCount += 1;
    updatePhotoCount();
  }

  function updateTileBadge(photoId, faceCount) {
    const tile = photoGrid.querySelector(`.photo-tile[data-photo-id="${photoId}"]`);
    if (!tile) return;
    const badge = tile.querySelector('.face-badge');
    if (badge) badge.textContent = `${faceCount} face${faceCount === 1 ? '' : 's'}`;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function detectAndStoreFaces(photoId, url) {
    if (!modelsReady) return 0;
    const img = await loadImage(url);
    const detections = await faceapi
      .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    const faces = detections.map((d) => ({
      descriptor: Array.from(d.descriptor),
      box: { x: d.detection.box.x, y: d.detection.box.y, width: d.detection.box.width, height: d.detection.box.height },
    }));

    // Always tell the server this photo was looked at — that's what marks it
    // faces_processed (see routes/events.js), even with an empty faces list.
    // Skipping the call for a genuine zero-face result left it permanently
    // "unprocessed": retried on every poll forever, stalling the counter.
    await fetch(`/events/${EVENT_ID}/photos/${photoId}/faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faces }),
    });
    return faces.length;
  }

  let pendingInFlight = false;
  // `photos`, when given, skips the fetch — callers that already have a
  // fresh unprocessed-photos list (detectionPollTick's polling loop) pass it
  // through instead of hitting the same endpoint twice per tick.
  async function processPendingPhotos(photos) {
    if (!modelsReady || pendingInFlight) return;
    pendingInFlight = true;
    try {
      if (!photos) {
        const res = await fetch(`/events/${EVENT_ID}/unprocessed-photos`);
        const data = await res.json();
        photos = data.photos;
      }
      for (const p of photos || []) {
        // A background Drive/Dropbox sync stores photos without the client
        // ever seeing a per-file list, so the tile may not exist yet.
        if (!photoGrid.querySelector(`.photo-tile[data-photo-id="${p.id}"]`)) {
          addPhotoTile(p.id, p.url, 0, p.thumbUrl);
        }
        try {
          const faceCount = await detectAndStoreFaces(p.id, p.url);
          updateTileBadge(p.id, faceCount);
        } catch {
          // leave the tile's badge as-is; a later visit will retry
        }
      }
    } finally {
      pendingInFlight = false;
    }
  }

  async function uploadOne(file, listItem) {
    const form = new FormData();
    form.append('photos', file);

    const uploadRes = await fetch(`/events/${EVENT_ID}/photos`, { method: 'POST', body: form });

    if (uploadRes.status === 402) {
      const data = await uploadRes.json();
      listItem.querySelector('.upload-status').textContent = 'Blocked - insufficient balance';
      const err = new Error(data.message || 'Insufficient balance');
      err.insufficientCredit = true;
      err.message2 = data.message;
      throw err;
    }

    const uploadJson = await uploadRes.json();
    const result = (uploadJson.photos || [])[0];
    if (!result || result.error) {
      listItem.querySelector('.upload-status').textContent = 'Upload failed';
      return;
    }

    listItem.querySelector('.upload-status').textContent = 'Detecting faces…';
    const faceCount = await detectAndStoreFaces(result.photoId, result.url);
    listItem.querySelector('.upload-status').textContent = `Done - ${faceCount} face${faceCount === 1 ? '' : 's'} found`;
    addPhotoTile(result.photoId, result.url, faceCount, result.thumbUrl);
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /^image\//.test(f.type));
    for (const file of files) {
      const li = addListItem(file.name);
      try {
        await uploadOne(file, li);
      } catch (err) {
        if (err.insufficientCredit) {
          showBillingBanner(err.message2 || 'You have run out of free photos for this event.');
          break;
        }
        li.querySelector('.upload-status').textContent = 'Error: ' + err.message;
      }
    }
  }

  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-active');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-active');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  function wireDelete(btn) {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Delete this photo?')) return;
      const res = await fetch(`/events/${EVENT_ID}/photos/${id}/delete`, { method: 'POST' });
      if (res.ok) {
        btn.closest('.photo-tile').remove();
        photoCount -= 1;
        updatePhotoCount();
      }
    });
  }
  document.querySelectorAll('.delete-btn').forEach(wireDelete);

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareLink.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    } catch {
      shareLink.select();
    }
  });

  if (driveForm) {
    driveForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const driveUrl = driveUrlInput.value.trim();
      if (driveUrl) startBackgroundSync('drive', driveForm, { driveUrl }, driveStatus);
    });
  }

  if (dropboxForm) {
    dropboxForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const dropboxUrl = dropboxUrlInput.value.trim();
      if (dropboxUrl) startBackgroundSync('dropbox', dropboxForm, { dropboxUrl }, dropboxStatus);
    });
  }

  if (bannerForm) {
    bannerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = bannerInput.files[0];
      if (!file) return;

      const button = bannerForm.querySelector('button');
      button.disabled = true;
      bannerStatus.textContent = 'Uploading banner…';

      try {
        const form = new FormData();
        form.append('banner', file);
        const res = await fetch(`/events/${EVENT_ID}/banner`, { method: 'POST', body: form });
        const data = await res.json();

        if (!res.ok) {
          bannerStatus.textContent = data.message || data.error || 'Could not upload banner.';
          return;
        }

        let preview = document.getElementById('bannerPreview');
        if (!preview) {
          preview = document.createElement('img');
          preview.id = 'bannerPreview';
          preview.className = 'banner-preview';
          preview.alt = 'Current banner';
          bannerForm.parentElement.insertBefore(preview, bannerForm);
        }
        preview.src = data.url;
        bannerStatus.textContent = 'Banner updated.';
        bannerInput.value = '';
      } catch (err) {
        bannerStatus.textContent = 'Error: ' + err.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  // Kicks off a Drive/Dropbox folder sync (the server runs the actual
  // download/resize/save loop as a background job — see routes/events.js —
  // so a big folder doesn't hold an HTTP request open past any proxy
  // timeout) and polls .../{source}-import/status until it's done, adding
  // photo tiles and running face detection as photos land via the same
  // processPendingPhotos() the direct-upload flow uses.
  async function startBackgroundSync(source, form, body, statusEl) {
    const button = form.querySelector('button');
    button.disabled = true;
    statusEl.textContent = `Starting ${source === 'drive' ? 'Google Drive' : 'Dropbox'} sync…`;

    try {
      const res = await fetch(`/events/${EVENT_ID}/${source}-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        statusEl.textContent = data.message || data.error || `Could not start the ${source} sync.`;
        return;
      }

      if (!data.started) {
        statusEl.textContent = data.message || 'No new images found in that folder.';
        return;
      }

      statusEl.textContent = `Syncing ${data.total} photo${data.total === 1 ? '' : 's'} in the background - you can leave this page and come back.`;

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await processPendingPhotos();

        const statusRes = await fetch(`/events/${EVENT_ID}/${source}-import/status`);
        const job = await statusRes.json();

        if (job.status === 'running') {
          statusEl.textContent = `Syncing… ${job.imported} imported, ${job.skipped} skipped so far (of ${job.total}).`;
          continue;
        }

        if (job.status === 'blocked_by_billing') {
          showBillingBanner("You've used up your plan's free photo quota, so the sync stopped partway through.");
        } else if (job.status === 'error') {
          statusEl.textContent = `Sync error: ${job.error || 'something went wrong.'} ${job.imported} photo${job.imported === 1 ? '' : 's'} made it in before that.`;
          return;
        }

        statusEl.textContent = `Done - ${job.imported} imported${job.skipped ? `, ${job.skipped} skipped` : ''}. Detecting faces in the background…`;
        return;
      }
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    } finally {
      button.disabled = false;
    }
  }

  // Persistent background poller for the top banner — runs for as long as the
  // page is open, not a fixed number of tries, so it never needs a reload to
  // "keep going": it naturally keeps picking up newly-synced photos too,
  // since it's just checking the same unprocessed-photos list every tick
  // rather than a one-shot pass taken right after a particular sync.
  let detectionPollTimer = null;

  async function detectionPollTick() {
    let remaining = 0;
    try {
      const res = await fetch(`/events/${EVENT_ID}/unprocessed-photos`);
      const data = await res.json();
      remaining = (data.photos || []).length;

      if (remaining > 0) {
        if (faceDetectionBanner) faceDetectionBanner.hidden = false;
        if (faceDetectionStatus) faceDetectionStatus.textContent = `Detecting faces… ${remaining} photo${remaining === 1 ? '' : 's'} left.`;
        await processPendingPhotos(data.photos);
      } else if (faceDetectionBanner) {
        faceDetectionBanner.hidden = true;
      }
    } catch {
      // transient network hiccup — the next tick retries on its own
    }
  }

  function startDetectionPoller() {
    if (detectionPollTimer) return;
    detectionPollTick();
    detectionPollTimer = setInterval(detectionPollTick, 3000);
  }

  loadModels().catch((err) => {
    modelStatus.textContent = 'Could not load face recognition models: ' + err.message;
  });
})();
