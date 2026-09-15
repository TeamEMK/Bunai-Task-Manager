// ══════════════════════════════════════════════════════
// IMS — the handlers the Inventory screens call
//
// This file used to be 580 lines of Google Sheets reading. The IMS was backed
// by a spreadsheet somebody kept by hand: a column per day of stock, and a
// "max level" per SKU typed in by a planner. It broke the moment IMS_SS_ID was
// unset, and the same questions were already answerable from the orders,
// returns and stock that Vinculum syncs into MySQL every day.
//
// So the sheet is gone and the work lives in services/imsData.js. The screens
// did not change: they still call these names through the same bridge, and get
// the same shapes back.
//
// The one thing the sheet had that the database did not is stock on a past day.
// vin_inventory only ever holds the latest figure, so vin_inventory_daily now
// records one row per SKU per day on each sync. It cannot be filled in
// backwards — history starts from the first sync after this shipped.
// ══════════════════════════════════════════════════════
const imsData = require('./src/services/imsData');

const HANDLERS = {
  getDashboardData:   (...a) => imsData.getDashboardData(...a),
  getToBeOrderData:   (...a) => imsData.getToBeOrderData(...a),
  getSalesRankData:   (...a) => imsData.getSalesRankData(...a),
  getSKUSalesData:    (...a) => imsData.getSKUSalesData(...a),
  getTopProductsData: (...a) => imsData.getTopProductsData(...a),
};

module.exports = { HANDLERS };
