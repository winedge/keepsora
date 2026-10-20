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
  const billingBanner = document.getElementById('billingBanner');

  const driveForm = document.getElementById('driveForm');
  const driveUrlInput = document.getElementById('driveUrlInput');
  const driveStatus = document.getElementById('driveStatus');

  const dropboxForm = document.getElementById('dropboxForm');
  const dropboxUrlInput = document.getElementById('dropboxUrlInput');
  const dropboxStatus = document.getElementById('dropboxStatus');

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
    modelStatus.textContent = 'Ready — face detection will run automatically on upload.';
    processPendingPhotos();
  }

  function addListItem(name) {
    const li = document.createElement('li');
    li.className = 'upload-item';
    li.innerHTML = `<span class="upload-name">${name}</span><span class="upload-status">Uploading…</span>`;
    uploadList.prepend(li);
    return li;
  }

  function addPhotoTile(photoId, url, faceCount) {
    const div = document.createElement('div');
    div.className = 'photo-tile';
    div.dataset.photoId = photoId;
    div.innerHTML = `
      <img src="${url}" loading="lazy">
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
      .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.4 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    const faces = detections.map((d) => ({
      descriptor: Array.from(d.descriptor),
      box: { x: d.detection.box.x, y: d.detection.box.y, width: d.detection.box.width, height: d.detection.box.height },
    }));

    if (faces.length > 0) {
      await fetch(`/events/${EVENT_ID}/photos/${photoId}/faces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faces }),
      });
    }
    return faces.length;
  }

  let pendingInFlight = false;
  async function processPendingPhotos() {
    if (!modelsReady || pendingInFlight) return;
    pendingInFlight = true;
    try {
      const res = await fetch(`/events/${EVENT_ID}/unprocessed-photos`);
      const data = await res.json();
      for (const p of data.photos || []) {
        // A background Drive/Dropbox sync stores photos without the client
        // ever seeing a per-file list, so the tile may not exist yet.
        if (!photoGrid.querySelector(`.photo-tile[data-photo-id="${p.id}"]`)) {
          addPhotoTile(p.id, p.url, 0);
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
      listItem.querySelector('.upload-status').textContent = 'Blocked — insufficient balance';
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
    listItem.querySelector('.upload-status').textContent = `Done — ${faceCount} face${faceCount === 1 ? '' : 's'} found`;
    addPhotoTile(result.photoId, result.url, faceCount);
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

      statusEl.textContent = `Syncing ${data.total} photo${data.total === 1 ? '' : 's'} in the background — you can leave this page and come back.`;

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

        await waitForFaceDetection(job, statusEl);
        return;
      }
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    } finally {
      button.disabled = false;
    }
  }

  // The import itself finishing just means every photo landed on disk —
  // face detection (processPendingPhotos, which runs in-browser against each
  // unprocessed photo) still has to work through the whole batch afterward,
  // which for dozens of photos can take a while. Keep polling and showing
  // progress until nothing's left, instead of declaring victory the moment
  // the import's HTTP side is done and leaving the page looking stalled.
  async function waitForFaceDetection(job, statusEl) {
    const MAX_PASSES = 60; // ~2.5 min of 2.5s ticks before giving up and saying so
    let remaining = Infinity;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const res = await fetch(`/events/${EVENT_ID}/unprocessed-photos`);
      const data = await res.json();
      remaining = (data.photos || []).length;
      if (remaining === 0) break;

      statusEl.textContent = `Imported — now detecting faces… ${remaining} photo${remaining === 1 ? '' : 's'} left.`;
      await processPendingPhotos();
    }

    const importedLine = `${job.imported} imported${job.skipped ? `, ${job.skipped} skipped` : ''}`;
    statusEl.textContent = remaining === 0
      ? `Done — ${importedLine}, faces detected.`
      : `${importedLine}. Face detection is still working through ${remaining} photo${remaining === 1 ? '' : 's'} — reload the page to keep it going.`;
  }

  loadModels().catch((err) => {
    modelStatus.textContent = 'Could not load face recognition models: ' + err.message;
  });
})();
