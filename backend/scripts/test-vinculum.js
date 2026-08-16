// ════════════════════════════════════════════════════════════════════════
//  test-vinculum.js — connectivity check against the client's Vin eRetail.
//
//    node test-vinculum.js
//
//  Calls every enabled endpoint with an empty payload and prints what came
//  back. An empty payload is rejected on purpose: the rejection names the
//  fields that endpoint wants, which is how the request shapes get worked out
//  while we are still waiting on Vinculum's documentation.
//
//  Read-only. Every endpoint it touches is a get/fetch — nothing here can
//  change a record in the client's live Vin eRetail.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const vin = require('./vinculum');

const line = (c = '─') => console.log(c.repeat(74));

async function main() {
  line('═');
  console.log('  Vinculum connectivity check');
  line('═');
  console.log('  Base URL  :', vin.config.BASE_URL || '(not set)');
  console.log('  API Owner :', vin.config.API_OWNER || '(not set)');
  console.log('  API Key   :', vin.config.hasKey ? 'set' : '(not set)');
  console.log('  Org Id    :', vin.config.ORG_ID || '(not set)');
  console.log('');

  const gaps = vin.missingConfig();
  if (gaps.length) {
    console.log('  ✗ Missing from .env:', gaps.join(', '));
    if (gaps.includes('VIN_ORG_ID')) {
      console.log('');
      console.log('    The org id is the last unknown. Find it in Vin eRetail under');
      console.log('    Admin → Organization / Company Master, or ask Vinculum for the');
      console.log('    OrgId belonging to this API key.');
    }
    process.exit(1);
  }

  let reached = 0, blocked = 0;

  for (const [name, ep] of Object.entries(vin.ENDPOINTS)) {
    line();
    console.log(`  ${name}`);
    console.log(`  ${ep.version}/${ep.path}   (${ep.type})`);
    try {
      const r = await vin.vinCall(ep, {}, { timeout: 20000 });
      const why = vin.explain(r.code);
      console.log(`  HTTP ${r.status}   responseCode ${r.code ?? '—'}`);
      if (r.message) console.log(`  ${r.message}${why ? `  →  ${why}` : ''}`);

      if (r.code === 11 || r.code === 20) blocked++; else reached++;

      const body = r.json ? JSON.stringify(r.json, null, 2) : r.text;
      const lines = (body || '(empty response)').split('\n');
      console.log(lines.slice(0, 14).join('\n'));
      if (lines.length > 14) console.log(`  … ${lines.length - 14} more lines`);
    } catch (e) {
      console.log('  ✗', e.message);
    }
  }

  line('═');
  if (blocked && !reached) {
    console.log('  Every endpoint rejected the credentials.');
    console.log('  The API key and owner are right — it is VIN_ORG_ID that is wrong or unset.');
  } else {
    console.log(`  ${reached} endpoint(s) answered, ${blocked} still blocked on credentials.`);
  }
  line('═');
}

main().catch(e => { console.error('\nUnexpected failure:', e); process.exit(1); });
