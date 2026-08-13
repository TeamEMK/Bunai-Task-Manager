// ════════════════════════════════════════════════════════════════════════
//  vinculum.js — Vin eRetail (Vinculum) read layer for the IMS module.
//
//  Pulls inventory and sales data out of the client's Vin eRetail tenant so
//  the task manager can report on it and raise tasks from it. Read-only: no
//  endpoint here writes anything back, and no write API was enabled on the key.
//
//  SETUP (.env):
//    VIN_BASE_URL   https://<tenant>.vineretail.com/RestWS/api/eretail
//    VIN_API_KEY    from Vin eRetail: Admin → Api → Manage Api
//    VIN_API_OWNER  the owner name shown beside that key
//    VIN_ORG_ID     the account's organisation id  ← still unknown, see below
//  With any of these missing, isConfigured() is false and callers skip the
//  sync; the rest of the app is unaffected.
//
//  WHAT THE TRANSPORT LOOKS LIKE — all of this was established by probing the
//  live tenant, not from documentation, which Vinculum has not sent:
//
//    * The version segment is PER ENDPOINT. /order/list answers on v2 and v3,
//      everything else on v1. There is no single version that serves them all,
//      which is why each entry below carries its own.
//    * Content type is PER ENDPOINT too, and mostly wrong-looking:
//      almost everything demands application/x-www-form-urlencoded and then
//      parses a JSON string out of the body. inventoryRealTime is the lone
//      exception and wants a genuine application/json. Sending the "correct"
//      JSON type to the others returns 415, which is what made this so opaque.
//    * OrgId travels as an HTTP HEADER, not in the body. Omit it and every
//      endpoint answers "OrgId is mandatory"; send a wrong one and the answer
//      changes to "Invalid API credentials" — that shift is how the header
//      name was confirmed.
//
//  BLOCKED ON: the real VIN_ORG_ID. Until it is set every call returns
//  responseCode 11. It is not guessable and brute-forcing it against a live
//  tenant is credential enumeration, so it has to come from the Vin eRetail
//  admin screens or from Vinculum.
// ════════════════════════════════════════════════════════════════════════

const BASE_URL  = (process.env.VIN_BASE_URL  || '').replace(/\/+$/, '');
const API_KEY   = process.env.VIN_API_KEY    || '';
const API_OWNER = process.env.VIN_API_OWNER  || '';
const ORG_ID    = process.env.VIN_ORG_ID     || '';

const TIMEOUT_MS = Number(process.env.VIN_TIMEOUT_MS || 30000);
const RETRIES    = Number(process.env.VIN_RETRIES    || 2);

const FORM = 'application/x-www-form-urlencoded';
const JSON_CT = 'application/json';

// Every endpoint enabled on the key, with the version and content type each one
// actually answers on. Both columns were found by probing — do not "tidy" them
// into a single version or a single content type, they are genuinely per-route.
const ENDPOINTS = {
  // ── Inventory ──
  // Five overlapping reads. Which is the useful one depends on what each
  // returns once OrgId unblocks them, so all stay enabled for now.
  INVENTORY_STATUS:    { path: 'sku/inventoryStatus',        version: 'v1', type: FORM },
  INVENTORY_SKU:       { path: 'sku/getInventory',           version: 'v1', type: FORM },
  INVENTORY_REALTIME:  { path: 'sku/inventoryRealTime',      version: 'v1', type: JSON_CT },
  INVENTORY_AVAILABLE: { path: 'order/availableInventoryWH', version: 'v1', type: FORM },
  STOCK_DETAIL:        { path: 'stock/detail',               version: 'v1', type: FORM },

  // ── Orders ──
  ORDER_LIST:     { path: 'order/list',          version: 'v2', type: FORM },
  ORDER_LIST_V3:  { path: 'order/list',          version: 'v3', type: FORM },
  ORDER_STATUS:   { path: 'order/status',        version: 'v1', type: FORM },
  CUSTOMER_ORDER: { path: 'order/customerOrder', version: 'v1', type: FORM },

  // ── Product master ──
  // Without this, reports show SKU codes and no product names.
  SKU: { path: 'sku/getsku', version: 'v1', type: FORM },
};

// stock/getWhInventory is listed in the Manage Api panel but 404s on every
// version tried. The panel's URL column is evidently a label rather than the
// literal route for that one. Left out until the documentation explains it.

