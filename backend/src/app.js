// ══════════════════════════════════════════════════════
// EXPRESS APP
// Assembly only: middleware, the /api gate, the route table, the pages, the
// error handler. No business logic lives here.
// ══════════════════════════════════════════════════════
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const { migrationsReady } = require('./db/migrations');
const { compressedStatic, sendAsset } = require('./middleware/staticAssets');
const { errorHandler, notFound } = require('./middleware/errors');
const routes = require('./routes');

const app = express();

app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static assets: compressed + content-hash ETag for text, express.static for
// images and anything else.
// A short max-age only: logos and icons DO get replaced, and a week-long cache
// would leave the old one on people's screens with no way to force a refresh.
app.use(compressedStatic(config.publicDir));
app.use(express.static(config.publicDir, { etag: true, maxAge: '1h' }));

// ── MIGRATION GATE ────────────────────────────────────
// Every /api request waits for in-flight schema migrations. On a serverless
// cold start the migration promise may still be running when requests arrive,
// and a query against a column that does not exist yet fails outright. On a
// warm instance the promise is already resolved → near-zero overhead.
app.use('/api', async (req, res, next) => {
  try { await migrationsReady; }
  catch (e) { /* migration failures are logged where they happen — keep serving */ }
  next();
});

app.use('/api', routes.api);
// An unknown /api path is an API error, so it answers in JSON. Without this it
// fell through to Express's default handler and a fetch() got an HTML page.
app.use('/api', notFound);
app.use(routes.pages);          // /ims — an HTML page, not an API

// ── PAGES ─────────────────────────────────────────────
// Both are served through sendAsset so the 500KB app shell is compressed and
// revalidated by ETag rather than re-downloaded on every navigation.
// /app is deliberately NOT behind requireAuth: the page checks the session
// itself via /api/me, and gating it server-side broke the load whenever the
// cookie had a timing or domain hiccup.
const page = (file) => (req, res, next) => {
  if (!sendAsset(req, res, path.join(config.publicDir, file))) next();
};
app.get('/', page('index.html'));
app.get('/app', page('app.html'));

app.use(errorHandler);

module.exports = app;
