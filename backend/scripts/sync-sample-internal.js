// ════════════════════════════════════════════════════════════════════════
//  sync-sample-internal.js - once, for the products costed before the link:
//  each Bunai Product Cost selling price onto the Sample Style MIS internal
//  costing of the style with the same id, as saving the product now does.
//
//    node backend/scripts/sync-sample-internal.js            dry run
//    node backend/scripts/sync-sample-internal.js --apply    writes it
//
//  Each change goes into the style's history as "from Bunai Product Cost",
//  and to the client's sheet when one is configured (one write a second,
//  under Google's per-minute limit). Running it again changes nothing.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const { db } = require(path.join(__dirname, '..', 'src', 'db', 'pool'));
const { toSampleInternal, priceUp } = require(path.join(__dirname, '..', 'src', 'routes', 'mulmulCost.routes'));

const APPLY = process.argv.includes('--apply');
const WHO = 'Bunai Product Cost (sync)';
const key = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const shown = (v) => (v == null ? 'blank' : '₹' + Number(v).toLocaleString('en-IN'));

(async () => {
  const costs = await db.rows(`SELECT id, sku, overhead, overhead_type, profit, profit_type
                                 FROM mulmul_costs WHERE brand = 'bunai' ORDER BY sku`);
  const lines = await db.rows(`SELECT l.cost_id, l.amount FROM mulmul_cost_lines l
                                 JOIN mulmul_costs c ON c.id = l.cost_id WHERE c.brand = 'bunai'`);
  const styles = new Map((await db.rows('SELECT style_id, costing_us FROM sample_styles')).map(s => [key(s.style_id), s]));
  let changed = 0, same = 0;
  const none = [];
  for (const c of costs) {
    const p = { ...c, lines: lines.filter(l => l.cost_id === c.id).map(l => ({ amount: l.amount == null ? null : Number(l.amount) })) };
    const s = styles.get(key(c.sku));
    if (!s) { none.push(c.sku); continue; }
    if (!APPLY) {
      // The same sum toSampleInternal makes, without writing.
      const priced = p.lines.filter(l => l.amount != null);
      const total = priced.length ? Math.round(priced.reduce((t, l) => t + l.amount, 0) * 100) / 100 : null;
      const sell = priceUp(total, c).selling;
      if (sell == null || (s.costing_us != null && Number(s.costing_us) === sell)) { same++; continue; }
      changed++;
      console.log(`  ${s.style_id.padEnd(14)} ${shown(s.costing_us).padStart(10)} -> ${shown(sell)}`);
      continue;
    }
    const r = await toSampleInternal('bunai', p, WHO, null);
    if (!r) { same++; continue; }
    changed++;
    console.log(`  ${r.style_id.padEnd(14)} ${shown(r.from).padStart(10)} -> ${shown(r.to)}`);
    await new Promise(ok => setTimeout(ok, 1100));
  }
  console.log(`\n${costs.length} Bunai products: ${changed} internal costings ${APPLY ? 'set' : 'to set'}, ${same} already right or no price,`
    + ` ${none.length} with no sample style${none.length ? ' (' + none.join(', ') + ')' : ''}.`);
  if (!APPLY) console.log('Dry run - nothing written. Add --apply.');
  process.exit(0);
})().catch(e => { console.error('✗ sync-sample-internal:', e.message); process.exit(1); });
