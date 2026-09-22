// ══════════════════════════════════════════════════════
// INVENTORY — company equipment and who is holding it.
//
// Two levels, not one. Seeing the tab is everyone's — what you are holding is
// yours to look at, and saying "I am giving this back" is yours to say. Handing
// kit out, confirming it is physically back, and taking it off the register are
// the custodian's, because they are statements about company property rather
// than about your own desk.
//
// The custodian here is an admin — the same pair of hands the HR and Users
// sections already answer to.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

const isCustodian = req => req.session.role === 'admin';

const TYPES = ['laptop', 'keyboard', 'mouse', 'mobile', 'sim', 'charger', 'other'];
const CONDITIONS = ['new', 'good', 'fair', 'poor'];

// Why an assignment ended, and where that leaves the item. One source of truth
// for both the reasons on offer and the status each one implies — the frontend
// carries the same three, so keep them in step.
const RETURN_REASONS = Object.freeze({
  offboarding: { label: 'Offboarding', itemStatus: 'available' },
  damaged: { label: 'Damaged', itemStatus: 'damaged' },
  retired: { label: 'Retired', itemStatus: 'retired' },
});

// Own-property check rather than a bare lookup: the reason comes off the wire,
// and `RETURN_REASONS['constructor']` would otherwise pass and then blow up
// with an undefined itemStatus.
const returnReason = r =>
  (typeof r === 'string' && Object.prototype.hasOwnProperty.call(RETURN_REASONS, r))
    ? RETURN_REASONS[r]
    : null;

// Retiring an item is a judgement about the asset's life, so it stays with the
// custodian. Somebody handing kit back can only say why they are handing it
// back, not that it is finished.
const HOLDER_REASONS = new Set(['offboarding', 'damaged']);

// The browser shrinks a photo to about 1000px before sending it, which lands
// well under this. The cap is here for what the browser did not send: a
// hand-rolled request that would otherwise put megabytes on the row.
const MAX_PHOTO_CHARS = 1.5 * 1024 * 1024;

function cleanPhoto(photo) {
  if (photo === undefined || photo === null || photo === '') return { value: null };
  if (typeof photo !== 'string' || !/^data:image\/[a-z+]+;base64,/i.test(photo)) {
    return { error: 'That photo could not be read.' };
  }
  if (photo.length > MAX_PHOTO_CHARS) return { error: 'That photo is too large.' };
  return { value: photo };
}

// What the form sends, checked the same way whether the item is going into the
// shared pool or straight onto the adder's own desk.
function cleanItem(body) {
  const type = String(body.type || '').trim();
  if (!TYPES.includes(type)) throw httpError(400, 'Choose a valid type.');

  // Brand and model are what tell two items of the same type apart on the
  // card, since there is no free-text name field.
  const brand = String(body.brand || '').trim();
  const model = String(body.model || '').trim();
  if (!brand) throw httpError(400, 'Brand is required.');
  if (!model) throw httpError(400, 'Model is required.');

  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'Name is required.');

  const photo = cleanPhoto(body.photo);
  if (photo.error) throw httpError(400, photo.error);

  const condition = String(body.item_condition || 'good').trim();

  return {
    name,
    type,
    brand,
    model,
    serial_number: String(body.serial_number || '').trim(),
    photo: photo.value,
    item_condition: CONDITIONS.includes(condition) ? condition : 'good',
    notes: String(body.notes || '').trim(),
  };
}

// An item, with whoever is holding it now. The join is deliberately on the two
// open states only: a returned assignment is history, and pulling it in here
// would show a laptop as still being with the person who gave it back.
const SELECT_ITEMS = `
  SELECT i.*,
         u.id AS assigned_to_id, u.name AS assigned_to_name, u.role AS assigned_to_role,
         a.id AS assignment_id, a.assigned_at, a.handover_status, a.return_reason, a.handover_notes,
         cu.name AS created_by_name
    FROM inventory_items i
    LEFT JOIN inventory_assignments a
      ON a.item_id = i.id AND a.handover_status IN ('active', 'pending_handover')
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN users cu ON cu.id = i.created_by
`;

