// ════════════════════════════════════════════════════════════════════════
//  daily-sync.js — roz ka poora data refresh, ek command mein.
//
//    node backend/scripts/daily-sync.js
//    node backend/scripts/daily-sync.js --days 30     orders ka window
//
//  Railway ki cron service isi ko chalati hai. Railway cron ek hi shart rakhta
//  hai: process khatam hona chahiye. Isliye yeh har DB pool band karta hai aur
//  saaf exit code deta hai — 0 sab theek, 1 agar koi hissa fail hua.
//
//  KYUN EK HI SCRIPT: pehle yeh kaam GitHub Actions ke chaar alag steps mein
//  tha. Woh workflow aaj tak ek baar bhi nahi chala (sync log mein sirf haath
//  se chalaye gaye run hain), aur har step apne secrets alag maangta tha.
//  Ek entry point ka matlab hai ek jagah jo fail ho sakti hai, aur ek jagah
//  jise dekhna hai.
//
//  EK HISSA FAIL HO TO BAAKI RUKTE NAHI. Orders na aa paana koi wajah nahi ki
//  stock bhi purana pada rahe. Har hissa alag se chalta hai, aur ant mein
//  poori report chhapti hai — chup-chaap aadha kaam karke "ok" kehna sabse
//  bura nateeja hota.
//
//  KRAM: items pehle, kyunki inventorySnapshot enumerate nahi karta — use SKU
//  batane padte hain aur woh list uni_items se aati hai.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ORDER_DAYS  = Number(arg('--days', process.env.SYNC_ORDER_DAYS || 10));
const RETURN_DAYS = Number(arg('--return-days', process.env.SYNC_RETURN_DAYS || 10));

const iso = d => new Date(d).toISOString();
const since = days => iso(Date.now() - days * 86400000);

// Har step: naam, kya chalana hai, aur kya yeh chhoda ja sakta hai.
// `skip` true lautaye to step gina nahi jaata — jaise Unicommerce configured
// hi na ho. Woh fail nahi hai.
const steps = [];

function step(name, run, skip) { steps.push({ name, run, skip }); }

const uni = require(path.join(__dirname, '..', 'unicommerce'));
const uniSync = require(path.join(__dirname, '..', 'unicommerce-sync'));
const uniOrders = require(path.join(__dirname, '..', 'uni-orders-sync'));
const vinReturns = require(path.join(__dirname, '..', 'returns-sync'));

const uniMissing = () => uni.missingConfig().length
  ? 'Unicommerce configured nahi (' + uni.missingConfig().join(', ') + ')' : null;

step('SKU master', async () => {
  await uniSync.ensureTables();
  const r = await uniSync.syncItems();
  return `${r.items} SKUs`;
}, uniMissing);

step('Stock', async () => {
  const r = await uniSync.syncStock();
  return `${r.rows} rows, ${r.facilities} facility` + (r.zeroed ? `, ${r.zeroed} zero` : '');
}, uniMissing);

// UPDATED, CREATED nahi: ek order jo pichhle hafte bana aur aaj dispatch hua,
// CREATED window mein kabhi dobara nahi aayega aur uska status purana hi
// rah jayega.
step('Orders', async () => {
  await uniOrders.ensureTables();
  const r = await uniOrders.syncOrders({
    fromDate: since(ORDER_DAYS), toDate: iso(Date.now()), dateType: 'UPDATED',
  });
  return `${r.orders} orders` + (r.failed ? `, ${r.failed} fail` : '');
}, uniMissing);

// Returns abhi bhi Vin eRetail par hain — Unicommerce par ek bhi return nahi
// aaya, to wahan padhne ko kuch hai hi nahi. Pehla return aate hi yeh step
// Unicommerce par chala jayega.
step('Returns (Vin eRetail)', async () => {
  const fmt = d => {
    const p = n => String(n).padStart(2, '0');
    const x = new Date(d);
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  const r = await vinReturns.syncReturns({
    fromDate: fmt(Date.now() - RETURN_DAYS * 86400000), toDate: fmt(Date.now()),
  });
  return `${r.returns} returns`;
}, () => (process.env.VIN_ORDER_API_KEY ? null : 'VIN_ORDER_API_KEY set nahi'));

(async () => {
  const started = Date.now();
  console.log(`Daily sync — ${new Date().toISOString()}`);
  console.log(`orders window ${ORDER_DAYS}d · returns window ${RETURN_DAYS}d\n`);

  const results = [];
  for (const s of steps) {
    const why = s.skip && s.skip();
    if (why) {
      console.log(`⏭  ${s.name} — skip: ${why}`);
      results.push({ name: s.name, state: 'skipped', note: why });
      continue;
    }
    const t = Date.now();
    try {
      const note = await s.run();
      const secs = ((Date.now() - t) / 1000).toFixed(1);
      console.log(`✅ ${s.name} — ${note} (${secs}s)`);
      results.push({ name: s.name, state: 'ok', note, secs });
    } catch (e) {
      const secs = ((Date.now() - t) / 1000).toFixed(1);
      console.error(`❌ ${s.name} — ${e.message} (${secs}s)`);
      results.push({ name: s.name, state: 'failed', note: e.message, secs });
    }
  }

  // Pools band karna zaroori hai, warna process latka rehta hai aur Railway
  // use agle scheduled run par maar deta hai.
  for (const m of [uniSync, uniOrders, vinReturns]) {
    try { await m.pool.end(); } catch (_) { /* already closed */ }
  }

  const failed = results.filter(r => r.state === 'failed');
  console.log(`\n── ${((Date.now() - started) / 1000).toFixed(1)}s mein khatam ──`);
  results.forEach(r => console.log(`   ${r.state.padEnd(7)} ${r.name}${r.note ? ' — ' + r.note : ''}`));

  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} step fail hue`);
    process.exit(1);
  }
  console.log('\nSab theek.');
})().catch(e => { console.error('\n✗ daily-sync:', e.message); process.exit(1); });
