// ══════════════════════════════════════════════════════
// GOOGLE SHEETS / DRIVE
// Auth clients are built once and reused. Sheet READS go through a short-lived
// cache because /api/mis/all, /api/mis/fms and /api/fms-dashboard each pull the
// same full sheets, often within seconds of each other — one 8000-row fetch was
// being paid for three times per dashboard refresh.
// ══════════════════════════════════════════════════════
const { Readable } = require('stream');
const path = require('path');
const config = require('../config');

let _sheetsReadClient = null;
let _sheetsWriteClient = null;
let _driveClient = null;

function loadCredentials() {
  if (config.google.credentialsJson) return JSON.parse(config.google.credentialsJson);
  // Local-dev fallback — credentials.json at the repo root (gitignored).
  try { return require(path.join(config.root, 'credentials.json')); }
  catch (e) {
    throw new Error('Google credentials missing — set GOOGLE_CREDENTIALS env var (or place credentials.json locally for dev)');
  }
}

async function getSheetsClient(scopes) {
  const { google } = require('googleapis');
  const isWrite = scopes.some(s => !s.includes('readonly'));
  if (isWrite) {
    if (_sheetsWriteClient) return _sheetsWriteClient;
    const auth = new google.auth.GoogleAuth({ credentials: loadCredentials(), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    _sheetsWriteClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return _sheetsWriteClient;
  }
  if (_sheetsReadClient) return _sheetsReadClient;
  const auth = new google.auth.GoogleAuth({ credentials: loadCredentials(), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  _sheetsReadClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _sheetsReadClient;
}

const READ_SCOPE = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const WRITE_SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];
const getReadClient = () => getSheetsClient(READ_SCOPE);
const getWriteClient = () => getSheetsClient(WRITE_SCOPE);

// ── Read cache ────────────────────────────────────────
// key = spreadsheetId + range. Entries hold the resolved rows plus the promise
// while it is still in flight, so two concurrent readers share one HTTP call
// instead of racing (the "thundering herd" that made MIS pages so slow).
const _valuesCache = new Map();

function cacheGet(key) {
  const hit = _valuesCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { _valuesCache.delete(key); return null; }
  return hit.promise;
}

// Fetches a range and returns its rows (`values`, never undefined).
// Pass { fresh: true } for anything that must see a write that just happened.
async function readValues(spreadsheetId, range, { fresh = false } = {}) {
  const ttl = config.google.valuesCacheMs;
  const key = `${spreadsheetId}!${range}`;
  if (!fresh && ttl > 0) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  const promise = (async () => {
    const api = await getReadClient();
    const resp = await api.spreadsheets.values.get({ spreadsheetId, range });
    return resp.data.values || [];
  })();
  if (ttl > 0) _valuesCache.set(key, { promise, expires: Date.now() + ttl });
  try { return await promise; }
  catch (e) { _valuesCache.delete(key); throw e; }   // never cache a failure
}

// Drops cached reads for a spreadsheet — called after we write to it, so the
// next read does not serve the value we just replaced.
function invalidateSheet(spreadsheetId) {
  for (const key of _valuesCache.keys()) {
    if (key.startsWith(`${spreadsheetId}!`)) _valuesCache.delete(key);
  }
}

// ── Tab resolution ────────────────────────────────────
// The Values API needs a tab NAME; links and config carry a gid. Tab lists
// change rarely, so they are cached for the process lifetime of the id.
const _tabsCache = new Map();

async function listTabs(spreadsheetId) {
  if (_tabsCache.has(spreadsheetId)) return _tabsCache.get(spreadsheetId);
  const api = await getReadClient();
  const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const tabs = (meta.data.sheets || []).map(s => s.properties);
  _tabsCache.set(spreadsheetId, tabs);
  return tabs;
}

async function resolveTabNameByGid(spreadsheetId, gid) {
  const match = (await listTabs(spreadsheetId)).find(p => p.sheetId === gid);
  if (!match) throw new Error('Sheet tab (gid=' + gid + ') not found');
  return match.title;
}

async function findTabByTitle(spreadsheetId, title) {
  return (await listTabs(spreadsheetId)).find(p => p.title === title) || null;
}

function forgetTabs(spreadsheetId) { _tabsCache.delete(spreadsheetId); }

// ── Drive (PO documents) ──────────────────────────────
async function getDriveClient() {
  if (_driveClient) return _driveClient;
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: loadCredentials(), scopes: ['https://www.googleapis.com/auth/drive'] });
  _driveClient = google.drive({ version: 'v3', auth: await auth.getClient() });
  return _driveClient;
}

// Uploads a buffer, makes it link-viewable, returns a shareable link.
// PO_DRIVE_FOLDER_ID (optional) — if set, the file goes into that folder (which
// must be shared with the service-account email as Editor); otherwise it lands
// in the service account's own Drive, which has no storage quota of its own.
async function uploadPODocToDrive(buffer, originalName, mimeType) {
  const drive = await getDriveClient();
  const fileMeta = { name: `PO_${Date.now()}_${originalName}` };
  if (config.google.poDriveFolderId) fileMeta.parents = [config.google.poDriveFolderId];
  // supportsAllDrives is required whenever the parent is (or lives inside) a
  // Shared Drive — without it the API only looks at "My Drive" and 404s.
  const created = await drive.files.create({
    requestBody: fileMeta,
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true,
  });
  const fileId = created.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });
  const meta = await drive.files.get({ fileId, fields: 'id, webViewLink, webContentLink', supportsAllDrives: true });
  return meta.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}

// Pre-warm auth on startup so the first sheet-backed request does not pay for
// the token exchange.
function prewarm() {
  getReadClient()
    .then(() => console.log('  ✅ Google Auth pre-warmed'))
    .catch(e => console.log('  ⚠️ Google Auth pre-warm failed:', e.message));
}

module.exports = {
  getSheetsClient, getReadClient, getWriteClient, READ_SCOPE, WRITE_SCOPE,
  readValues, invalidateSheet,
  listTabs, resolveTabNameByGid, findTabByTitle, forgetTabs,
  getDriveClient, uploadPODocToDrive,
  prewarm,
};
