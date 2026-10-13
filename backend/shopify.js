// ══════════════════════════════════════════════════════
// SHOPIFY — Admin API client (GraphQL, read-only).
//
// The store itself, at last. Orders have reached this database through Vin
// eRetail and then Unicommerce, and both of those are systems the orders pass
// THROUGH; Shopify is where they are born. Reading it directly also ends the
// masking: Unicommerce returns '********' for every customer name, phone and
// email on a Shopify order, and Shopify returns the real ones.
//
// REST is not an option. Shopify made it a legacy API on 1 Oct 2024 and
// requires GraphQL for apps created after 1 Apr 2025, which this one is.
//
// Auth is a client-credentials exchange, not a stored token. Apps made in the
// Dev Dashboard cannot hand out a permanent token any more — the exchange
// returns one that lasts 24 hours, so it is cached here and re-fetched before
// it expires rather than read from the environment.
//
// Env: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
// ══════════════════════════════════════════════════════
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';
const SHOP = () => (process.env.SHOPIFY_STORE || '').trim();

// Shopify timestamps are UTC and end in Z. Every date in this database is IST,
// including the eight years of history loaded from the store's own CSV export,
// which Shopify writes in the shop's timezone. Storing the API value raw would
// put the two 5:30 apart and move one order in ten onto the previous day —
// checked against five orders that exist in both, where Bunai482943 reads
// 19 Sep in UTC and 20 Sep in IST.
//
// 'sv-SE' is not a preference, it is the one locale that formats as
// "YYYY-MM-DD HH:mm:ss", which is what MySQL wants.
function toIst(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace('T', ' ').slice(0, 19);
}

// Same instant, as a Shopify query string. Used for the sync window, which is
// expressed in IST days but has to be asked for in UTC.
function istDayToUtcIso(daysAgo) {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60000);
  ist.setUTCDate(ist.getUTCDate() - daysAgo);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60000).toISOString();
}

let cached = null;   // { token, expires }

async function token() {
  if (cached && Date.now() < cached.expires) return cached.token;

  const shop = SHOP();
  if (!shop) throw new Error('SHOPIFY_STORE is not set');
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set');

  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  });
  const text = await r.text();
  if (!r.ok) {
    // app_not_installed is the one worth naming: the credentials are right and
    // the app simply has not been installed on the store yet.
    if (text.includes('app_not_installed')) {
      throw new Error(`Shopify says the app is not installed on ${shop}. `
        + 'Install it from the Dev Dashboard (Overview -> Install app) and try again.');
    }
    throw new Error(`Shopify token ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text);
  // Renew a few minutes early; a token that expires mid-sync fails the run.
  const ttl = (Number(j.expires_in) || 86400) * 1000;
  cached = { token: j.access_token, expires: Date.now() + ttl - 5 * 60000 };
  return cached.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GraphQL call, with the two things that actually go wrong in production:
// the cost-based rate limit, and the occasional 5xx.
async function gql(query, variables = {}, attempt = 0) {
  const r = await fetch(`https://${SHOP()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
    body: JSON.stringify({ query, variables }),
  });

  if (r.status === 429 || r.status >= 500) {
    if (attempt >= 4) throw new Error(`Shopify ${r.status} after ${attempt} retries`);
    await sleep(2000 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }

  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Shopify ${r.status}: ${text.slice(0, 200)}`); }

  if (j.errors) {
    const throttled = JSON.stringify(j.errors).includes('THROTTLED');
    if (throttled && attempt < 4) {
      await sleep(3000 * (attempt + 1));
      return gql(query, variables, attempt + 1);
    }
    throw new Error('Shopify GraphQL: ' + JSON.stringify(j.errors).slice(0, 300));
  }

  // The leaky bucket. Waiting here, before the next call, is cheaper than
  // being throttled and retrying the whole query.
  const t = j.extensions && j.extensions.cost && j.extensions.cost.throttleStatus;
  if (t && t.currentlyAvailable < 200) {
    await sleep(Math.ceil((400 - t.currentlyAvailable) / (t.restoreRate || 100)) * 1000);
  }
  return j.data;
}

async function shopInfo() {
  const d = await gql(`{ shop { name myshopifyDomain currencyCode ianaTimezone } }`);
  return d.shop;
}

module.exports = { gql, token, shopInfo, toIst, istDayToUtcIso, API_VERSION, SHOP };