// ── LIST — the register. A custodian gets everything; everybody else gets what
// is on their own desk, and nothing they could not already see. ──
router.get('/inventory', requireAuth, asyncRoute(async (req, res) => {
  const manage = isCustodian(req);
  const items = manage
    ? await db.rows(`${SELECT_ITEMS} WHERE i.is_deleted = 0 ORDER BY i.created_at DESC`)
    : await db.rows(
      `${SELECT_ITEMS} WHERE i.is_deleted = 0 AND a.user_id = ? ORDER BY i.created_at DESC`,
      [req.session.userId]);

  res.json({ items, canManage: manage, userId: req.session.userId });
}));

// ── HISTORY — every spell of somebody holding something, including the ones
// already closed. This is the history view, so it is the custodian's alone. ──
router.get('/inventory/assignments', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const assignments = await db.rows(`
    SELECT a.*, i.name AS item_name, i.type AS item_type, i.brand, i.model,
           i.serial_number, i.photo,
           u.name AS user_name, u.role AS user_role, u.department AS user_department,
           ab.name AS assigned_by_name
      FROM inventory_assignments a
      JOIN inventory_items i ON i.id = a.item_id
      JOIN users u ON u.id = a.user_id
      LEFT JOIN users ab ON ab.id = a.assigned_by
     WHERE i.is_deleted = 0
     ORDER BY a.assigned_at DESC
     LIMIT 500`);
  res.json({ assignments });
}));

// ── Who an item can be handed to. Its own endpoint rather than /api/users,
// which sends far more of the account than a name picker needs. ──
router.get('/inventory/people', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const people = await db.rows(
    'SELECT id, name, email, role, department FROM users ORDER BY name');
  res.json(people);
}));

