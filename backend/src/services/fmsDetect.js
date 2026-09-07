// ══════════════════════════════════════════════════════
// FMS STEP DETECTION — pure functions over column metadata.
//
// No network, no database: it takes the output of sheetIntrospect.readColumnMeta
// and returns a suggested step configuration. That makes the heuristics
// testable against fixtures instead of against somebody's live sheet.
//
// The guiding rule comes from the person who has to check the result: a wrong
// guess is corrected on the same screen at no cost, but a silent wrong guess —
// the wrong doer, the wrong column — is expensive. So every rule here either
// fires on clear evidence or leaves the field empty.
// ══════════════════════════════════════════════════════

// Order matters. "Done By" is a doer, not an actual date; "Delay Reason" is a
// reason, not a plan. Each test runs only if the ones above it did not match.
const DOER_RE = /\b(doer|done\s*by|completed\s*by|filled\s*by|responsible|assignee|assigned\s*to|owner)\b/i;
// Deliberately narrow. A bare "Remarks" is far more useful as a text input than
// as the delay-reason column, and guessing wrong there is exactly the silent
// mistake to avoid.
const DELAY_RE = /\b(delay|delayed|late)\b/i;
const PLAN_RE = /\b(plan|plans|planned|planning|target|due|schedule|scheduled|expected|eta)\b/i;
const ACTUAL_RE = /\b(actual|actuals|done|complete|completed|finish|finished)\b/i;

const FILE_RE = /\b(file|photo|image|picture|attachment|attach|upload|scan)\b/i;
const LINK_RE = /\b(link|url|drive|hyperlink)\b/i;

// Words stripped when turning a plan/actual header into a step name.
const NAME_NOISE_RE = /\b(plan|plans|planned|planning|target|due|schedule|scheduled|expected|eta|actual|actuals|done|complete|completed|finish|finished|date|dt|time|timestamp)\b/gi;

function classify(name) {
  const n = String(name || '').trim();
  if (!n) return 'blank';
  if (DOER_RE.test(n)) return 'doer';
  if (DELAY_RE.test(n)) return 'delay';
  if (PLAN_RE.test(n)) return 'plan';
  if (ACTUAL_RE.test(n)) return 'actual';
  return 'other';
}

