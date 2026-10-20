// Tracks in-progress Drive/Dropbox sync jobs so an import can run in the
// background (not held open inside one HTTP request, which is what caused
// proxy timeouts on anything but a small folder) while the client polls for
// progress. In-memory and per-process: a restart drops any running job's
// status, but not the photos it already saved — the organizer just sees the
// job as gone and can start a new sync, which skips everything already
// imported via the dropbox_file_id/drive_file_id dedup check.

const jobs = new Map(); // `${source}:${eventId}` -> job

function key(source, eventId) {
  return `${source}:${eventId}`;
}

function start(source, eventId, total) {
  const job = { status: 'running', total, imported: 0, skipped: 0, error: null, billing: null, startedAt: Date.now() };
  jobs.set(key(source, eventId), job);
  return job;
}

function get(source, eventId) {
  return jobs.get(key(source, eventId)) || null;
}

function isRunning(source, eventId) {
  const job = get(source, eventId);
  return Boolean(job && job.status === 'running');
}

module.exports = { start, get, isRunning };
