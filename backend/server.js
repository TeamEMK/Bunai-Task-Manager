// ══════════════════════════════════════════════════════
// Bunai Task Manager — entry point
//
// The application itself lives in src/:
//   src/config      every environment variable, read once
//   src/db          pool, schema description, migrations
//   src/middleware  auth, errors, static delivery
//   src/services    Google Sheets, WhatsApp, holidays, hashing, schedulers
//   src/routes      one module per feature area
//   src/app.js      Express assembly
//
// This file only decides HOW the app is served: Vercel hands us the HTTP
// layer, so there we export it; anywhere else we listen ourselves.
// ══════════════════════════════════════════════════════
const config = require('./src/config');
const app = require('./src/app');
const google = require('./src/services/google');
const { startSchedulers } = require('./src/services/scheduler');

// Warms the Google auth token so the first sheet-backed request does not pay
// for the exchange. Failure is logged and ignored — Sheets is optional.
google.prewarm();

// Daily jobs. On a serverless runtime this is a no-op and vercel.json's crons
// call /api/cron/* instead.
startSchedulers();

if (!config.isServerless) {
  app.listen(config.port, () => {
    console.log(`\n  ✦ Bunai Task Manager: http://localhost:${config.port}\n`);
  });
}

module.exports = app;