// "Cutting Planned Date" → "Cutting".  "Planned Date" → "" (nothing to go on).
function stepNameFrom(...headers) {
  for (const header of headers) {
    const stripped = String(header || '')
      .replace(NAME_NOISE_RE, ' ')
      .replace(/[^A-Za-z0-9&/+ -]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // A leftover of pure digits is a numbering artefact ("Plan 1" → "1"), not a name.
    if (stripped && !/^[\d\s.\-/]+$/.test(stripped)) return stripped;
  }
  return '';
}

const looksLikeUrl = (v) => /^(https?:\/\/|www\.)/i.test(String(v || '').trim());

// The field type a doer should be given for this column.
function fieldTypeFor(column) {
  if (column.validation?.type === 'list') return 'dropdown';
  const fmt = column.numberFormat;
  if (fmt === 'DATE' || fmt === 'DATE_TIME') return 'date';
  if (fmt === 'NUMBER' || fmt === 'CURRENCY' || fmt === 'PERCENT') return 'number';

  const samples = column.samples || [];
  // What the column already holds beats what its header is called.
  if (samples.length && samples.every(looksLikeUrl)) return 'link';
  if (FILE_RE.test(column.name)) return 'file';
  if (LINK_RE.test(column.name)) return 'link';
  return 'text';
}

// Why a column was left out of the suggestion. Returned to the caller so the
// screen can say what it skipped rather than quietly dropping columns.
function exclusionReason(column) {
  if (!column.name) return 'no header';
  // "Leave out any column the sheet fills itself" — whatever a doer typed here
  // would be overwritten on the next recalculation.
  if (column.isFormula) return 'formula column';
  if (column.validation?.type === 'boolean') return 'checkbox column';
  return null;
}


// How much a row looks like the header row of an FMS grid: the plan/actual
// pairs are what make it one. Used to find that row when the number the admin
// typed turns out to be a banner row instead.
function headerRowScore(row) {
  let plan = 0, actual = 0, named = 0;
  for (const cell of row || []) {
    const name = String(cell ?? '').trim();
    if (!name) continue;
    named++;
    const kind = classify(name);
    if (kind === 'plan') plan++;
    else if (kind === 'actual') actual++;
  }
  // Pairs are the signal. A row full of prose scores nothing.
  return Math.min(plan, actual) * 10 + (plan + actual) + Math.min(named, 5) * 0.1;
}

// Given the first rows of a tab, the 1-based row most likely to be the header.
function guessHeaderRow(rows) {
  let best = { row: 0, score: 0 };
  (rows || []).forEach((row, i) => {
    const score = headerRowScore(row);
    if (score > best.score) best = { row: i + 1, score };
  });
  return best.score >= 10 ? best.row : 0;    // needs at least one plan/actual pair
}

// Splits the columns into per-step bands. A step begins at every plan column;
// its band runs to the column before the next plan column.
function bandsFrom(columns) {
  const planIdxs = [];
  columns.forEach((c, i) => { if (classify(c.name) === 'plan') planIdxs.push(i); });
  return planIdxs.map((start, k) => ({
    start,
    end: k + 1 < planIdxs.length ? planIdxs[k + 1] : columns.length,
  }));
}

// columns: the array from sheetIntrospect.readColumnMeta().
// Returns { steps, leadingColumns, skipped, planColumnCount }.
// The rows above the header often describe each step group, and the sheet
// labels them in its own first column: "What" the step is, "Who" does it.
// Reading those labels beats guessing which row is which.
const WHAT_RE = /^(what|step|steps|activity|task|process|stage)\b/i;
const WHO_RE = /^(who|doer|doers|responsible|owner|by\s*whom|person)\b/i;

// The label a row carries in the columns before the first step — "What", "Who".
function rowLabel(row, firstPlanIndex) {
  for (let i = 0; i < firstPlanIndex; i++) {
    const v = String(row?.[i] ?? '').trim();
    if (v) return v;
  }
  return '';
}

// Splits the label rows by what the sheet calls them. Returns the values that
// line up with each plan column, per kind.
function labelledRows(labelRows, planIndexes) {
  const first = planIndexes[0] ?? 0;
  const pick = (re) => {
    const row = (labelRows || []).find(r => re.test(rowLabel(r, first)));
    return row ? planIndexes.map(i => String(row[i] ?? '').trim()) : null;
  };
  return { what: pick(WHAT_RE), who: pick(WHO_RE) };
}

// Picks the row above the header that actually names the steps. A sheet often
// carries a banner row ("Step1", "Step2") and a descriptive one ("Fabric
// Sourced"); both line up with the plan columns, and the descriptive one is the
// one worth having.
function stepLabelsFrom(labelRows, planIndexes) {
  let best = null;
  for (const row of labelRows || []) {
    const values = planIndexes.map(i => String(row?.[i] ?? '').trim());
    const named = values.filter(Boolean).length;
    if (!named) continue;
    // "Step 3" is a position, not a name — it tells nobody what the step is.
    const generic = values.filter(v => /^step\s*\d+$/i.test(v)).length;
    const score = named * 10 - generic * 9;
    if (!best || score > best.score) best = { score, values };
  }
  return best ? best.values : [];
}

function detectSteps(columns, { labelRows = [] } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const bands = bandsFrom(cols);
  const planIndexes = bands.map(b => cols[b.start]?.index).filter(i => i != null);
  // The sheet's own row labels first — "What" names the step, "Who" does it —
  // then the scoring heuristic for sheets that carry no such labels.
  const named = labelledRows(labelRows, planIndexes);
  const labels = named.what || stepLabelsFrom(labelRows, planIndexes);
  const doerLabels = named.who || [];

  // Columns before the first step are the row's identity (SO number, party,
  // style). They are context, never a step's input.
  const leadingColumns = (bands.length ? cols.slice(0, bands[0].start) : cols)
    .filter(c => c.name)
    .map(c => ({ name: c.name, col: c.col, index: c.index }));

  const skipped = [];
  const steps = bands.map((band, i) => {
    const inBand = cols.slice(band.start, band.end);
    const planCol = inBand[0];
    const find = (kind) => inBand.find(c => classify(c.name) === kind) || null;
    const actualCol = find('actual');
    const doerCol = find('doer');
    // The delay reason is WRITTEN, so a computed column can never be the target:
    // a sheet that derives "Time Delay" from the two dates would lose that
    // formula the first time somebody recorded a reason.
    const delayRaw = find('delay');
    const delayCol = (delayRaw && !delayRaw.isFormula) ? delayRaw : null;
    const warnings = [];
    if (delayRaw && delayRaw.isFormula) {
      warnings.push({ col: delayRaw.col, name: delayRaw.name, reason: 'computed by the sheet — left unmapped so its formula is not overwritten' });
    }
    // The column the app stamps on completion is the same hazard. When the
    // sheet derives it from a checkbox, ticking that checkbox is what completing
    // the step means here — so that becomes the write target and the derived
    // column is left to the formula that owns it.
    const checkbox = inBand.find(c => c.validation?.type === 'boolean');
    let completeCol = null;
    if (actualCol?.isFormula) {
      if (checkbox) {
        completeCol = checkbox;
        warnings.push({
          col: checkbox.col, name: checkbox.name,
          kind: 'info',
          reason: `this step completes by ticking it — "${actualCol.name}" (${actualCol.col}) is filled by the sheet, so the app ticks here instead of writing there`,
        });
      } else {
        warnings.push({
          col: actualCol.col, name: actualCol.name,
          reason: 'filled by a formula, and there is no checkbox to tick — marking the step done would replace that formula',
        });
      }
    }

    const extraRows = [];
    for (const c of inBand) {
      if (c === planCol || c === actualCol || c === doerCol || c === delayCol) continue;
      if (c === completeCol) continue;              // it is the step's switch, not an input
      if (classify(c.name) !== 'other') continue;    // a stray second plan/actual
      const reason = exclusionReason(c);
      if (reason) { skipped.push({ col: c.col, name: c.name || `COL ${c.col}`, reason, step: i + 1 }); continue; }

      const type = fieldTypeFor(c);
      extraRows.push({
        col_letter: c.col,
        header: c.name,
        label: c.name,
        field_type: type,
        dropdown_options: type === 'dropdown' ? (c.validation.options || []).join(', ') : '',
        // Auto-detected fields start optional. Forcing a doer to fill a column
        // nobody asked to be mandatory is the kind of silent decision this
        // detector must not make.
        required: 0,
      });
    }

    return {
      stepOrder: i + 1,
      // The sheet's own name for the step wins; the header text is the
      // fallback, and a placeholder only when neither says anything.
      stepName: (labels[i] && !/^step\s*\d+$/i.test(labels[i]) ? labels[i] : '')
        || stepNameFrom(planCol?.name, actualCol?.name) || `Step ${i + 1}`,
      // Blank whenever the evidence was not there; the screen shows an empty select.
      planCol: planCol?.col || '',
      planHeader: planCol?.name || '',
      actualCol: actualCol?.col || '',
      actualHeader: actualCol?.name || '',
      doerNameCol: doerCol?.col || '',
      completeCol: completeCol?.col || '',
      completeHeader: completeCol?.name || '',
      doerNameHeader: doerCol?.name || '',
      delayReasonCol: delayCol?.col || '',
      delayReasonHeader: delayCol?.name || '',
      warnings,
      // Who the sheet says does this step. The Doer COLUMN is often empty —
      // it is where the app stamps a name on completion — while the "Who" row
      // above the header is where the plan actually lives.
      doerLabel: doerLabels[i] || '',
      extraInput: extraRows.length ? 'yes' : 'no',
      extraRows,
      // Left empty on purpose: blank means "show every column", and narrowing
      // it by guesswork would hide context the doer needs.
      showCols: [],
      doers: [],
    };
  });

  return { steps, leadingColumns, skipped, planColumnCount: bands.length };
}

module.exports = {
  detectSteps, classify, fieldTypeFor, stepNameFrom, exclusionReason, bandsFrom, stepLabelsFrom,
  labelledRows, rowLabel,
  headerRowScore, guessHeaderRow,
  DOER_RE, DELAY_RE, PLAN_RE, ACTUAL_RE,
};
