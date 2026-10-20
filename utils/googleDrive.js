// Minimal Google Drive v3 client for importing photos from a publicly shared
// folder ("Anyone with the link can view"). Uses a plain API key — no OAuth —
// which Drive's API supports for read access to publicly shared files.
// Requires GOOGLE_API_KEY with the Drive API enabled on the associated
// Google Cloud project.

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
// Safety cap per sync — the import itself runs as a background job (see
// utils/syncJobs.js), not inside the HTTP request, so this just bounds a
// single run's worst case rather than protecting against a proxy timeout.
const MAX_FILES = 3000;

const FOLDER_URL_PATTERNS = [
  /\/folders\/([a-zA-Z0-9_-]+)/, // drive.google.com/drive/folders/<id>
  /[?&]id=([a-zA-Z0-9_-]+)/, // drive.google.com/open?id=<id>
];

function parseFolderId(url) {
  for (const pattern of FOLDER_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function listImageFiles(folderId, apiKey) {
  const files = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: '100',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_API}/files?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Google Drive API error (${res.status}): ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && files.length < MAX_FILES);

  return files.slice(0, MAX_FILES);
}

async function downloadFile(fileId, apiKey) {
  const params = new URLSearchParams({ alt: 'media', key: apiKey });
  const res = await fetch(`${DRIVE_API}/files/${fileId}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Could not download Drive file ${fileId} (${res.status}): ${body.slice(0, 300)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { parseFolderId, listImageFiles, downloadFile, MAX_FILES };
