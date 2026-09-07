// ══════════════════════════════════════════════════════
// SKU → STYLE / DESIGN
// The stock list shows one row per SKU, and a SKU is one size of one colour of
// one design. A kurta in five sizes and two colours is ten rows, so a page of
// stock is really a page of one product — which is what the client asked us to
// club together.
//
// Nothing in the database records the design: there is no style column, no
// parent SKU, nothing. It is only in the SKU string, written as
// BRAND-DESIGN[-COLOUR]-SIZE, so it has to be read back out of there. The rules
// below come from the 936 SKUs in data/vin-skus.csv, including the messy ones —
// they are not a guess at the format.
// ══════════════════════════════════════════════════════

// The sizes that actually appear at the end of a SKU. Longest first, so
// "XXL" is taken before "XL" and "XL" before "L" when they are glued on.
const SIZE_WORDS = [
  'XXXL', 'XXL', '2XL', '3XL', '4XL', '5XL', '6XL',
  'XS', 'XL', 'S', 'M', 'L', 'FREE', 'ONESIZE',
].sort((a, b) => b.length - a.length);

const SIZE_SET = new Set(SIZE_WORDS);

// Numeric sizes run 38-46. A four-digit tail is a design number, not a size —
// "BUNA-0469" is a bedsheet with no size at all, and clipping it would merge
// unrelated products.
const isNumericSize = (t) => /^\d{2}$/.test(t) && Number(t) >= 20 && Number(t) <= 70;

const isSizeToken = (t) => SIZE_SET.has(t) || isNumericSize(t);

// Some SKUs never got the separator: BUNA-3504CXXL is design 3504, colour C,
// size XXL in one segment. Split it only when what remains still looks like a
// design — digits followed by at most a colour letter — so a real word ending
// in "s" or "m" is not chopped.
function splitGlued(token) {
  for (const size of SIZE_WORDS) {
    if (!token.endsWith(size) || token.length === size.length) continue;
    const head = token.slice(0, -size.length);
    if (/^\d+[A-Z]?$/.test(head)) return { head, size };
  }
  return null;
}

// A SKU broken into the part that identifies the product and the size, if any.
function splitSize(sku) {
  const parts = String(sku || '').trim().toUpperCase().split('-');
  if (parts.length < 2) return { base: parts, size: '' };

  const last = parts[parts.length - 1];
  // Segment count is no guide: VSKD2470-L is a two-part SKU whose tail IS a
  // size, while BUNA-0469's tail is a design number. Only the tail itself says
  // which, and isSizeToken already refuses a four-digit one.
  if (isSizeToken(last)) {
    return { base: parts.slice(0, -1), size: last };
  }
  const glued = splitGlued(last);
  if (glued) return { base: [...parts.slice(0, -1), glued.head], size: glued.size };
  return { base: parts, size: '' };
}

// Every size of one colour of one design: BUNAAH-1118-BLACK-3XL → BUNAAH-1118-BLACK
function styleKey(sku) {
  const { base } = splitSize(sku);
  return base.join('-');
}

// Every colour and size of one design: BUNAAH-1118-BLACK-3XL → BUNAAH-1118.
// The design is the brand plus the number, so anything past the second segment
// is the colour. A glued colour letter (3504C) is trimmed off the number.
function designKey(sku) {
  const { base } = splitSize(sku);
  if (base.length <= 2) {
    const [brand, num] = base;
    // BUNA-3504C → BUNA-3504
    const trimmed = num && /^\d+[A-Z]+$/.test(num) ? num.replace(/[A-Z]+$/, '') : num;
    return [brand, trimmed].filter(Boolean).join('-');
  }
  return base.slice(0, 2).join('-');
}

const MODES = { sku: (s) => String(s || ''), style: styleKey, design: designKey };
const isMode = (m) => Object.prototype.hasOwnProperty.call(MODES, m);
const keyFor = (sku, mode) => (MODES[mode] || MODES.sku)(sku);

// Product names carry the size too — "…KURTA WITH PANT SET-3XL" — so a clubbed
// row would otherwise be labelled with whichever size happened to sort first.
function cleanName(description) {
  const text = String(description || '').trim();
  const m = text.match(/[-–]\s*([A-Za-z0-9]{1,7})\s*$/);
  if (!m) return text;
  return isSizeToken(m[1].toUpperCase()) ? text.slice(0, m.index).trim() : text;
}

// Collapses stock rows onto their style or design, keeping the warehouse as a
// dimension — merging warehouses would hide where the stock actually sits, and
// that is not what was asked for.
//
// Quantities add up; the label is the name most members agree on, with its size
// suffix already stripped. The member SKUs travel with the row so the screen can
// still say what it clubbed, and so Live check has real SKUs to ask about.
function collapse(rows, mode) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFor(r.sku, mode);
    const id = key + '\u0000' + (r.warehouse || '');
    let g = groups.get(id);
    if (!g) {
      g = { sku: key, warehouse: r.warehouse, qty: 0, sold: 0, skus: [], names: new Map(), synced_at: r.synced_at };
      groups.set(id, g);
    }
    g.qty += Number(r.qty) || 0;
    g.sold += Number(r.sold) || 0;
    g.skus.push(r.sku);
    const name = cleanName(r.description);
    if (name) g.names.set(name, (g.names.get(name) || 0) + 1);
    if (r.synced_at && (!g.synced_at || r.synced_at > g.synced_at)) g.synced_at = r.synced_at;
  }
  return [...groups.values()].map((g) => {
    // Sizes of one colour share a name once the suffix is gone; colours of one
    // design do not, so the commonest wins and the count says how many there were.
    let best = '';
    let bestN = 0;
    for (const [name, n] of g.names) {
      if (n > bestN || (n === bestN && name.length < best.length)) { best = name; bestN = n; }
    }
    return {
      sku: g.sku,
      description: best,
      warehouse: g.warehouse,
      qty: g.qty,
      sold: g.sold,
      synced_at: g.synced_at,
      skuCount: g.skus.length,
      skus: g.skus,
      nameCount: g.names.size,
    };
  });
}

module.exports = { splitSize, styleKey, designKey, keyFor, cleanName, isSizeToken, isMode, MODES, collapse };
