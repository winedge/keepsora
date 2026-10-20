(function () {
  const SLUG = document.body.dataset.eventSlug;
  const matchStatus = document.getElementById('matchStatus');
  const selfieInput = document.getElementById('selfieInput');
  const selfiePreview = document.getElementById('selfiePreview');
  const selfieAvatarIcon = document.querySelector('.selfie-avatar-icon');
  const selfieSpinner = document.getElementById('selfieSpinner');
  const clearMatchBtn = document.getElementById('clearMatchBtn');
  const openCameraBtn = document.getElementById('openCameraBtn');

  const cameraModal = document.getElementById('cameraModal');
  const cameraVideo = document.getElementById('cameraVideo');
  const cameraCanvas = document.getElementById('cameraCanvas');
  const cameraCloseBtn = document.getElementById('cameraCloseBtn');
  const captureBtn = document.getElementById('captureBtn');
  const uploadInsteadBtn = document.getElementById('uploadInsteadBtn');
  const cameraError = document.getElementById('cameraError');
  const photoGrid = document.getElementById('photoGrid');
  const gridLabel = document.getElementById('gridLabel');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxDownload = document.getElementById('lightboxDownload');
  const lightboxClose = document.getElementById('lightboxClose');

  const selectModeBtn = document.getElementById('selectModeBtn');
  const selectionBar = document.getElementById('selectionBar');
  const selectionCount = document.getElementById('selectionCount');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  const cancelSelectBtn = document.getElementById('cancelSelectBtn');

  const reportToggleBtn = document.getElementById('reportToggleBtn');
  const reportForm = document.getElementById('reportForm');
  const reportCancelBtn = document.getElementById('reportCancelBtn');
  const reportStatus = document.getElementById('reportStatus');

  reportToggleBtn.addEventListener('click', () => {
    reportForm.hidden = !reportForm.hidden;
  });
  reportCancelBtn.addEventListener('click', () => {
    reportForm.hidden = true;
  });
  reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    reportStatus.textContent = 'Sending…';
    try {
      const res = await fetch(`/e/${SLUG}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: document.getElementById('reportReason').value,
          details: document.getElementById('reportDetails').value,
        }),
      });
      if (res.ok) {
        reportStatus.textContent = 'Thanks — our team will take a look.';
        reportForm.querySelector('button[type=submit]').disabled = true;
      } else {
        reportStatus.textContent = 'Something went wrong. Please try again later.';
      }
    } catch (err) {
      reportStatus.textContent = 'Something went wrong. Please try again later.';
    }
  });

  function setStatus(text, state) {
    matchStatus.textContent = text;
    matchStatus.className = 'selfie-status' + (state ? ` state-${state}` : '');
  }

  function setBusy(busy) {
    selfieSpinner.hidden = !busy;
  }

  const favKey = `keepsora-favs-${SLUG}`;
  function getFavs() {
    try {
      return JSON.parse(localStorage.getItem(favKey) || '[]');
    } catch {
      return [];
    }
  }
  function toggleFav(id) {
    const favs = getFavs();
    const idx = favs.indexOf(id);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push(id);
    try {
      localStorage.setItem(favKey, JSON.stringify(favs));
    } catch {}
    return favs.includes(id);
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
    setStatus('Ready — take or upload a selfie to find your photos.', 'ready');
  }

  let selectMode = false;
  const selectedIds = new Set();

  function updateSelectionBar() {
    selectionCount.textContent = `${selectedIds.size} selected`;
    downloadSelectedBtn.disabled = selectedIds.size === 0;
  }

  function setSelectMode(on) {
    selectMode = on;
    photoGrid.classList.toggle('select-mode', on);
    selectionBar.hidden = !on;
    selectModeBtn.textContent = on ? 'Cancel selecting' : 'Select photos';
    if (!on) {
      selectedIds.clear();
      photoGrid.querySelectorAll('.photo-tile.selected').forEach((t) => t.classList.remove('selected'));
    }
    updateSelectionBar();
  }

  function toggleTileSelected(div, id) {
    const nowSelected = !selectedIds.has(id);
    if (nowSelected) selectedIds.add(id);
    else selectedIds.delete(id);
    div.classList.toggle('selected', nowSelected);
    updateSelectionBar();
  }

  function renderPhotos(photos) {
    photoGrid.innerHTML = '';
    selectedIds.clear();
    updateSelectionBar();
    if (photos.length === 0) {
      photoGrid.innerHTML = '<p class="muted">No photos yet.</p>';
      return;
    }
    const favs = getFavs();
    for (const p of photos) {
      const div = document.createElement('div');
      div.className = 'photo-tile';
      div.dataset.photoId = p.id;
      const isFav = favs.includes(p.id);
      const dims = p.width && p.height ? ` width="${p.width}" height="${p.height}"` : '';
      div.innerHTML = `
        <img src="${p.thumbUrl || p.url}" loading="lazy"${dims}>
        <span class="select-check"></span>
        <button class="fav-btn ${isFav ? 'active' : ''}" data-id="${p.id}" title="Favorite">★</button>
      `;
      div.addEventListener('click', (e) => {
        if (selectMode) {
          e.stopPropagation();
          toggleTileSelected(div, p.id);
        } else {
          openLightbox(p.url);
        }
      });
      div.querySelector('.fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const active = toggleFav(p.id);
        e.target.classList.toggle('active', active);
      });
      photoGrid.appendChild(div);
    }
  }

  function openLightbox(url) {
    lightboxImg.src = url;
    lightboxDownload.href = url;
    lightbox.hidden = false;
  }
  lightboxClose.addEventListener('click', () => (lightbox.hidden = true));
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.hidden = true;
  });

  async function loadAllPhotos() {
    gridLabel.textContent = 'All photos';
    const res = await fetch(`/api/events/${SLUG}/photos`);
    const data = await res.json();
    renderPhotos(data.photos || []);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function processSelfieBlob(blob) {
    const objectUrl = URL.createObjectURL(blob);
    selfiePreview.src = objectUrl;
    selfiePreview.hidden = false;
    selfieAvatarIcon.hidden = true;

    if (!modelsReady) {
      setStatus('Still loading face recognition models, please wait…', 'busy');
      return;
    }

    setBusy(true);
    setStatus('Detecting your face…', 'busy');
    try {
      const img = await loadImage(objectUrl);
      const detection = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        setStatus("We couldn't detect a clear face in that photo. Try a brighter, front-facing selfie.", 'error');
        return;
      }

      setStatus('Searching the gallery…', 'busy');
      const res = await fetch(`/api/events/${SLUG}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptor: Array.from(detection.descriptor) }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus(data.error || 'Something went wrong while matching.', 'error');
        return;
      }

      gridLabel.textContent = `Your photos (${data.matches.length} found)`;
      renderPhotos(data.matches);
      clearMatchBtn.hidden = false;
      if (data.matches.length > 0) {
        setStatus('Found you! Here are the photos you appear in.', 'success');
      } else {
        setStatus("We didn't find you in any photos yet. Try another selfie, or check back once more photos are uploaded.", 'error');
      }
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  selfieInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processSelfieBlob(file);
  });

  let cameraStream = null;

  function closeCamera() {
    cameraModal.hidden = true;
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    cameraVideo.srcObject = null;
  }

  async function openCamera() {
    cameraError.hidden = true;
    cameraModal.hidden = false;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } },
        audio: false,
      });
      cameraVideo.srcObject = cameraStream;
      await cameraVideo.play().catch(() => {});
    } catch (err) {
      cameraError.textContent = `Couldn't access your camera (${err.message || err.name}). You can upload a photo instead.`;
      cameraError.hidden = false;
    }
  }

  openCameraBtn.addEventListener('click', () => {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      openCamera();
    } else {
      // No camera API support (very old browser) — fall straight back to the file picker.
      selfieInput.click();
    }
  });

  cameraCloseBtn.addEventListener('click', closeCamera);

  uploadInsteadBtn.addEventListener('click', () => {
    closeCamera();
    selfieInput.click();
  });

  captureBtn.addEventListener('click', () => {
    const vw = cameraVideo.videoWidth;
    const vh = cameraVideo.videoHeight;
    if (!vw || !vh) return;

    cameraCanvas.width = vw;
    cameraCanvas.height = vh;
    const ctx = cameraCanvas.getContext('2d');
    // Mirror the capture to match the mirrored preview the user was looking at.
    ctx.translate(vw, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(cameraVideo, 0, 0, vw, vh);

    cameraCanvas.toBlob(
      async (blob) => {
        closeCamera();
        if (blob) await processSelfieBlob(blob);
      },
      'image/jpeg',
      0.92
    );
  });

  clearMatchBtn.addEventListener('click', () => {
    selfiePreview.hidden = true;
    selfieAvatarIcon.hidden = false;
    clearMatchBtn.hidden = true;
    setStatus('Ready — take or upload a selfie to find your photos.', 'ready');
    loadAllPhotos();
  });

  selectModeBtn.addEventListener('click', () => setSelectMode(!selectMode));
  cancelSelectBtn.addEventListener('click', () => setSelectMode(false));

  selectAllBtn.addEventListener('click', () => {
    photoGrid.querySelectorAll('.photo-tile').forEach((div) => {
      const id = Number(div.dataset.photoId);
      if (!selectedIds.has(id)) {
        selectedIds.add(id);
        div.classList.add('selected');
      }
    });
    updateSelectionBar();
  });

  downloadSelectedBtn.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    downloadSelectedBtn.disabled = true;
    const originalText = downloadSelectedBtn.textContent;
    downloadSelectedBtn.textContent = 'Preparing download…';

    try {
      const res = await fetch(`/e/${SLUG}/download-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.message || "Couldn't prepare that download. Please try again.");
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `${SLUG}-photos.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      alert('Error preparing download: ' + err.message);
    } finally {
      downloadSelectedBtn.disabled = selectedIds.size === 0;
      downloadSelectedBtn.textContent = originalText;
    }
  });

  loadModels().catch((err) => {
    setStatus('Could not load face recognition models: ' + err.message, 'error');
  });
  loadAllPhotos();
})();