// Inventory needs only the key and owner — inventoryRealTime never checks the
// org. Orders and the SKU master do, hence the two levels.
function isConfigured() {
  return Boolean(BASE_URL && API_KEY && API_OWNER);
}
function hasOrgId() {
  return Boolean(ORG_ID);
}

// What is still missing, phrased for a human. Used by the health endpoint and
// the test script so a misconfiguration reads as a checklist, not a stack trace.
function missingConfig() {
  const gaps = [];
  if (!BASE_URL)  gaps.push('VIN_BASE_URL');
  if (!API_KEY)   gaps.push('VIN_API_KEY');
  if (!API_OWNER) gaps.push('VIN_API_OWNER');
  return gaps;
}

function urlFor(ep, base = BASE_URL) {
  const e = typeof ep === 'string' ? { path: ep, version: 'v1' } : ep;
  return `${base.replace(/\/+$/, '')}/${e.version}/${String(e.path).replace(/^\/+/, '')}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── One call to Vin eRetail ──────────────────────────────────────────────
// Returns { ok, status, code, message, json, text, url }. HTTP errors do not
// throw: Vin eRetail answers 200 with an error code in the body far more often
// than it uses status codes, so the caller has to read `code` either way, and
// during bring-up the error body is the most useful thing on the screen.
// Only genuine transport failures throw.
async function vinCall(ep, payload = {}, opts = {}) {
  const gaps = missingConfig();
  if (gaps.length) throw new Error(`Vinculum not configured — missing ${gaps.join(', ')} in .env`);
  // ORG_ID is deliberately not required here: sending an empty header is what
  // inventoryRealTime expects, and the endpoints that do need it say so
  // themselves with responseCode 20, which reads better than a config error.

  const endpoint = typeof ep === 'string' ? ENDPOINTS[ep] : ep;
  if (!endpoint) throw new Error(`Unknown Vinculum endpoint: ${ep}`);

  const url = urlFor(endpoint, opts.base || BASE_URL);
  // Both content types carry the same JSON string. The form-urlencoded ones are
  // not actually form-encoded — the server just insists on that header.
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let lastErr = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeout || TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': endpoint.type || FORM,
          'ApiKey': API_KEY,
          'ApiOwner': API_OWNER,
          'OrgId': String(ORG_ID),
        },
        body,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* HTML error page, or empty */ }

      if (res.status >= 500 && attempt < RETRIES) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      const code = json && json.responseCode;
      return {
        ok: res.ok && (code === undefined || code === 0),
        status: res.status,
        code,
        message: json && json.responseMessage,
        json, text, url,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) { await sleep(500 * (attempt + 1)); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Vinculum request failed (${url}): ${lastErr && lastErr.message}`);
}

// Response codes seen so far, so callers can explain a failure rather than
// printing a bare number. Not exhaustive — Vinculum's list is longer.
const CODES = {
  9:     'Generic error — usually a malformed filter',
  13:    'API hit quota exceeded — too many calls too quickly, back off and retry',
  11:    'Invalid API credentials — the OrgId does not match this API key',
  16:    'API key needs Read-Write access — tick Access Rights for this API in Manage Api',
  20:    'OrgId is mandatory — the OrgId header was not sent',
  616:   'SKU is mandatory',
  807:   'No filters found for fetching orders',
  9189:  'No data found for the given filters',
  10220: 'Too many SKUs in one request — the live-inventory endpoint caps at 20',
  10221: 'Stores are mandatory',
};
const explain = code => CODES[code] || null;

// ── Live inventory — the one path that works today ───────────────────────
// inventoryRealTime never validates OrgId, so it runs on ApiKey + ApiOwner
// alone. Confirmed against the tenant; the shape below is the real response:
//
//   { responseCode: 0, responseMessage: "Success",
//     inventory: [ { sku: "VSKD2470-M",
//                    stores: [ { storeId: "BUN", availableQty: 50.000 },
//                              { storeId: "GUJ", availableQty: 40.000 } ] } ] }
//
// Only SKUs with stock come back. A SKU with none is simply absent from the
// array — it is not returned as a zero — so callers that need "everything we
// asked about" have to fill the gaps themselves. syncInventory() does.
//
// Two quirks worth knowing: the endpoint rejects any field beyond sku/stores
// with a bare "Generic Error", and asking only about out-of-stock SKUs
// returns 9189 "No Data Found" rather than an empty success.

