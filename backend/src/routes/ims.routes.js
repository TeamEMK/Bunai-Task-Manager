// ══════════════════════════════════════════════════════
// IMS (Inventory Management System) — admin only.
// Reads the same Google Sheets the Apps Script wrote, via a service account,
// and serves that project's unmodified index.html with a small shim so its
// existing google.script.run.* calls land on /api/ims/* instead.
// ══════════════════════════════════════════════════════
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { requireAuth, requirePage } = require('../middleware/auth');
const ims = require('../../ims');
const { withChannel } = require('../services/imsData');

const apiRouter = express.Router();
const pageRouter = express.Router();

// Dispatches to a ported read function and returns the SAME shape the Apps
// Script returned, so the frontend works unchanged. Errors come back as
// { __imsError } which the shim routes to the page's failure handler.
apiRouter.post('/ims/:fn', requireAuth, requirePage('ims'), async (req, res) => {
  try {
    const fn = ims.HANDLERS[req.params.fn];
    if (typeof fn !== 'function') return res.json({ __imsError: 'Unknown IMS function: ' + req.params.fn });
    const args = Array.isArray(req.body) ? req.body : [];
    // The channel dropdown on the page: Myntra, Shopify, or both (blank).
    const channel = String(req.get('X-IMS-Channel') || '').toLowerCase();
    // And the sales window: '' (45 days), '30' or 'mtd'.
    const window = String(req.get('X-IMS-Window') || '').toLowerCase();
    res.json(await withChannel(channel, () => fn(...args), window));
  } catch (e) {
    console.error('  ❌ /api/ims/' + req.params.fn + ':', e.message);
    res.json({ __imsError: e.message });
  }
});

const SHIM = `<script>(function(){function runner(ok,fail){return new Proxy({},{get:function(_,prop){if(prop==='withSuccessHandler')return function(fn){return runner(fn,fail);};if(prop==='withFailureHandler')return function(fn){return runner(ok,fn);};if(prop==='withUserObject')return function(){return runner(ok,fail);};return function(){var args=Array.prototype.slice.call(arguments);fetch('/api/ims/'+prop,{method:'POST',headers:{'Content-Type':'application/json','X-IMS-Channel':(window.__imsChannel||''),'X-IMS-Window':(window.__imsWindow||'')},credentials:'include',body:JSON.stringify(args)}).then(function(r){return r.json();}).then(function(d){if(d&&d.__imsError){if(fail)fail({message:d.__imsError});}else{if(ok)ok(d);}}).catch(function(err){if(fail)fail({message:(err&&err.message)||'Network error'});});};}});}window.google=window.google||{};window.google.script=window.google.script||{};window.google.script.run=runner(null,null);window.google.script.host=window.google.script.host||{close:function(){},setHeight:function(){},setWidth:function(){},origin:''};})();</script>`;

const NOT_INSTALLED_HTML =
  '<div style="font-family:system-ui,sans-serif;padding:48px;max-width:640px;margin:0 auto;color:#0f172a;">'
  + '<h2>📦 IMS — almost ready</h2>'
  + '<p style="color:#475569;line-height:1.6">Place your Apps Script <b>index.html</b> at '
  + '<code style="background:#f1f5f9;padding:1px 6px;border-radius:5px">frontend/ims-app/index.html</code> in the project, '
  + 'set the <code style="background:#f1f5f9;padding:1px 6px;border-radius:5px">GOOGLE_SERVICE_ACCOUNT_JSON</code> env var, '
  + 'share the sheets with the service account email, then redeploy.</p></div>';

// The 144KB page was re-read from disk and re-patched on every request; it is
// now built once and rebuilt only when the file itself changes.
let cached = null;   // { mtimeMs, html }

function buildPage() {
  const file = path.join(config.imsAppDir, 'index.html');
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.html;

  let html = fs.readFileSync(file, 'utf8');
  html = html.includes('</head>') ? html.replace('</head>', SHIM + '</head>') : (SHIM + html);
  cached = { mtimeMs: stat.mtimeMs, html };
  return html;
}

pageRouter.get('/ims', requireAuth, requirePage('ims'), (req, res) => {
  const html = buildPage();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html || NOT_INSTALLED_HTML);
});

module.exports = { apiRouter, pageRouter };
