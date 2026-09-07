// ══════════════════════════════════════════════════════
// COLUMN RESOLUTION — header names, not letters.
//
// A column letter is a position, and positions move: insert one column in the
// middle of the sheet and every mapping after it points at the wrong data. So a
// step stores the header NAME of each column it uses, and that name is resolved
// back to a position every time the sheet is read or written.
//
// The hard part is that names repeat — "Planned" and "Actual" appear once per
// step — so a name has to resolve to the one belonging to THAT step. Two things
// disambiguate it:
//
//   1. The step's signature: the ordered set of headers it maps (plan, actual,
//      doer, delay, extras). The right band is the one where the whole set
//      lines up, which is what tells step 4 apart from step 5 even when both
//      call their columns "Planned"/"Actual".
//   2. The saved occurrence number, as a tie-break when signatures are
//      identical — at which point nothing could tell them apart anyway.
//
// If a header was renamed and can no longer be found, the stored letter is used
// and the caller is told, rather than silently reading a neighbouring column.
// ══════════════════════════════════════════════════════
const { colToIdx, idxToCol } = require('../utils/sheetCells');

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// header name → every position that carries it, in sheet order.
function headerIndex(headers) {
  const positions = new Map();
  (headers || []).forEach((h, i) => {
    const key = norm(h);
    if (!key) return;
    const list = positions.get(key);
    if (list) list.push(i); else positions.set(key, [i]);
  });
  return positions;
}

// The roles a step maps, in the order they sit in the sheet.
const ROLES = ['plan', 'actual', 'doer', 'delay', 'complete'];

// Reads the JSON blob a step stores. Absent on rows saved before this existed.
function parseHeaderMap(step) {
  if (!step) return null;
  const raw = step.header_map;
  if (!raw) return null;
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (m && typeof m === 'object') ? m : null;
  } catch (_) { return null; }
}

// Builds the mapping from the CURRENT sheet: used to backfill a step that
// predates header mapping, and to record one when an FMS is saved.
function buildHeaderMap(step, extraRows, headers) {
  const positions = headerIndex(headers);
  const occOf = (idx, name) => {
    const list = positions.get(norm(name)) || [];
    const at = list.indexOf(idx);
    return at < 0 ? 0 : at;
  };
  const entry = (letter) => {
    const idx = colToIdx(letter);
    if (idx < 0) return null;
    const name = headers?.[idx];
    if (!name) return null;                      // no header text to key on
    return { h: String(name).trim(), occ: occOf(idx, name) };
  };

  return {
    plan: entry(step.plan_col),
    actual: entry(step.actual_col),
    doer: entry(step.doer_name_col),
    delay: entry(step.delay_reason_col),
    complete: entry(step.complete_col),
  };
}

// The same thing for one extra-input row. Its header lives on the row itself,
// not in the step's map: saving an FMS deletes and re-inserts every extra row,
// so anything keyed by row id would go stale on the next save.
function buildRowHeader(row, headers) {
  const idx = colToIdx(row.col_letter);
  if (idx < 0) return { header_name: '', header_occ: 0 };
  const name = headers?.[idx];
  if (!name) return { header_name: '', header_occ: 0 };
  const list = headerIndex(headers).get(norm(name)) || [];
  const at = list.indexOf(idx);
  return { header_name: String(name).trim(), header_occ: at < 0 ? 0 : at };
}

// "Columns to show" is a list of positions; this records the header name behind
// each so the shown set follows a moved column too.
function buildShowMap(showCols, headers) {
  const positions = headerIndex(headers);
  const out = [];
  for (const idx of showCols || []) {
    const name = headers?.[idx];
    if (!name) continue;
    const list = positions.get(norm(name)) || [];
    const at = list.indexOf(idx);
    out.push({ h: String(name).trim(), occ: at < 0 ? 0 : at });
  }
  return out;
}

// Scores how well a step's signature fits a band that starts at `startIdx`.
// Each header found in order inside the band counts once.
function scoreBand(signature, startIdx, endIdx, positions) {
  let cursor = startIdx;
  let hits = 0;
  for (const name of signature) {
    const list = positions.get(norm(name)) || [];
    const found = list.find(i => i > cursor && i < endIdx);
    if (found === undefined) continue;
    hits++;
    cursor = found;
  }
  return hits;
}

