// ════════════════════════════════════════════════════════════════════════
//  unicommerce.js — Uniware (Unicommerce) read layer.
//
//  The client is moving off Vin eRetail onto Unicommerce. This is the
//  replacement for vinculum.js: same job, far less guesswork, because
//  Unicommerce actually publishes its API documentation.
//
//  SETUP (.env):
//    UNI_TENANT     just the subdomain, e.g. "bunai"  → https://bunai.unicommerce.com
//    UNI_BASE_URL   (optional) full origin, if the tenant URL is not the usual shape
//    UNI_USERNAME   a dedicated Admin API user, not somebody's personal login
//    UNI_PASSWORD   that user's password
//    UNI_FACILITY   facility code, sent as the `Facility` header on facility-level calls
//    UNI_CLIENT_ID  (optional) defaults to "my-trusted-client", which is what the docs use
//  With any of the first four missing, isConfigured() is false and callers skip
//  the sync, exactly as the Vinculum layer behaves.
//
//  WHAT IS DIFFERENT FROM VIN eRETAIL — all of this is from the published docs
//  (https://documentation.unicommerce.com), not from probing:
//
//    * Auth is ordinary OAuth2 password grant. GET /oauth/token once, then send
//      `Authorization: bearer <token>` on everything. No per-endpoint creds, no
//      OrgId, no creds-in-header-vs-body split — the three things that cost
//      weeks on Vinculum.
//    * One version (v1) and one content type (application/json) for every
//      endpoint. Vinculum needed a version AND a content type per route.
//    * Errors come back in a consistent envelope: { successful, message,
//      errors[], warnings[] }. Vinculum answered HTTP 200 with a numeric
//      responseCode buried in the body and a different shape per endpoint.
//    * Facility-level endpoints need a `Facility` header with the facility
//      code. Tenant-level ones do not. The docs mark which is which; the table
//      below records it so callers do not have to remember.
//
//  UNTESTED UNTIL CREDENTIALS ARRIVE. Every path and field name here is copied
//  from the documentation, but nothing has been run against a live tenant yet.
//  Deliberately there are no database tables and no response normalisers: the
//  same discipline that was applied to Vinculum — do not invent a schema before
//  seeing a real payload. Run scripts/test-unicommerce.js first; it prints what
//  each endpoint actually returns, and the sync layer gets written from that.
// ════════════════════════════════════════════════════════════════════════

// UNI_TENANT is meant to be the bare subdomain, but what lands in .env is
// routinely a whole URL pasted out of the docs — origin, /oauth/token path,
// query string and all. Naively interpolating that produces
// "https://https://bunai.unicommerce.com/....unicommerce.com" and a DNS error
// that says nothing useful. So accept any of the shapes someone might paste
// and reduce them to an origin.
function originFrom(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    try { return new URL(v).origin; } catch (_) { return ''; }
  }
  // "bunai.unicommerce.com" — a host, just missing the scheme.
  if (v.includes('.')) return 'https://' + v.replace(/\/.*$/, '');
  // "bunai" — the bare subdomain this variable actually asks for.
  return `https://${v}.unicommerce.com`;
}

const TENANT    = (process.env.UNI_TENANT   || '').trim();
const BASE_URL  = (process.env.UNI_BASE_URL ? originFrom(process.env.UNI_BASE_URL) : originFrom(TENANT));
const USERNAME  = process.env.UNI_USERNAME  || '';
const PASSWORD  = process.env.UNI_PASSWORD  || '';
const FACILITY  = process.env.UNI_FACILITY  || '';
const CLIENT_ID = process.env.UNI_CLIENT_ID || 'my-trusted-client';

const TIMEOUT_MS = Number(process.env.UNI_TIMEOUT_MS || 30000);
const RETRIES    = Number(process.env.UNI_RETRIES    || 2);

// `facility: true` means the endpoint needs the Facility header. Getting this
// wrong is a silent class of bug — a facility-level call without the header
// does not fail loudly, it answers for the wrong scope or not at all.
const ENDPOINTS = {
  // ── Inventory ──
  // Note the scale difference worth knowing before designing the sync:
  // inventorySnapshot takes up to 10,000 SKUs per call. Vin eRetail capped at
  // 20, which is why the stock sync needed ~48 calls and a 1.2s pacing gap.
  INVENTORY_SNAPSHOT: { path: 'inventory/inventorySnapshot/get', facility: true },

  // ── Sales orders ──
  ORDER_SEARCH: { path: 'oms/saleOrder/search', facility: false },
  ORDER_GET:    { path: 'oms/saleorder/get',    facility: false },

  // ── Returns ──
  RETURN_GET:    { path: 'oms/return/get',    facility: true },
  RETURN_SEARCH: { path: 'oms/return/search', facility: true },

  // ── Facilities ──
  // Tenant-level on purpose: this is how you discover the facility codes that
  // every facility-level endpoint then needs, so it cannot itself require one.
  FACILITY_SEARCH: { path: 'facility/search', facility: false },
  FACILITY_GET:    { path: 'facility/get',    facility: false },

  // ── Product master ──
  // Vin eRetail never opened this up, which is why the SKU list had to be
  // seeded from a CSV export and went stale whenever a SKU was added.
  ITEM_SEARCH: { path: 'product/itemType/search', facility: false },
  ITEM_GET:    { path: 'product/itemType/get',    facility: false },
};

