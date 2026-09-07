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
function detectSteps(columns) {
  const cols = Array.isArray(columns) ? columns : [];
  const bands = bandsFrom(cols);

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
    const delayCol = find('delay');

    const extraRows = [];
    for (const c of inBand) {
      if (c === planCol || c === actualCol || c === doerCol || c === delayCol) continue;
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
      stepName: stepNameFrom(planCol?.name, actualCol?.name) || `Step ${i + 1}`,
      // Blank whenever the evidence was not there; the screen shows an empty select.
      planCol: planCol?.col || '',
      planHeader: planCol?.name || '',
      actualCol: actualCol?.col || '',
      actualHeader: actualCol?.name || '',
      doerNameCol: doerCol?.col || '',
      doerNameHeader: doerCol?.name || '',
      delayReasonCol: delayCol?.col || '',
      delayReasonHeader: delayCol?.name || '',
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
  detectSteps, classify, fieldTypeFor, stepNameFrom, exclusionReason, bandsFrom,
  DOER_RE, DELAY_RE, PLAN_RE, ACTUAL_RE,
};
