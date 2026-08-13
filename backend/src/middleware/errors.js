// ══════════════════════════════════════════════════════
// ERROR HANDLING
// Every route was wrapped in its own try/catch that ended in
// `res.status(500).json({ error: err.message })`. That is now one function, so
// the failure path is identical everywhere — and a database outage stops
// leaking "Access denied for user 'x'@'host'" into the browser.
// ══════════════════════════════════════════════════════
const { isDbConnError, DB_DOWN_MESSAGE } = require('../db/pool');

// Wraps an async handler so a rejected promise reaches the error handler
// instead of hanging the request (Express 4 does not await handlers).
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (isDbConnError(err)) {
    console.error(`  ❌ ${req.method} ${req.originalUrl} — DB connection error:`, err.message);
    return res.status(503).json({ error: DB_DOWN_MESSAGE });
  }

  // Google API errors carry their own status and a message worth showing.
  if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share this sheet/folder with the service account.' });
  if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });

  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`  ❌ ${req.method} ${req.originalUrl}:`, err.stack || err.message);
  res.status(status).json({ error: err.message || 'Something went wrong. Please try again.' });
}

// Throwable HTTP error, so a handler can `throw httpError(404, 'Task not found')`
// instead of returning a response from three nesting levels down.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { asyncRoute, errorHandler, notFound, httpError };
