// A SKU is one size of one colour of one design, and the design exists nowhere
// but inside the SKU string. Reading it back out is guesswork unless the rules
// are held against the real catalogue — so the last section runs all 936 SKUs
// from data/vin-skus.csv through them and checks the shape of the answer.
const path = require('path');
const fs = require('fs');
const g = require(path.join(__dirname, '..', 'src', 'services', 'skuGroup.js'));

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  console.log(`  ✗ ${label}\n      got  ${a}\n      want ${b}`);
};
const section = (t) => console.log(`\n── ${t} ──`);

section('the ordinary shapes');
eq(g.styleKey('BUNAAH-1118-BLACK-3XL'), 'BUNAAH-1118-BLACK', 'four parts: the size comes off');
eq(g.designKey('BUNAAH-1118-BLACK-3XL'), 'BUNAAH-1118', '...and the colour too, for the design');
eq(g.styleKey('BUMA-1387-M'), 'BUMA-1387', 'three parts, no colour');
eq(g.designKey('BUMA-1387-M'), 'BUMA-1387', 'so style and design are the same product');
eq(g.styleKey('BUSI-2211-38'), 'BUSI-2211', 'a numeric size');
eq(g.styleKey('buma-1387-m'), 'BUMA-1387', 'lower case in the sheet is the same SKU');

section('what must NOT be treated as a size');
// This is the one that would silently merge unrelated products.
eq(g.styleKey('BUNA-0469'), 'BUNA-0469', 'a two-part SKU ends in its design number, not a size');
eq(g.designKey('BUNA-0469'), 'BUNA-0469', 'and it stays whole');
eq(g.styleKey('BUNA-1865'), 'BUNA-1865', 'another sizeless product');
eq(g.isSizeToken('0469'), false, 'a four-digit tail is a design number');
eq(g.isSizeToken('38'), true, 'a two-digit tail in the size range is a size');
eq(g.isSizeToken('99'), false, 'a two-digit tail outside it is not');

section('the SKUs that never got a separator');
eq(g.styleKey('BUNA-3504CXXL'), 'BUNA-3504C', 'design 3504, colour C, size XXL glued together');
eq(g.designKey('BUNA-3504CXXL'), 'BUNA-3504', 'the colour letter comes off for the design');
eq(g.styleKey('BUNA-3504AL'), 'BUNA-3504A', 'a one-letter size glued on');
eq(g.designKey('BUNA-3504DXS'), 'BUNA-3504', 'every glued colour lands on one design');
eq(g.styleKey('BUNA-3504A3XL'), 'BUNA-3504A', 'a two-character size glued on');
// Longest-first matching: "XXL" must not be read as "L" with "…3504CX" left over.
eq(g.splitSize('BUNA-3504CXXL').size, 'XXL', 'the longest size wins');

section('nothing sensible to split');
eq(g.styleKey('SINGLEWORD'), 'SINGLEWORD', 'no separator at all');
eq(g.styleKey(''), '', 'empty');
eq(g.styleKey(null), '', 'missing');
eq(g.keyFor('BUNAAH-1118-BLACK-3XL', 'sku'), 'BUNAAH-1118-BLACK-3XL', 'sku mode leaves it alone');
eq(g.keyFor('BUNAAH-1118-BLACK-3XL', 'nonsense'), 'BUNAAH-1118-BLACK-3XL', 'an unknown mode falls back to per-SKU');
eq(g.isMode('style'), true, 'style is a mode');
eq(g.isMode('toString'), false, 'and an inherited property is not');

section('the product name carries the size as well');
eq(g.cleanName('BUNAI BLACK PRINTED KURTA WITH PANT SET-3XL'), 'BUNAI BLACK PRINTED KURTA WITH PANT SET', 'trailing size dropped');
eq(g.cleanName('Rust Orange Cotton Suit Set'), 'Rust Orange Cotton Suit Set', 'a name with no size is untouched');
eq(g.cleanName('Handblock Bedsheet - Double'), 'Handblock Bedsheet - Double', '"Double" is not a size, so it stays');
eq(g.cleanName(''), '', 'empty name');

section('all 936 SKUs from the real catalogue');
const csv = path.join(__dirname, '..', '..', 'data', 'vin-skus.csv');
if (!fs.existsSync(csv)) {
  console.log('  (data/vin-skus.csv not present — skipped)');
} else {
  const skus = fs.readFileSync(csv, 'utf8').split(/\r?\n/).slice(1)
    .map(l => (l.match(/^"([^"]*)"/) || [])[1]).filter(Boolean);
  eq(skus.length > 900, true, `the catalogue loaded (${skus.length} SKUs)`);

  const styles = new Set(skus.map(g.styleKey));
  const designs = new Set(skus.map(g.designKey));
  eq(styles.size < skus.length, true, `clubbing sizes actually clubs something (${skus.length} → ${styles.size})`);
  eq(designs.size < styles.size, true, `clubbing colours clubs further (${styles.size} → ${designs.size})`);

  // Every key must stay a prefix of the SKU it came from — if it ever grows or
  // drifts, two unrelated products are about to be summed into one row.
  const drifted = skus.filter(s => !s.toUpperCase().startsWith(g.designKey(s)));
  eq(drifted.slice(0, 5), [], 'every design key is a prefix of its own SKU');

  // A key must never collapse to a bare brand — "BUNA" alone would put 536
  // unrelated products in one row. Every design number has digits in it, and no
  // brand does, so that is the line.
  const brandOnly = skus.filter(s => !/\d/.test(g.designKey(s)));
  eq(brandOnly.slice(0, 5), [], 'no key collapses to a brand with no design number');

  // Segment count says nothing. VSKD2470-L is two parts ending in a size and
  // must club; BUNA-0469 is two parts ending in a design number and must not.
  const sizeless = skus.filter(s => /-\d{4}$/.test(s));
  eq(sizeless.every(s => g.styleKey(s) === s.toUpperCase()), true,
    `all ${sizeless.length} SKUs ending in a design number are left whole`);
  const fused = skus.filter(s => /^VSKD2470-/.test(s));
  eq(new Set(fused.map(g.styleKey)).size, 1,
    `the ${fused.length} two-part VSKD2470 sizes still club into one product`);

  // The glued family is the messy one: every 3504 variant should land on one design.
  const glued = skus.filter(s => /3504[A-Z]/.test(s));
  eq(new Set(glued.map(g.designKey)).size, 1, `all ${glued.length} glued 3504 SKUs share one design`);
  eq(new Set(glued.map(g.styleKey)).size > 1, true, 'but their colours stay apart at style level');
}

console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
