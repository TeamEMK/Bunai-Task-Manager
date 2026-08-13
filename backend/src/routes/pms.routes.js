// ══════════════════════════════════════════════════════
// PMS — Production Management, read-only.
// One view over what the Merch FMS, Process FMS and PO sheets already hold. It
// never writes: the forms keep owning their sheets.
//
// The rows below are SAMPLE data so the screen can be judged before any sheet
// is wired up. To go live, replace loadOrders() with the Sheets reads — the
// shape it returns is the whole contract, nothing else has to change.
// ══════════════════════════════════════════════════════
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');

const router = express.Router();

const STAGES = ['Knitting', 'Linking', 'Checking', 'Washing', 'Packing'];

const SAMPLE = [
  { so: 'SO-1042', party: 'Rajkamal Textiles', style: 'RK-BLK-440', pcs: 600, unit: 'Unit 1',
    materials: [
      { name: 'Cotton Yarn 30s', type: 'FABRIC', qty: 420, uom: 'KGS', vendor: 'Shree Yarn Co', status: 'Material Issue' },
      { name: 'Neck Rib', type: 'FABRIC', qty: 60, uom: 'KGS', vendor: 'Shree Yarn Co', status: 'Inhouse' },
      { name: 'Woven Label', type: 'ACCESSORY', qty: 600, uom: 'PCS', vendor: 'Label House', status: 'Raise PO' },
    ],
    pos: [{ poNo: 'PO-311', vendor: 'Label House', material: 'ACCESSORY', qty: 600, price: 2.4, date: '2026-07-28' }],
    process: [
      { stage: 'Knitting', qty: 600, date: '2026-07-30' },
      { stage: 'Linking', qty: 540, date: '2026-08-01' },
      { stage: 'Checking', qty: 480, date: '2026-08-02' },
    ] },
  { so: 'SO-1043', party: 'Sohan Apparels', style: 'SA-NVY-220', pcs: 350, unit: 'Unit 2',
    materials: [
      { name: 'Acrylic Yarn', type: 'FABRIC', qty: 260, uom: 'KGS', vendor: 'Gupta Fibres', status: 'Raise PO' },
      { name: 'Buttons 18L', type: 'ACCESSORY', qty: 2100, uom: 'PCS', vendor: 'Trim Mart', status: 'Raise PO' },
    ],
    pos: [],
    process: [] },
  { so: 'SO-1039', party: 'Richa Group', style: 'RG-GRY-118', pcs: 900, unit: 'Unit 1',
    materials: [
      { name: 'Merino Blend', type: 'FABRIC', qty: 700, uom: 'KGS', vendor: 'Woolmark Ltd', status: 'Inhouse' },
      { name: 'Poly Bag', type: 'ACCESSORY', qty: 900, uom: 'PCS', vendor: 'PackWell', status: 'Inhouse' },
    ],
    pos: [{ poNo: 'PO-298', vendor: 'Woolmark Ltd', material: 'FABRIC', qty: 700, price: 610, date: '2026-07-12' }],
    process: [
      { stage: 'Knitting', qty: 900, date: '2026-07-18' },
      { stage: 'Linking', qty: 900, date: '2026-07-22' },
      { stage: 'Checking', qty: 900, date: '2026-07-25' },
      { stage: 'Washing', qty: 880, date: '2026-07-29' },
      { stage: 'Packing', qty: 875, date: '2026-08-01' },
    ] },
];

// Swap this one function for the Sheets reads when the sheet IDs are in .env.
async function loadOrders() {
  return SAMPLE;
}

router.get('/pms/orders', requireAuth, asyncRoute(async (req, res) => {
  const rows = await loadOrders();

  const orders = rows.map(o => {
    const lastStage = o.process.length ? o.process[o.process.length - 1] : null;
    // Progress is stage position, not quantity — a stage half-done still means
    // the order has reached that stage.
    const stageIdx = lastStage ? STAGES.indexOf(lastStage.stage) : -1;
    const pending = o.materials.filter(m => m.status === 'Raise PO').length;
    return {
      ...o,
      materialCount: o.materials.length,
      awaitingPO: pending,
      poCount: o.pos.length,
      lastStage: lastStage ? lastStage.stage : null,
      lastQty: lastStage ? lastStage.qty : null,
      lastDate: lastStage ? lastStage.date : null,
      progressPct: stageIdx < 0 ? 0 : Math.round(((stageIdx + 1) / STAGES.length) * 100),
      // What actually needs a human: material not ordered, or nothing started.
      blocked: pending > 0 && !o.process.length,
    };
  });

  res.json({
    sample: true,   // the UI says so out loud, so nobody mistakes it for live data
    stages: STAGES,
    orders,
  });
}));

module.exports = router;
