// ══════════════════════════════════════════════════════
// IMS, COMPUTED FROM THE DATABASE
//
// The IMS used to read a Google Sheet that somebody kept by hand: a column per
// day of stock, and a "max level" per SKU typed in by a planner. The same
// questions can be answered from what Vinculum already syncs into MySQL, so
// this does that instead and the sheet is gone.
//
// Two things the sheet had that the database does not, and how they are met:
//
//   Stock on a past day. vin_inventory only ever holds the latest figure, so
//   there was no answer. vin_inventory_daily now keeps one row per SKU per day,
//   written by each sync. It cannot be backfilled — history starts from the
//   first sync after this shipped, and the dashboard fills in as days pass.
//
//   Max level. Nobody types one any more; it is derived from how fast the SKU
//   actually sells. Average daily sales over a window, times the days of cover
//   the business wants to hold. That makes "33% of max" mean "a third of the
//   cover we intend to carry", which is the question being asked anyway.
//
// Demand is counted NET of returns. A returned unit comes back into stock, so
// treating it as sold would have us reorder against sales that undid themselves.
// ══════════════════════════════════════════════════════
const { db } = require('../db/pool');

// How far back to measure the selling rate. Long enough to survive a quiet
// week, short enough to notice a product going out of fashion.
const AVG_WINDOW_DAYS = Number(process.env.IMS_AVG_WINDOW_DAYS) || 45;
// How many days of stock to aim to hold. This is the number that turns a
// selling rate into a target, and the one worth arguing about.
const COVER_DAYS = Number(process.env.IMS_COVER_DAYS) || 30;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// ── The one query everything else is built on ─────────
// Per SKU: what it is, what is on hand, how fast it sells, and therefore what
// it should be carrying and how short of that it is.
// Everything dated is anchored to the database, never to this process's clock:
// the two disagreed by a day across a timezone and the dashboard came back with
// no dates at all.
//
// The window ends at the last order on file, not at today. When a sync has not
// run for three weeks, measuring "the last 45 days" from today counts twenty of
// them as days nobody bought anything, which halves every selling rate and
// quietly turns real shortages into comfortable-looking stock.
async function dataClock() {
  const r = await db.one(
    `SELECT CURDATE() today,
            DATE(MAX(order_date)) last_order,
            DATEDIFF(CURDATE(), DATE(MAX(order_date))) stale_days
       FROM vin_orders`);
  const today = r && r.today ? ymd(new Date(r.today)) : ymd(new Date());
  const anchor = r && r.last_order ? ymd(new Date(r.last_order)) : today;
  return { today, anchor, staleDays: Math.max(0, Number(r && r.stale_days) || 0) };
}

async function skuBase({ windowDays = AVG_WINDOW_DAYS, coverDays = COVER_DAYS, clock = null } = {}) {
  const w = Math.max(1, Math.min(365, Math.round(windowDays)));
  const c = Math.max(1, Math.min(365, Math.round(coverDays)));
  const ck = clock || await dataClock();

  // A SKU can sell without being in the master list, and can sit in stock
  // without either. Starting from vin_skus alone dropped those, and a missing
  // row reads as "nothing to order", which is the wrong way to be wrong.
  const rows = await db.rows(
    `SELECT u.sku,
            COALESCE(NULLIF(s.description,''), u.sku)        AS product_name,
            COALESCE(inv.qty, 0)                             AS today_stock,
            COALESCE(sold.qty, 0)                            AS sold_qty,
            COALESCE(ret.qty, 0)                             AS returned_qty
       FROM (SELECT sku FROM vin_skus
             UNION SELECT sku FROM vin_inventory
             UNION SELECT DISTINCT sku FROM vin_order_items WHERE sku <> '') u
       LEFT JOIN vin_skus s ON s.sku = u.sku
       LEFT JOIN (SELECT sku, SUM(qty) qty FROM vin_inventory GROUP BY sku) inv
              ON inv.sku = u.sku
       LEFT JOIN (SELECT it.sku, SUM(it.order_qty) qty
                    FROM vin_order_items it
                    JOIN vin_orders o ON o.order_id = it.order_id
                   WHERE LOWER(it.status) <> 'cancelled'
                     AND o.order_date >  DATE_SUB(?, INTERVAL ${w} DAY)
                     AND o.order_date <  DATE_ADD(?, INTERVAL 1 DAY)
                   GROUP BY it.sku) sold
              ON sold.sku = u.sku
       LEFT JOIN (SELECT ri.sku, SUM(ri.return_qty) qty
                    FROM vin_return_items ri
                    JOIN vin_returns rr ON rr.return_no = ri.return_no
                    JOIN vin_orders o   ON o.order_id = rr.eretail_order_no
                   WHERE o.order_date >  DATE_SUB(?, INTERVAL ${w} DAY)
                     AND o.order_date <  DATE_ADD(?, INTERVAL 1 DAY)
                   GROUP BY ri.sku) ret
              ON ret.sku = u.sku`,
    [ck.anchor, ck.anchor, ck.anchor, ck.anchor]);

  return rows.map((r) => {
    const netSold = Math.max(0, num(r.sold_qty) - num(r.returned_qty));
    const avgDaily = netSold / w;
    // Anything that sells at all should carry at least one unit, or a slow
    // mover rounds to a target of zero and never appears as short.
    const maxLevel = netSold > 0 ? Math.max(1, Math.ceil(avgDaily * c)) : 0;
    const todayStock = num(r.today_stock);
    return {
      sku: r.sku,
      productName: r.product_name,
      todayStock,
      soldQty: num(r.sold_qty),
      returnedQty: num(r.returned_qty),
      netSold,
      avgDaily: Math.round(avgDaily * 100) / 100,
      maxLevel,
      // Percent of the cover we mean to hold. Undefined for something that has
      // not sold at all — it has no rate, so it is not "0% of" anything.
      pct: maxLevel > 0 ? Math.round((todayStock / maxLevel) * 100) : null,
      toBeOrder: Math.max(0, maxLevel - todayStock),
      windowDays: w,
      coverDays: c,
      measuredTo: ck.anchor,
      // Kept for the screens that still print these two columns. The cover is
      // now one number rather than a lead time plus a safety factor.
      leadTime: '',
      safetyFactor: '',
    };
  });
}