// resolveStep(step, extraRows, headers)
//   → { plan, actual, doer, delay, extras: {rowId: idx}, show: [idx], unresolved: [role] }
// Every value is a 0-based column index, or -1 when the column is not mapped.
function resolveStep(step, extraRows = [], headers = []) {
  const positions = headerIndex(headers);
  const map = parseHeaderMap(step);
  const unresolved = [];

  // Letters are the fallback, and the whole answer for a step that has no
  // header map yet — which is exactly how this behaved before.
  const byLetter = {
    plan: colToIdx(step.plan_col),
    actual: colToIdx(step.actual_col),
    doer: step.doer_name_col ? colToIdx(step.doer_name_col) : -1,
    delay: step.delay_reason_col ? colToIdx(step.delay_reason_col) : -1,
    complete: step.complete_col ? colToIdx(step.complete_col) : -1,
  };
  if (!map) {
    const extras = {};
    for (const r of extraRows) extras[r.id] = r.col_letter ? colToIdx(r.col_letter) : -1;
    return { ...byLetter, extras, show: parseShow(step, headers, null), unresolved, mapped: false };
  }

  // ── 1) Which band belongs to this step? ──
  // Candidates are every position carrying the step's plan header.
  const planName = map.plan?.h;
  const candidates = planName ? (positions.get(norm(planName)) || []) : [];

  // The signature is everything else this step maps, in sheet order.
  const signature = [];
  for (const role of ROLES.slice(1)) if (map[role]?.h) signature.push(map[role].h);
  for (const row of extraRows) if (row.header_name) signature.push(row.header_name);

  let bandStart = -1;
  let bandEnd = headers.length;
  if (candidates.length === 1) {
    bandStart = candidates[0];
  } else if (candidates.length > 1) {
    let best = null;
    candidates.forEach((start, k) => {
      const end = k + 1 < candidates.length ? candidates[k + 1] : headers.length;
      // The signature dominates: a band where one more of this step's headers
      // lines up always beats the band it merely used to sit at. The occurrence
      // is worth a single point, so it only breaks a tie — which is what
      // happens when the steps are genuinely indistinguishable.
      const score = scoreBand(signature, start, end, positions) * 10 + (k === map.plan.occ ? 1 : 0);
      if (!best || score > best.score) best = { start, end, score };
    });
    bandStart = best.start;
    bandEnd = best.end;
  }
  if (bandStart >= 0) {
    const after = candidates.filter(i => i > bandStart);
    bandEnd = after.length ? after[0] : headers.length;
  }

  // ── 2) Resolve each role inside that band ──
  const out = { plan: -1, actual: -1, doer: -1, delay: -1, complete: -1, extras: {}, show: [], unresolved, mapped: true };

  // Resolves one header name to a position. The band is the guard rail: once we
  // know which band this step occupies, a name that only matches OUTSIDE it is
  // another step's column, and taking it would be the silent mistake this whole
  // module exists to prevent. Better to say so and use the stored letter.
  const locate = (label, entry, fallbackIdx) => {
    if (!entry?.h) return fallbackIdx;             // never mapped — nothing to resolve
    const list = positions.get(norm(entry.h)) || [];
    if (list.length) {
      if (bandStart >= 0) {
        const inBand = list.filter(i => i >= bandStart && i < bandEnd);
        if (inBand.length) return inBand[0];
        // Outside the band the only safe match is one that sits in front of
        // every step — the sheet's identity columns, which a step may
        // legitimately map. A match inside some OTHER step's block is exactly
        // the wrong column, however unique the name looks, so it is refused.
        if (list.length === 1 && candidates.length && list[0] < candidates[0]) return list[0];
      } else {
        if (list.length === 1) return list[0];
        return list[Math.min(entry.occ || 0, list.length - 1)];
      }
    }
    unresolved.push(label);                        // renamed, removed, or another step's
    return fallbackIdx;
  };
  const pick = (role, entry) => locate(role, entry, byLetter[role] ?? -1);

  out.plan = bandStart >= 0 ? bandStart : pick('plan', map.plan);
  out.actual = pick('actual', map.actual);
  out.doer = pick('doer', map.doer);
  out.delay = pick('delay', map.delay);
  out.complete = pick('complete', map.complete);

  for (const row of extraRows) {
    const fallback = row.col_letter ? colToIdx(row.col_letter) : -1;
    const entry = row.header_name ? { h: row.header_name, occ: row.header_occ || 0 } : null;
    out.extras[row.id] = locate(`extra:${row.id}`, entry, fallback);
  }

  out.show = parseShow(step, headers, map);
  return out;
}

// "Columns to show" is stored as indexes; once header names exist they are
// resolved the same way so the shown set follows a moved column too.
function parseShow(step, headers, map) {
  let saved = [];
  try { saved = JSON.parse(step.show_cols || '[]'); } catch (_) { saved = []; }
  if (!Array.isArray(saved)) return [];
  const names = map?.show;
  if (!Array.isArray(names) || !names.length) return saved.filter(n => Number.isInteger(n));
  const positions = headerIndex(headers);
  const out = [];
  names.forEach((entry, i) => {
    const list = positions.get(norm(entry.h)) || [];
    if (list.length) out.push(list[Math.min(entry.occ || 0, list.length - 1)]);
    else if (Number.isInteger(saved[i])) out.push(saved[i]);
  });
  return out;
}

// Convenience for the write paths, which need a letter rather than an index.
const letterAt = (idx) => (idx >= 0 ? idxToCol(idx) : '');

module.exports = {
  norm, headerIndex, parseHeaderMap, buildHeaderMap, buildRowHeader, buildShowMap,
  resolveStep, parseShow, letterAt, scoreBand,
};
