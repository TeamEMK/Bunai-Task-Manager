// ══════════════════════════════════════════════════════
// CONFIG — every environment variable is read HERE and nowhere else.
// Anything downstream imports this object, so "what can be configured?"
// has exactly one answer instead of ninety grep hits.
// ══════════════════════════════════════════════════════
const path = require('path');

// Repo layout:  <root>/backend/src/config/index.js
//               <root>/frontend/…            served HTML/CSS/JS
//               <root>/.env                  secrets, shared by both
const ROOT = path.join(__dirname, '..', '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');

// Explicit path, not the working directory: the app must behave the same
// whether it is started as `npm start` from the repo root or `node server.js`
// from inside backend/.
require('dotenv').config({ path: path.join(ROOT, '.env') });

const int = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };
// "0" and "false" turn a flag off; anything else (including unset) keeps the default.
const flag = (v, dflt) => (v == null || v === '') ? dflt : !['0', 'false', 'no'].includes(String(v).toLowerCase());

// A serverless invocation lives only as long as one request, so timers and
// in-process queues behave differently there. Decided once, read everywhere.
const isServerless = !!(process.env.VERCEL || process.env.NOW_REGION);

module.exports = {
  root: ROOT,
  // Everything the browser downloads lives in frontend/; the server only reads it.
  publicDir: FRONTEND,
  imsAppDir: path.join(FRONTEND, 'ims-app'),

  isServerless,
  isProduction: process.env.NODE_ENV === 'production',
  port: int(process.env.PORT, 3000),

  auth: {
    jwtSecret: process.env.SESSION_SECRET || 'taskmanager_secret_2026',
    jwtExpiry: process.env.JWT_EXPIRY || '7d',
    cookieMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    // bcrypt work factor. bcryptjs is pure JS, so every +1 doubles login CPU;
    // 10 is the historical value every stored hash was made with. Raising it
    // is safe — existing users are re-hashed transparently on next login.
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
  },

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'bunai_task_manager',
    // ⚠️ Shared hosting usually caps max_user_connections at 5-10, and a
    // serverless platform connects from several instances at once.
    poolSize: int(process.env.DB_POOL_SIZE, 2),
    ssl: process.env.DB_SSL === 'true',
    socket: process.env.DB_SOCKET || '',
  },

  google: {
    // Either GOOGLE_CREDENTIALS (a one-line JSON blob) or a local credentials.json.
    credentialsJson: process.env.GOOGLE_CREDENTIALS || '',
    poDriveFolderId: process.env.PO_DRIVE_FOLDER_ID || '',
    // Sheet values are re-read by several MIS endpoints within seconds of each
    // other; this is how long one fetch is reused for. 0 disables the cache.
    valuesCacheMs: int(process.env.SHEETS_CACHE_MS, 60 * 1000),
  },

  sheets: {
    merchFms: {
      id: process.env.MERCH_FMS_SHEET_ID || '',
      gid: num(process.env.MERCH_FMS_GID, 0),
      startRow: num(process.env.MERCH_FMS_START_ROW, 2),
    },
    merch22Godam: {
      id: process.env.MERCH_FMS_22GODAM_SHEET_ID || '',
      gid: num(process.env.MERCH_FMS_22GODAM_GID, 0),
      startRow: num(process.env.MERCH_FMS_22GODAM_START_ROW, 2),
    },
    processFms: {
      id: process.env.PROCESS_FMS_SHEET_ID || '',
      gid: num(process.env.PROCESS_FMS_GID, 0),
      startRow: num(process.env.PROCESS_FMS_START_ROW, 2),
    },
    // The PO tab lives in the same spreadsheet as Merch FMS Unit 1.
    po: {
      get id() { return process.env.MERCH_FMS_SHEET_ID || ''; },
      tab: 'PO',
      startRow: 2,
    },
  },

  whatsapp: {
    // Waumfy is the current provider; the older AUMFIG_* names still work as a
    // fallback so an un-migrated deployment keeps sending.
    apiKey: process.env.WAUMFY_API_KEY || process.env.AUMFIG_API_KEY || '',
    apiUrl: process.env.WAUMFY_API_URL || process.env.AUMFIG_API_URL
      || 'https://www.waumfy.com/api/v1/send-message',
    // Random 4-5 min gap between sends — a fixed interval looks bot-like.
    gapMinMs: int(process.env.WHATSAPP_GAP_MIN_MS, 4 * 60 * 1000),
    gapMaxMs: int(process.env.WHATSAPP_GAP_MAX_MS, 5 * 60 * 1000),
    gapFixedMs: (process.env.WHATSAPP_GAP_MS != null && process.env.WHATSAPP_GAP_MS !== '')
      ? int(process.env.WHATSAPP_GAP_MS, 0) : null,
    delegationDelayMs: int(process.env.WHATSAPP_DELAY_MS, 60 * 1000),
  },

  // Gmail SMTP. Port 465 is implicit TLS, 587 is STARTTLS — nodemailer picks
  // from the port alone. A blank SMTP_PASS turns every email off silently.
  email: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: int(process.env.SMTP_PORT, 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    // Where the "View task" button in a notification email points. Blank and the
    // button is left out rather than shipping a dead link.
    appUrl: (process.env.APP_URL || '').trim().replace(/\/+$/, ''),
    // Gmail overwrites the From address with the authenticated account, so only
    // the display name here actually survives.
    from: process.env.SMTP_FROM
      || (process.env.SMTP_USER ? `Bunai Task Manager <${process.env.SMTP_USER}>` : ''),
  },

  // Overdue delegation-task chasing: 12 hours after the due day ends, then
  // every 8 hours. The cadence itself lives in taskReminder.js; this is only
  // the on/off switch.
  taskReminder: {
    enabled: flag(process.env.TASK_REMINDER_ENABLED, true),
  },

  reminder: {
    enabled: flag(process.env.CHECKLIST_REMINDER_ENABLED, true),
    hour: int(process.env.CHECKLIST_REMINDER_HOUR, 10),
    minute: int(process.env.CHECKLIST_REMINDER_MINUTE, 0),
  },

  vinculum: {
    syncEnabled: flag(process.env.VIN_SYNC_ENABLED, true),
    syncHour: num(process.env.VIN_SYNC_HOUR, 6),
    syncMinute: num(process.env.VIN_SYNC_MINUTE, 0),
    lowStockAssignTo: num(process.env.VIN_LOW_STOCK_ASSIGN_TO, 0),
  },

  cronSecret: process.env.CRON_SECRET || '',
};