// ── Dashboard ─────────────────────────────────────────
// The sheet had a column per date. vin_inventory_daily has a row per date, and
// today's live figure is folded in so the newest point is never missing just
// because a sync has not run since midnight.
async function getDashboardData(fromStr, toStr) {
  try {
    const clock = await dataClock();
    const today = clock.today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(fromStr || '')) ? fromStr : today;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(String(toStr || '')) ? toStr : today;

    // 7D / 14D / 30D / 90D used to change nothing but which history columns were
    // asked for, so every one of them produced identical counters and the
    // control looked broken. The length of the chosen range is now the window
    // the selling rate is measured over, which is what picking it implies.
    //
    // The length, not the literal dates: orders stop at the last sync, so a
    // range running past it would measure days on which nothing could have been
    // bought. Seven days means the seven up to the last order on file.
    const spanDays = Math.max(1, Math.min(365,
      Math.round((new Date(to) - new Date(from)) / 86400000) + 1));
    const base = await skuBase({ clock, windowDays: spanDays });
    const byS = new Map(base.map(r => [r.sku, r]));

    const hist = await db.rows(
      `SELECT DATE_FORMAT(day, '%Y-%m-%d') d, sku, SUM(qty) qty
         FROM vin_inventory_daily
        WHERE day >= ? AND day <= ?
        GROUP BY day, sku`, [from, to]).catch(() => []);

    const dates = [...new Set(hist.map(h => h.d))].sort();
    if (to >= today && !dates.includes(today)) dates.push(today);
    // The screen bands the latest date it is given. Handing it none - which is
    // what a range entirely before history started produces - leaves every
    // counter reading zero, as though nothing were in stock at all. Today's live
    // figure is the truthful thing to show there, and the note below says that
    // is what it is.
    const usedLiveFallback = dates.length === 0;
    if (usedLiveFallback) dates.push(today);

    const stock = new Map();
    for (const h of hist) {
      if (!stock.has(h.sku)) stock.set(h.sku, {});
      stock.get(h.sku)[h.d] = num(h.qty);
    }

    const skus = base.map((r) => {
      const byDate = stock.get(r.sku) || {};
      const stockByDate = {};
      for (const d of dates) {
        stockByDate[d] = (d === today && byDate[d] === undefined) ? r.todayStock : num(byDate[d]);
      }
      return {
        sku: r.sku,
        productName: r.productName,
        maxLevel: r.maxLevel,
        todayStock: r.todayStock,
        pct: r.pct,
        stockByDate,
      };
    });

    return {
      success: true,
      dates,
      skus,
      // Said plainly, because an empty chart for last week is a fact about the
      // data and not a fault the reader should go looking for.
      historyFrom: hist.length ? dates[0] : null,
      liveOnly: usedLiveFallback,
      note: hist.length ? null
        : `No stock history yet for ${from} to ${to}, so the figures below are today's live stock (${today}). History is recorded from each Vinculum sync and cannot be filled in backwards, so these dates will populate as the days pass.`,
      basis: {
        windowDays: spanDays, coverDays: COVER_DAYS,
        measuredTo: clock.anchor, staleDays: clock.staleDays,
        staleNote: clock.staleDays > 2
          ? `Orders were last synced ${clock.staleDays} days ago, so selling rates are measured to ${clock.anchor} rather than today.`
          : null,
      },
    };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── To be ordered ─────────────────────────────────────
async function getToBeOrderData() {
  try {
    const base = await skuBase();
    const orders = base
      .filter(r => r.toBeOrder > 0)
      .sort((a, b) => b.toBeOrder - a.toBeOrder)
      .map(r => ({
        sku: r.sku,
        productName: r.productName,
        leadTime: r.leadTime,
        safetyFactor: r.safetyFactor,
        todayStock: r.todayStock,
        toBeOrder: r.toBeOrder,
        maxLevel: r.maxLevel,
        avgDaily: r.avgDaily,
      }));
    return { success: true, orders, basis: { windowDays: AVG_WINDOW_DAYS, coverDays: COVER_DAYS } };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── Sales rank ────────────────────────────────────────
// One row per SKU with what it sold in the window, its sizes, and what it is
// short of. Sizes come from the SKU string, the same reading used on the Stock
// page, so a product's sizes group the same way in both places.
async function getSalesRankData(fromStr, toStr) {
  try {
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(String(fromStr || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(toStr || ''));
    // Without an explicit range this counted back from today while every other
    // part of the IMS counts back from the last order on file. With the sync 20
    // days behind that quietly dropped 65 SKUs and 642 units from this tab
    // alone, so Sales Rank and To Be Order meant different things by "the last
    // 45 days" while both called it that.
    const clock = ranged ? null : await dataClock();
    const where = ranged
      // An explicit range is taken literally, both ends included.
      ? 'o.order_date >= ? AND o.order_date < DATE_ADD(?, INTERVAL 1 DAY)'
      // The default is the window ending at the last order, matching skuBase.
      : `o.order_date > DATE_SUB(?, INTERVAL ${AVG_WINDOW_DAYS} DAY)
         AND o.order_date < DATE_ADD(?, INTERVAL 1 DAY)`;
    const args = ranged ? [fromStr, toStr] : [clock.anchor, clock.anchor];

    const sold = await db.rows(
      `SELECT it.sku,
              COALESCE(NULLIF(MAX(it.sku_name),''), it.sku) sku_name,
              SUM(it.order_qty) qty,
              ROUND(AVG(NULLIF(it.unit_price,0)), 2) avg_price,
              ROUND(SUM(it.order_qty * it.unit_price)) value
         FROM vin_order_items it
         JOIN vin_orders o ON o.order_id = it.order_id
        WHERE LOWER(it.status) <> 'cancelled' AND ${where}
        GROUP BY it.sku`, args);

    const base = new Map((await skuBase()).map(r => [r.sku, r]));
    const skuGroup = require('./skuGroup');

    // Group the sizes under the style they belong to, so a row can show which
    // sizes carried the sales rather than just a total.
    const sizesByStyle = new Map();
    for (const s of sold) {
      const style = skuGroup.styleKey(s.sku);
      if (!sizesByStyle.has(style)) sizesByStyle.set(style, []);
      // The size pills read `count`; `qty` is kept because other callers use it.
      const q = num(s.qty);
      sizesByStyle.get(style).push({ sku: s.sku, size: skuGroup.splitSize(s.sku).size || '-', count: q, qty: q });
    }

    const items = sold.map((s) => {
      const b = base.get(s.sku);
      return {
        sku: s.sku,
        productName: b ? b.productName : (s.sku_name || s.sku),
        totalSales: num(s.qty),
        sizes: (sizesByStyle.get(skuGroup.styleKey(s.sku)) || []).sort((a, b2) => b2.qty - a.qty),
        salePrice: num(s.avg_price),
        value: num(s.value),
        mrp: 0,
        cost: 0,
        todayStock: b ? b.todayStock : null,
        leadTime: '',
        safetyFactor: '',
        toBeOrder: b ? b.toBeOrder : 0,
        maxLevel: b ? b.maxLevel : 0,
      };
    });
    items.sort((a, b) => b.totalSales - a.totalSales);
    return { success: true, items };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── One product's sizes ───────────────────────────────
async function getSKUSalesData(masterSku, productName) {
  try {
    const skuGroup = require('./skuGroup');
    const style = skuGroup.styleKey(String(masterSku || ''));
    const base = await skuBase();
    const members = base.filter(r => skuGroup.styleKey(r.sku) === style);
    if (!members.length) {
      return { success: true, sizes: [], days: AVG_WINDOW_DAYS, productName: productName || masterSku, dateColFound: false };
    }
    const sizes = members.map(r => ({
      sku: r.sku,
      size: skuGroup.splitSize(r.sku).size || '-',
      sold: r.netSold,
      stock: r.todayStock,
      maxLevel: r.maxLevel,
      toBeOrder: r.toBeOrder,
      pct: r.pct,
    })).sort((a, b) => b.sold - a.sold);

    return {
      success: true,
      sizes,
      days: AVG_WINDOW_DAYS,
      productName: productName || members[0].productName,
      dateColFound: true,
    };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── Top products ──────────────────────────────────────
// Products, not SKUs: every size of one style on one line.
async function getTopProductsData(fromStr, toStr) {
  try {
    const rank = await getSalesRankData(fromStr, toStr);
    if (!rank.success) return rank;
    const skuGroup = require('./skuGroup');

    // The three top-product tabs read this shape closely: each product carries
    // its SKUs as objects, and each of those has to have its own order point.
    // Sending bare SKU strings left `sku.orderPoint` undefined, every comparison
    // came out NaN, and all three tabs reported nothing to order at all.
    //
    // Order point is what the screen itself defines it as — safety stock plus
    // average daily sale times lead time. There is no separate safety stock or
    // lead time in this data, so the cover period plays the part of the lead
    // time and safety stock is zero, which makes the order point exactly the
    // max level the rest of the IMS uses. One number, named twice.
    const base = new Map((await skuBase()).map(r => [r.sku, r]));

    const byStyle = new Map();
    for (const it of rank.items) {
      const key = skuGroup.styleKey(it.sku);
      if (!byStyle.has(key)) {
        byStyle.set(key, {
          sku: key,
          productName: skuGroup.cleanName(it.productName) || key,
          totalSales: 0, value: 0,
          totalStock: 0, totalMaxLevel: 0, totalOrderPoint: 0,
          totalAvgDailySales: 0, totalToBeOrder: 0,
          orderedDone: 0, orderedPending: 0,
          skus: [],
        });
      }
      const b = base.get(it.sku);
      const stock = b ? b.todayStock : num(it.todayStock);
      const maxLevel = b ? b.maxLevel : num(it.maxLevel);
      const avgDaily = b ? b.avgDaily : 0;
      const toBeOrder = Math.max(0, maxLevel - stock);

      const g = byStyle.get(key);
      g.totalSales += num(it.totalSales);
      g.value += num(it.value);
      g.totalStock += stock;
      g.totalMaxLevel += maxLevel;
      g.totalOrderPoint += maxLevel;
      g.totalAvgDailySales += avgDaily;
      g.totalToBeOrder += toBeOrder;
      g.skus.push({
        sku: it.sku,
        size: skuGroup.splitSize(it.sku).size || '-',
        todayStock: stock,
        safetyStock: 0,
        leadTime: COVER_DAYS,
        avgDailySales: avgDaily,
        orderPoint: maxLevel,
        maxLevel,
        toBeOrder,
        totalSales: num(it.totalSales),
      });
    }

    const products = [...byStyle.values()].map((g) => ({
      ...g,
      totalAvgDailySales: Math.round(g.totalAvgDailySales * 100) / 100,
      // Nothing here tracks a purchase order that has been placed but not
      // received, so the raw need and the adjusted need are the same number.
      rawTotalToBeOrder: g.totalToBeOrder,
      anyBelowOrderPoint: g.skus.some(s => s.orderPoint > 0 && s.todayStock < s.orderPoint),
      anyNearMaxAlert: g.skus.some(s => s.maxLevel > 0 && s.todayStock > s.maxLevel),
      skuCount: g.skus.length,
      // Kept under their old names for the parts of the screen that still read
      // a product-level stock or shortfall.
      todayStock: g.totalStock,
      maxLevel: g.totalMaxLevel,
      toBeOrder: g.totalToBeOrder,
      pct: g.totalMaxLevel > 0 ? Math.round(g.totalStock / g.totalMaxLevel * 100) : null,
    })).sort((a, b) => b.totalSales - a.totalSales);

    return { success: true, products, basis: { windowDays: AVG_WINDOW_DAYS, coverDays: COVER_DAYS } };
  } catch (e) { return { success: false, error: e.message }; }
}

module.exports = {
  skuBase,
  getDashboardData,
  getToBeOrderData,
  getSalesRankData,
  getSKUSalesData,
  getTopProductsData,
  AVG_WINDOW_DAYS,
  COVER_DAYS,
};