const WAREHOUSES = (process.env.VIN_WAREHOUSES || 'BUN,GUJ').split(',').map(s => s.trim()).filter(Boolean);

// SKUs per request. 20 is the API's own ceiling — asking for more returns
// code 10220 "Maximum Limit Exceeded(20 SKUs Max)" and no data at all, so this
// is a hard limit rather than a tuning choice. ~950 SKUs means ~48 calls.
const BATCH = Math.min(20, Number(process.env.VIN_SKU_BATCH || 20));

// Flattens the nested response into one row per (sku, warehouse).
function flattenInventory(json) {
  const rows = [];
  for (const item of (json && json.inventory) || []) {
    for (const st of item.stores || []) {
      rows.push({ sku: item.sku, warehouse: st.storeId, qty: Number(st.availableQty) || 0 });
    }
  }
  return rows;
}

// One batch. Returns [] for "no stock in this batch" rather than throwing —
// that is a normal answer, not a failure.
async function fetchInventoryBatch(skus, stores = WAREHOUSES) {
  if (!skus.length) return [];
  const r = await vinCall('INVENTORY_REALTIME', { sku: skus, stores });
  if (r.code === 9189) return [];
  if (r.code !== 0) {
    throw new Error(`Vinculum inventory failed (code ${r.code}): ${r.message || r.text}`);
  }
  return flattenInventory(r.json);
}

// Pace between batches, and how long to stand down when the quota trips.
// ~950 SKUs is ~48 calls; without a gap the tenant starts answering code 13
// part-way through, which is worse than taking a minute longer.
const CALL_GAP_MS  = Number(process.env.VIN_CALL_GAP_MS  || 1200);
const QUOTA_WAIT_MS = Number(process.env.VIN_QUOTA_WAIT_MS || 60000);
const QUOTA_RETRIES = Number(process.env.VIN_QUOTA_RETRIES || 5);

// Every SKU, in batches. onBatch fires as each batch lands so the caller can
// persist immediately — a quota stall half way through then costs nothing.
// onProgress is for reporting only.
async function fetchInventoryAll(skus, { stores = WAREHOUSES, onProgress, onBatch } = {}) {
  const all = [];
  let done = 0;

  for (let i = 0; i < skus.length; i += BATCH) {
    const batch = skus.slice(i, i + BATCH);
    let rows = null;

    // Code 13 is a rate limit, not a failure: wait it out rather than losing
    // the run. Anything else is a real error and propagates.
    for (let attempt = 0; attempt <= QUOTA_RETRIES; attempt++) {
      try {
        rows = await fetchInventoryBatch(batch, stores);
        break;
      } catch (e) {
        if (!/code 13/.test(e.message) || attempt === QUOTA_RETRIES) throw e;
        if (onProgress) onProgress(done, skus.length, all.length, `quota hit — waiting ${QUOTA_WAIT_MS / 1000}s`);
        await sleep(QUOTA_WAIT_MS);
      }
    }

    all.push(...rows);
    done = Math.min(i + BATCH, skus.length);
    if (onBatch) await onBatch(rows);
    if (onProgress) onProgress(done, skus.length, all.length);
    if (done < skus.length) await sleep(CALL_GAP_MS);
  }
  return all;
}

// ── Endpoints still blocked on OrgId ─────────────────────────────────────
// Raw responses on purpose: none has returned a success payload yet, so the
// field names are unknown and any normaliser now would be invented.
const fetchStockDetail = (p = {}) => vinCall('STOCK_DETAIL', p);
const fetchOrders      = (p = {}) => vinCall('ORDER_LIST', p);
const fetchOrderStatus = (p = {}) => vinCall('ORDER_STATUS', p);
const fetchSkuMaster   = (p = {}) => vinCall('SKU', p);

module.exports = {
  ENDPOINTS,
  CODES,
  WAREHOUSES,
  explain,
  isConfigured,
  hasOrgId,
  missingConfig,
  urlFor,
  vinCall,
  flattenInventory,
  fetchInventoryBatch,
  fetchInventoryAll,
  fetchStockDetail,
  fetchOrders,
  fetchOrderStatus,
  fetchSkuMaster,
  config: { BASE_URL, API_OWNER, ORG_ID, hasKey: Boolean(API_KEY) },
};
