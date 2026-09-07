// Runs every *.test.js in this folder.  node backend/tests/run.js
//
// These cover the two pieces of FMS logic that cannot be checked by reading
// them: the heuristics that read a sheet's layout, and the resolution of a
// stored header name back to a column that has since moved.
//
// detect / columns / introspect need nothing but node.
// roundtrip needs the database (it inserts a throwaway FMS and deletes it).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;

for (const f of files) {
  process.stdout.write(`\n${'─'.repeat(60)}\n${f}\n${'─'.repeat(60)}\n`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  } catch (_) { failed++; }
}

console.log(`\n${failed ? `❌ ${failed} suite(s) failed` : `✅ all ${files.length} suites passed`}\n`);
process.exit(failed ? 1 : 0);
