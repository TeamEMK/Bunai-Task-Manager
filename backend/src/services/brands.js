// ══════════════════════════════════════════════════════
// Which brand a SKU belongs to, read off its prefix - the catalogue has no
// brand column that can be trusted, but the SKUs are named by brand:
//
//   BUNA...    Bunai          (but not BUNAAH)
//   BUNAAH...  Aaheli         (Bunai's Aaheli line)
//   BUNMUL...  Mulmul
//
// Everything else (VSKD, BUSI, RBUNA, VKUR, BUMA ...) is "other", so choosing a
// brand never makes stock quietly disappear from the totals.
// ══════════════════════════════════════════════════════
const BRANDS = ['bunai', 'aaheli', 'mulmul', 'other'];

const pick = (v) => (BRANDS.includes(String(v || '')) ? String(v) : '');

function of(sku) {
  const s = String(sku || '').toUpperCase();
  if (s.startsWith('BUNAAH')) return 'aaheli';
  if (s.startsWith('BUNMUL')) return 'mulmul';
  if (s.startsWith('BUNA')) return 'bunai';
  return 'other';
}

// The same rule as a WHERE fragment on a SKU column. No parameters: the
// patterns are fixed, and `col` is always a column name written in the code.
function sql(brand, col) {
  switch (brand) {
    case 'aaheli': return `${col} LIKE 'BUNAAH%'`;
    case 'mulmul': return `${col} LIKE 'BUNMUL%'`;
    case 'bunai': return `(${col} LIKE 'BUNA%' AND ${col} NOT LIKE 'BUNAAH%')`;
    case 'other': return `NOT (${col} LIKE 'BUNA%' OR ${col} LIKE 'BUNMUL%')`;
    default: return '';
  }
}

module.exports = { BRANDS, pick, of, sql };
