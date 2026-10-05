// ════════════════════════════════════════════════════════════════════════
//  test-unicommerce.js — Uniware se kya-kya mil raha hai, ek nazar mein.
//
//    node backend/scripts/test-unicommerce.js
//    node backend/scripts/test-unicommerce.js --full     (poora response)
//
//  Token leta hai, facilities khud dhoondta hai, phir har endpoint par ek
//  chhoti call maarta hai aur jo wapas aaya woh chhapta hai. DB ko haath nahi
//  lagata, kuch likhta nahi — sirf padhta hai.
//
//  Kyun: Vinculum ka sabak. Jab tak asli payload saamne na ho, field names
//  maan lena anumaan hai, aur us anumaan par bana schema baad mein poora
//  dobara likhna padta hai. Pehle dekho ki aata kya hai, phir sync likho.
//
//  REQUEST SHAPES — ye sab live tenant par confirm kiye gaye hain (2026-10-05),
//  aur teeno endpoint teen alag convention maante hain, jo yaad rakhna padta
//  hai:
//
//    saleOrder/search   fromDate / toDate / dateType, aur pagination
//                       searchOptions ke ANDAR (displayStart, displayLength)
//    itemType/search    sirf searchOptions
//    return/search      createdFrom / createdTo — fromDate NAHI — koi
//                       pagination nahi, aur returnType MANDATORY hai
//                       (sirf "CIR" ya "RTO"; aur kuch bhejne par enum error)
//
//  Uniware body ko seedha ek Java class par map karta hai, to extra ya galat
//  field chupchaap ignore nahi hoti — "Unrecognized field" code 1000 aata hai.
//  Yeh sakhti madadgaar hai: galti chhupti nahi.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const uni = require(path.join(__dirname, '..', 'unicommerce'));

const FULL = process.argv.includes('--full');
const CUT = FULL ? 100000 : 600;

const iso    = d => new Date(d).toISOString();              // 2026-10-05T12:00:00.000Z
const isoSec = d => new Date(d).toISOString().slice(0, 19); // return/search isi ko leta hai
const DAYS = 29;   // return/search 30 din se zyada ka range nahi leta
const since = () => Date.now() - DAYS * 86400000;

function show(label, result, pick) {
  const head = result.successful === true ? 'OK'
             : result.successful === false ? 'FAILED'
             : `HTTP ${result.status}`;
  console.log(`\n── ${label} ─────────────────────────────`);

  const why = uni.explain(result);
  console.log(`   ${head}${why ? ' — ' + why : ''}`);

  const body = pick && result.json ? pick(result.json) : result.json;
  const text = JSON.stringify(body === undefined ? result.text : body, null, 1);
  console.log(text.length > CUT
    ? text.slice(0, CUT) + `\n   … (+${text.length - CUT} chars — --full se poora)`
    : text);
}

(async () => {
  const gaps = uni.missingConfig();
  if (gaps.length) {
    console.log('Unicommerce abhi configured nahi hai. .env mein yeh chahiye:\n');
    gaps.forEach(g => console.log('  ' + g));
    process.exit(1);
  }

  console.log('Tenant:', uni.config.BASE_URL);
  console.log('User  :', uni.config.USERNAME);

  console.log('\nToken le raha hoon …');
  try {
    const t = await uni.getToken();
    console.log(`   mil gaya (${String(t).slice(0, 8)}…)`);
  } catch (e) {
    console.error('\n✗ ' + e.message);
    console.error('\nAksar iska matlab: user Admin nahi hai, ya tenant URL galat hai.');
    process.exit(1);
  }

  // ── Facilities ──
  // Pehle yeh, kyunki inventory aur returns dono ko facility code chahiye.
  // UNI_FACILITY par bharosa karne ke bajaye tenant se hi poochh lete hain —
  // naya warehouse khulne par yeh script apne aap use bhi cover kar legi.
  let facilities = [];
  const fr = await uni.uniCall('FACILITY_SEARCH', {
    facilityStatus: 'ALL',
    fromDate: iso(Date.now() - 3 * 365 * 86400000),
    toDate: iso(Date.now()),
    dateType: 'CREATED',
  });
  facilities = ((fr.json && fr.json.parties) || []).map(p => p.facilityCode);
  show('Facilities', fr, j => j.parties);

  // ── Tenant-level ──
  show('Sale order search', await uni.uniCall('ORDER_SEARCH', {
    fromDate: iso(since()), toDate: iso(Date.now()), dateType: 'CREATED',
    searchOptions: { displayStart: 0, displayLength: 2, getCount: true },
  }), j => ({ totalRecords: j.totalRecords, sample: (j.elements || []).slice(0, 1) }));

  show('Item search', await uni.uniCall('ITEM_SEARCH', {
    searchOptions: { displayStart: 0, displayLength: 2, getCount: true },
  }), j => ({ totalRecords: j.totalRecords, sample: (j.elements || []).slice(0, 1) }));

  // ── Facility-level, har facility ke liye ──
  for (const fac of facilities) {
    const inv = await uni.uniCall('INVENTORY_SNAPSHOT',
      { updatedSinceInMinutes: 1440 }, { facility: fac });
    const snaps = (inv.json && inv.json.inventorySnapshots) || [];
    show(`Inventory snapshot @ ${fac}`, inv, () => ({
      skus: snaps.length,
      totalInventory: snaps.reduce((s, x) => s + (Number(x.inventory) || 0), 0),
      note: 'sirf woh SKU jo pichhle 24 ghante mein badle; poora snapshot itemTypeSKUs bhejkar',
      sample: snaps.slice(0, 1),
    }));

    // returnType mandatory hai aur enum sirf CIR/RTO leta hai.
    for (const returnType of ['CIR', 'RTO']) {
      const rr = await uni.uniCall('RETURN_SEARCH', {
        returnType,
        createdFrom: isoSec(since()), createdTo: isoSec(Date.now()),
      }, { facility: fac });
      const list = (rr.json && rr.json.returnOrders) || [];
      show(`Returns ${returnType} @ ${fac}`, rr, () => ({
        count: list.length, sample: list.slice(0, 1),
      }));
    }
  }

  console.log('\n────────────────────────────────────────');
  console.log('Jo upar dikha hai, usi se sync aur tables banenge — pehle se nahi.');
})().catch(e => { console.error('\n✗', e.message); process.exit(1); });
