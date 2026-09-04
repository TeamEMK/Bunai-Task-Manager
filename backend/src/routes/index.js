// ══════════════════════════════════════════════════════
// ROUTE TABLE
// One mount point per feature. The ORDER of the two commented pairs below is
// load-bearing; everything else is independent.
// ══════════════════════════════════════════════════════
const express = require('express');
const ims = require('./ims.routes');

const api = express.Router();

// Auth first: /api/login and /api/me are what everything else depends on.
api.use(require('./auth.routes'));
api.use(require('./dashboard.routes'));
api.use(require('./tasks.routes').router);
api.use(require('./approvals.routes'));
api.use(require('./transfers.routes'));
api.use(require('./mis.routes'));
api.use(require('./fms.routes'));
api.use(require('./sheetForms.routes'));
api.use(require('./users.routes'));
api.use(require('./hr.routes'));
api.use(require('./comments.routes'));
api.use(require('./compliance.routes'));
api.use(require('./dailyTasks.routes'));
api.use(require('./clients.routes'));
api.use(require('./leaves.routes'));
api.use(require('./holidays.routes'));
api.use(require('./stock.routes'));
api.use(require('./sales.routes'));
api.use(require('./returns.routes'));
api.use(require('./reminders.routes'));
api.use(require('./weekPlan.routes'));
api.use(require('./pms.routes'));
api.use(ims.apiRouter);

module.exports = { api, pages: ims.pageRouter };
