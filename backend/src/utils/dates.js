// ══════════════════════════════════════════════════════
// DATE HELPERS
// The server may run in UTC (Hostinger, Vercel) while the business runs in IST,
// so anything that means "today" for a person is computed explicitly in IST.
// ══════════════════════════════════════════════════════

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const isYmd = v => YMD_RE.test(v || '');

// Accepts only 'YYYY-MM-DD', else null — so an empty string never becomes
// 0000-00-00 in the database.
function normDate(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 10);
  return YMD_RE.test(s) ? s : null;
}

// Must stay in step with CHECKLIST_FREQS in frontend/assets/app.js — that list
// drives the dropdown, this one is the gate that decides what is allowed to be
// stored. Every value has to fit the frequency column's VARCHAR(20).
const VALID_FREQS = [
  'daily', 'alternate_days', 'weekly', 'every_tuesday', 'every_thursday',
  'every_10_days', 'alternative_week', 'monthly', 'quarterly', 'yearly',
];
function normFreq(v) {
  const s = String(v || '').trim().toLowerCase();
  return VALID_FREQS.includes(s) ? s : null;
}

function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// ── IST ───────────────────────────────────────────────
function istParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10) };
}
const istToday = () => istParts().date;

// Monday of the week containing `date`, in IST.
function istMondayOf(date) {
  const ist = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
  const dayUTC = ist.getUTCDay();                 // 0=Sun, 1=Mon..6=Sat
  const diff = (dayUTC === 0 ? -6 : 1 - dayUTC);  // shift back to Monday
  const mon = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + diff));
  return mon.toISOString().split('T')[0];
}

function addDays(yyyyMmDd, n) {
  const d = new Date(yyyyMmDd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// The server clock's own date. Kept distinct from istToday() on purpose: the
// callers below are the ones that historically used new Date().toISOString(),
// and quietly switching them to IST would move task due dates by a day.
const serverToday = () => new Date().toISOString().split('T')[0];

// Saturday is a working day here EXCEPT the last one of the month, which
// matches the rule the rest of the app uses for off-days.
function isLastSaturdayOfMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (d.getUTCDay() !== 6) return false;
  const next = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
  return next.getUTCMonth() !== d.getUTCMonth();
}

// "15-Jul-2026" — how dates are written to people (WhatsApp, sheets).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatHumanDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

// DD/MM/YYYY HH:mm:ss in IST — the timestamp convention used across the sheets.
const istTimestamp = () =>
  new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');

module.exports = {
  YMD_RE, isYmd, normDate, normFreq, VALID_FREQS, toDateStr,
  istParts, istToday, istMondayOf, addDays, serverToday,
  isLastSaturdayOfMonth, formatHumanDate, istTimestamp,
};