function isConfigured() {
  return Boolean(BASE_URL && USERNAME && PASSWORD);
}

function missingConfig() {
  const gaps = [];
  if (!BASE_URL) gaps.push('UNI_TENANT (or UNI_BASE_URL)');
  if (!USERNAME) gaps.push('UNI_USERNAME');
  if (!PASSWORD) gaps.push('UNI_PASSWORD');
  return gaps;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Token ────────────────────────────────────────────────────────────────
// Cached in memory and reused until shortly before it expires. The docs give
// expires_in in seconds and also hand back a refresh_token, but re-running the
// password grant is a single cheap GET, so there is no reason to carry the
// extra refresh path and its own failure mode.
let _token = null;        // { value, expiresAt }
const EXPIRY_MARGIN_MS = 60 * 1000;

async function getToken({ force = false } = {}) {
  const gaps = missingConfig();
  if (gaps.length) throw new Error(`Unicommerce not configured — missing ${gaps.join(', ')} in .env`);

  if (!force && _token && Date.now() < _token.expiresAt) return _token.value;

  const url = `${BASE_URL}/oauth/token?grant_type=password` +
              `&client_id=${encodeURIComponent(CLIENT_ID)}` +
              `&username=${encodeURIComponent(USERNAME)}` +
              `&password=${encodeURIComponent(PASSWORD)}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(url, { method: 'GET', signal: ac.signal });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML error page */ }

  if (!res.ok || !json || !json.access_token) {
    // The password is in the query string, so never echo the URL back.
    throw new Error(
      `Unicommerce auth failed (HTTP ${res.status}). ` +
      `Check UNI_USERNAME/UNI_PASSWORD and that the user has Admin rights. ` +
      `Response: ${String(text).slice(0, 200)}`);
  }

  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  _token = { value: json.access_token, expiresAt: Date.now() + ttlMs - EXPIRY_MARGIN_MS };
  return _token.value;
}

function forgetToken() { _token = null; }

// ── One call ─────────────────────────────────────────────────────────────
// Returns { ok, status, successful, message, errors, json, text }.
// Like the Vinculum layer, HTTP errors do not throw: the useful detail lives in
// the body's `errors` array, and during bring-up that is the thing worth seeing.
// A 401 is the one case handled automatically — the token is refetched once and
// the call retried, because a token expiring mid-sync is routine, not a fault.
async function uniCall(ep, body = {}, opts = {}) {
  const endpoint = typeof ep === 'string' ? ENDPOINTS[ep] : ep;
  if (!endpoint) throw new Error(`Unknown Unicommerce endpoint: ${ep}`);

  const facility = opts.facility || FACILITY;
  if (endpoint.facility && !facility) {
    throw new Error(
      `${endpoint.path} is a facility-level endpoint and needs a facility code — ` +
      `set UNI_FACILITY in .env or pass { facility }`);
  }

  const url = `${BASE_URL}/services/rest/v1/${String(endpoint.path).replace(/^\/+/, '')}`;
  let lastErr = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const token = await getToken({ force: attempt > 0 && lastErr === 401 });
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `bearer ${token}`,
    };
    if (endpoint.facility) headers.Facility = facility;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeout || TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ac.signal, headers, body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* HTML error page, or empty */ }

      if (res.status === 401 && attempt < RETRIES) {
        forgetToken();
        lastErr = 401;
        continue;
      }
      if (res.status >= 500 && attempt < RETRIES) {
        lastErr = res.status;
        await sleep(500 * (attempt + 1));
        continue;
      }

      return {
        ok: res.ok && json ? json.successful !== false : false,
        status: res.status,
        successful: json ? json.successful : undefined,
        message: json ? json.message : undefined,
        errors: (json && json.errors) || [],
        warnings: (json && json.warnings) || [],
        json, text, url,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) { await sleep(500 * (attempt + 1)); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Unicommerce request failed (${url}): ${lastErr && (lastErr.message || lastErr)}`);
}

// The catalogue spells the brand both ways — 1,235 SKUs say "Bunaai" against
// 2,866 that say "Bunai", sometimes for near-identical products, and the
// website and Myntra both use the single-a form. Correcting it in Uniware is
// the real fix and still needs doing; until then this keeps the app from
// repeating the typo on every page.
//
// It has to happen on the way IN, not with an UPDATE: syncItems writes
// name = VALUES(name) every morning, so anything fixed in the table is undone
// by the next run.
//
// Case is preserved rather than flattened — product names arrive in Title Case
// and in SHOUTING, and rewriting one into the other would look like a second
// bug.
function fixBrand(s) {
  if (!s) return s;
  return String(s).replace(/bunaai/gi, m =>
    m === m.toUpperCase() ? 'BUNAI' : m[0] === m[0].toUpperCase() ? 'Bunai' : 'bunai');
}

// Errors arrive as objects, which read badly in a log line.
function explain(result) {
  if (!result) return null;
  if (result.errors && result.errors.length) {
    return result.errors.map(e => [e.code, e.fieldName, e.message || e.description]
      .filter(Boolean).join(' ')).join('; ');
  }
  return result.message || null;
}

module.exports = {
  ENDPOINTS,
  isConfigured,
  missingConfig,
  getToken,
  forgetToken,
  uniCall,
  explain,
  fixBrand,
  config: { BASE_URL, USERNAME, FACILITY, CLIENT_ID, hasPassword: Boolean(PASSWORD) },
};
