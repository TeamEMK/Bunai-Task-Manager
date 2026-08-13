// ══════════════════════════════════════════════════════
// STATIC DELIVERY — compression + content-hash revalidation.
//
// frontend/app.html alone is half a megabyte and was shipped uncompressed on
// every single page load. This middleware reads each text asset once, keeps the
// bytes plus a SHA-256 ETag in memory, and answers with:
//   • 304 Not Modified when the browser already holds that exact hash, or
//   • a brotli/gzip body when it does not.
// The hash is of the file's CONTENT, so a redeploy that changes nothing keeps
// every client's cache valid, and one that changes a byte invalidates it
// immediately — no version query strings to remember to bump.
// ══════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Anything smaller than this is not worth a compression pass — the header
// overhead cancels the saving.
const MIN_COMPRESS_BYTES = 1024;

// absPath → { mtimeMs, size, etag, type, raw, gzip, br }
const cache = new Map();

function load(absPath, stat) {
  const raw = fs.readFileSync(absPath);
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    etag: '"' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32) + '"',
    type: TYPES[path.extname(absPath).toLowerCase()] || 'application/octet-stream',
    raw,
    gzip: null,   // compressed lazily, on the first request that can use it
    br: null,
  };
}

// Returns the cache entry for a file, re-reading it when it changed on disk.
function entryFor(absPath) {
  let stat;
  try { stat = fs.statSync(absPath); } catch (_) { return null; }
  if (!stat.isFile()) return null;
  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const fresh = load(absPath, stat);
  cache.set(absPath, fresh);
  return fresh;
}

// Quality 5 rather than brotli's maximum: the result is within a few percent of
// quality 11 and costs milliseconds instead of seconds — which matters because
// a serverless instance pays this on its first request.
const BROTLI_OPTS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 0,
  },
};

function bodyFor(entry, acceptEncoding) {
  const ae = acceptEncoding || '';
  if (entry.raw.length >= MIN_COMPRESS_BYTES) {
    if (/\bbr\b/.test(ae)) {
      if (!entry.br) entry.br = zlib.brotliCompressSync(entry.raw, BROTLI_OPTS);
      return { buf: entry.br, encoding: 'br' };
    }
    if (/\bgzip\b/.test(ae)) {
      if (!entry.gzip) entry.gzip = zlib.gzipSync(entry.raw, { level: 6 });
      return { buf: entry.gzip, encoding: 'gzip' };
    }
  }
  return { buf: entry.raw, encoding: null };
}

// HTML must be revalidated (it is the app shell); the extracted CSS/JS are
// content-addressed by ETag, so they can be revalidated too — a 304 is ~200
// bytes either way, and it removes any chance of a stale bundle.
const cacheControlFor = (absPath) =>
  path.extname(absPath).toLowerCase() === '.html'
    ? 'no-cache'
    : 'public, max-age=0, must-revalidate';

// Sends a file with ETag/compression. Returns false when the file is missing,
// so the caller can fall through to its own 404.
function sendAsset(req, res, absPath) {
  const entry = entryFor(absPath);
  if (!entry) return false;

  res.setHeader('Content-Type', entry.type);
  res.setHeader('ETag', entry.etag);
  res.setHeader('Cache-Control', cacheControlFor(absPath));
  res.setHeader('Vary', 'Accept-Encoding');

  // If-None-Match may carry a list, and proxies sometimes weaken the tag.
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some(t => t.trim().replace(/^W\//, '') === entry.etag)) {
    res.status(304).end();
    return true;
  }

  const { buf, encoding } = bodyFor(entry, req.headers['accept-encoding']);
  if (encoding) res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', buf.length);
  if (req.method === 'HEAD') { res.status(200).end(); return true; }
  res.status(200).end(buf);
  return true;
}

// Express middleware over a directory. Only handles the text types above;
// images and everything else fall through to express.static.
function compressedStatic(rootDir) {
  const root = path.resolve(rootDir);
  return function compressedStaticMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let rel;
    try { rel = decodeURIComponent(req.path); } catch (_) { return next(); }
    if (rel.endsWith('/')) rel += 'index.html';

    const abs = path.resolve(path.join(root, rel));
    // Path traversal guard: the resolved file must stay inside the root.
    if (abs !== root && !abs.startsWith(root + path.sep)) return next();
    if (!TYPES[path.extname(abs).toLowerCase()]) return next();

    if (!sendAsset(req, res, abs)) return next();
  };
}

module.exports = { compressedStatic, sendAsset };