// ── ADD to the shared pool, unassigned ──
router.post('/inventory', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const row = cleanItem(req.body);
  const [r] = await db.query(
    `INSERT INTO inventory_items
       (name, type, brand, model, serial_number, photo, item_condition, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.name, row.type, row.brand, row.model, row.serial_number, row.photo,
      row.item_condition, row.notes, req.session.userId]);
  res.json({ success: true, id: r.insertId });
}));

// ── SELF-ADD — kit somebody already has, put on the register by the person
// holding it. No approval step: the register being right matters more than it
// being filed by the right hand, and the item lands assigned to them, which is
// what it already is in real life. ──
router.post('/inventory/self-add', requireAuth, asyncRoute(async (req, res) => {
  const row = cleanItem(req.body);
  const me = req.session.userId;
  const [r] = await db.query(
    `INSERT INTO inventory_items
       (name, type, brand, model, serial_number, photo, item_condition, notes, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?)`,
    [row.name, row.type, row.brand, row.model, row.serial_number, row.photo,
      row.item_condition, row.notes, me]);
  await db.query(
    'INSERT INTO inventory_assignments (item_id, user_id, assigned_by) VALUES (?, ?, ?)',
    [r.insertId, me, me]);
  res.json({ success: true, id: r.insertId });
}));

// ── ASSIGN — hand an item to somebody ──
router.post('/inventory/assign', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const itemId = Number(req.body.item_id);
  const userId = Number(req.body.user_id);
  if (!itemId || !userId) throw httpError(400, 'Pick an item and a person.');

  const item = await db.one(
    'SELECT status FROM inventory_items WHERE id = ? AND is_deleted = 0', [itemId]);
  if (!item) throw httpError(404, 'Item not found.');
  // Only available stock goes out. 'damaged' and 'retired' are out of
  // circulation on purpose, and 'assigned' is already with somebody.
  if (item.status !== 'available') {
    throw httpError(400, `This item is ${item.status} — it cannot be handed out.`);
  }

  const person = await db.one('SELECT id FROM users WHERE id = ?', [userId]);
  if (!person) throw httpError(404, 'That person no longer has an account.');

  await db.query(
    'INSERT INTO inventory_assignments (item_id, user_id, assigned_by) VALUES (?, ?, ?)',
    [itemId, userId, req.session.userId]);
  await db.query("UPDATE inventory_items SET status = 'assigned' WHERE id = ?", [itemId]);
  res.json({ success: true });
}));

// ── HANDOVER (step one) — say it is coming back.
//
// Two ways in, one endpoint: a custodian starting the handover because someone
// is leaving, or the holder themselves saying "I am giving this back". Either
// way this only raises the intent — the item stays listed as theirs until the
// custodian confirms receipt through the return below. ──
router.post('/inventory/handover/:id', requireAuth, asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '');
  if (!returnReason(reason)) throw httpError(400, 'Pick a reason.');

  const a = await db.one('SELECT * FROM inventory_assignments WHERE id = ?', [req.params.id]);
  if (!a) throw httpError(404, 'Assignment not found.');

  const custodian = isCustodian(req);
  if (!custodian && a.user_id !== req.session.userId) {
    throw httpError(403, 'You can only return equipment assigned to you.');
  }
  if (!custodian && !HOLDER_REASONS.has(reason)) {
    throw httpError(403, 'Only a custodian can retire an item.');
  }
  if (a.handover_status !== 'active') {
    throw httpError(400, 'This one is already on its way back.');
  }

  await db.query(
    `UPDATE inventory_assignments
        SET handover_status = 'pending_handover', handover_notes = ?, return_reason = ?
      WHERE id = ?`,
    [String(req.body.notes || '').trim(), reason, req.params.id]);
  res.json({ success: true });
}));

// ── RETURN (step two) — the custodian has it in hand.
//
// The reason picked here is the final word — it may correct whatever the
// holder claimed at step one — and it decides where the item lands: damaged
// and retired take it out of circulation, offboarding puts it back in stock. ──
router.post('/inventory/return/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '');
  const mapped = returnReason(reason);
  if (!mapped) throw httpError(400, 'Pick a reason.');

  const a = await db.one('SELECT * FROM inventory_assignments WHERE id = ?', [req.params.id]);
  if (!a) throw httpError(404, 'Assignment not found.');
  if (a.handover_status === 'returned') throw httpError(400, 'This one is already back.');

  await db.query(
    `UPDATE inventory_assignments
        SET handover_status = 'returned', returned_at = NOW(), return_reason = ?
      WHERE id = ?`,
    [reason, req.params.id]);
  await db.query('UPDATE inventory_items SET status = ? WHERE id = ?', [mapped.itemStatus, a.item_id]);
  res.json({ success: true, itemStatus: mapped.itemStatus });
}));

// ── EDIT — correct an item's details. Whatever is not in the body is left
// alone, so a single field can be sent from the row itself. ──
router.put('/inventory/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const row = {};
  for (const f of ['name', 'brand', 'model', 'serial_number', 'notes']) {
    if (req.body[f] !== undefined) row[f] = String(req.body[f]).trim();
  }
  if (req.body.type !== undefined) {
    if (!TYPES.includes(String(req.body.type))) throw httpError(400, 'Choose a valid type.');
    row.type = String(req.body.type);
  }
  if (req.body.item_condition !== undefined) {
    if (!CONDITIONS.includes(String(req.body.item_condition))) {
      throw httpError(400, 'Choose a valid condition.');
    }
    row.item_condition = String(req.body.item_condition);
  }
  if (req.body.photo !== undefined) {
    const photo = cleanPhoto(req.body.photo);
    if (photo.error) throw httpError(400, photo.error);
    row.photo = photo.value;
  }
  // status is deliberately not editable here. Where an item stands is the
  // result of assigning it and taking it back — letting the edit form set it
  // by hand would leave an item marked available while somebody is still
  // holding it.

  const cols = Object.keys(row);
  if (!cols.length) return res.json({ success: true });

  await db.query(
    `UPDATE inventory_items SET ${cols.map(c => '`' + c + '` = ?').join(', ')}
      WHERE id = ? AND is_deleted = 0`,
    [...cols.map(c => row[c]), req.params.id]);
  res.json({ success: true });
}));

// ── DELETE — off the register, not erased. An item that has been in somebody's
// hands is a thing the office asks about a year later, and its assignment
// history hangs off this row. ──
router.delete('/inventory/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const item = await db.one(
    'SELECT status FROM inventory_items WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (!item) throw httpError(404, 'Item not found.');
  // Taking an item off the register while somebody is holding it would lose
  // the only record that they have it.
  if (item.status === 'assigned') {
    throw httpError(400, 'Somebody is holding this. Take it back first.');
  }
  await db.query('UPDATE inventory_items SET is_deleted = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
