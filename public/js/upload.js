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
    driveForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const driveUrl = driveUrlInput.value.trim();
      if (!driveUrl) return;

      driveStatus.textContent = 'Importing from Google Drive… this can take a minute for large folders.';
      driveForm.querySelector('button').disabled = true;

      try {
        const res = await fetch(`/events/${EVENT_ID}/drive-import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ driveUrl }),
        });
        const data = await res.json();

        if (res.status === 402) {
          showBillingBanner(data.message || 'You have run out of free photos for this event.');
          driveStatus.textContent = '';
          return;
        }

        if (!res.ok) {
          driveStatus.textContent = data.message || data.error || 'Could not import from Google Drive.';
          return;
        }

        for (const p of data.imported || []) {
          addPhotoTile(p.photoId, p.url, 0);
        }

        const parts = [];
        if (data.imported?.length) parts.push(`${data.imported.length} photo${data.imported.length === 1 ? '' : 's'} imported`);
        if (data.skipped) parts.push(`${data.skipped} skipped`);
        driveStatus.textContent = parts.length ? parts.join(', ') + '. Detecting faces…' : 'No new images found in that folder.';

        if (data.stoppedForBilling) {
          showBillingBanner("You've used up your plan's free photo quota, so the import stopped partway through.");
        }

        await processPendingPhotos();
        if (data.imported?.length) {
          driveStatus.textContent = `${data.imported.length} photo${data.imported.length === 1 ? '' : 's'} imported and scanned for faces.`;
        }
      } catch (err) {
        driveStatus.textContent = 'Error: ' + err.message;
      } finally {
        driveForm.querySelector('button').disabled = false;
      }
    });
  }

  if (dropboxForm) {
    dropboxForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dropboxUrl = dropboxUrlInput.value.trim();
      if (!dropboxUrl) return;

      dropboxStatus.textContent = 'Importing from Dropbox… this can take a minute for large folders.';
      dropboxForm.querySelector('button').disabled = true;

      try {
        const res = await fetch(`/events/${EVENT_ID}/dropbox-import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dropboxUrl }),
        });
        const data = await res.json();

        if (res.status === 402) {
          showBillingBanner(data.message || 'You have run out of free photos for this event.');
          dropboxStatus.textContent = '';
          return;
        }

        if (!res.ok) {
          dropboxStatus.textContent = data.message || data.error || 'Could not import from Dropbox.';
          return;
        }

        for (const p of data.imported || []) {
          addPhotoTile(p.photoId, p.url, 0);
        }

        const parts = [];
        if (data.imported?.length) parts.push(`${data.imported.length} photo${data.imported.length === 1 ? '' : 's'} imported`);
        if (data.skipped) parts.push(`${data.skipped} skipped`);
        dropboxStatus.textContent = parts.length ? parts.join(', ') + '. Detecting faces…' : 'No new images found in that folder.';

        if (data.stoppedForBilling) {
          showBillingBanner("You've used up your plan's free photo quota, so the import stopped partway through.");
        }

        await processPendingPhotos();
        if (data.imported?.length) {
          dropboxStatus.textContent = `${data.imported.length} photo${data.imported.length === 1 ? '' : 's'} imported and scanned for faces.`;
        }
      } catch (err) {
        dropboxStatus.textContent = 'Error: ' + err.message;
      } finally {
        dropboxForm.querySelector('button').disabled = false;
      }
    });
  }

  loadModels().catch((err) => {
    modelStatus.textContent = 'Could not load face recognition models: ' + err.message;
  });
})();
