// Minimal Dropbox API v2 client for importing photos from a publicly shared
// folder link. Dropbox (unlike Google Drive) has no "read with just an API
// key" mode — every call needs a bearer access token for *some* Dropbox
// account (it does not need to be the folder owner's account; any token
// can browse/download a link shared as "Anyone with the link can view").
// Requires DROPBOX_ACCESS_TOKEN, generated from a Dropbox App Console app.

const LIST_FOLDER_URL = 'https://api.dropboxapi.com/2/files/list_folder';
const LIST_FOLDER_CONTINUE_URL = 'https://api.dropboxapi.com/2/files/list_folder/continue';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/sharing/get_shared_link_file';

const MAX_FILES = 300; // safety cap per sync
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

function isDropboxShareUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)dropbox\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function dropboxFetch(url, accessToken, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Dropbox API error (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function listImageFiles(sharedUrl, accessToken) {
  const files = [];

  let data = await dropboxFetch(LIST_FOLDER_URL, accessToken, {
    path: '',
    shared_link: { url: sharedUrl },
  });

  for (;;) {
    for (const entry of data.entries || []) {
      if (entry['.tag'] === 'file' && IMAGE_EXT_RE.test(entry.name)) {
        files.push({ id: entry.id, name: entry.name, path: entry.path_lower, size: entry.size });
      }
    }
    if (!data.has_more || files.length >= MAX_FILES) break;
    data = await dropboxFetch(LIST_FOLDER_CONTINUE_URL, accessToken, { cursor: data.cursor });
  }

  return files.slice(0, MAX_FILES);
}

async function downloadFile(sharedUrl, filePath, accessToken) {
  const res = await fetch(DOWNLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ url: sharedUrl, path: filePath }),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not download Dropbox file ${filePath} (${res.status}): ${text.slice(0, 300)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { isDropboxShareUrl, listImageFiles, downloadFile, MAX_FILES };
