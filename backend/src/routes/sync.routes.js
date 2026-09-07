// ══════════════════════════════════════════════════════
// SYNC — trigger the GitHub Actions "Vinculum sync" workflow from the app
// (admin only). Vercel functions freeze on response, so the long stock/orders/
// returns pull can't run in-process here — instead we ask GitHub to run the
// workflow (which already has workflow_dispatch enabled). The pages then watch
// their own sync log for the fresh run and reload.
//
// Needs a GitHub token with Actions: write on the repo, as GH_SYNC_TOKEN.
// GH_REPO / GH_WORKFLOW / GH_SYNC_REF override the defaults if ever needed.
// ══════════════════════════════════════════════════════
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

const ghToken = () => process.env.GH_SYNC_TOKEN || '';
const GH_REPO = process.env.GH_REPO || 'TeamEMK/Bunai-Task-Manager';
const GH_WORKFLOW = process.env.GH_WORKFLOW || 'vinculum-stock-sync.yml';
const GH_REF = process.env.GH_SYNC_REF || 'main';

// Is the button usable? (token present on this server)
router.get('/sync/config', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json({ configured: Boolean(ghToken()), repo: GH_REPO, workflow: GH_WORKFLOW });
}));

// Kick off the workflow. GitHub answers 204 on success — no run object yet.
router.post('/sync/run', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const token = ghToken();
  if (!token) throw httpError(400, 'Auto-sync is not set up on the server yet (GH_SYNC_TOKEN missing). Add a GitHub token in the hosting env, then redeploy.');

  const url = `https://api.github.com/repos/${GH_REPO}/actions/workflows/${encodeURIComponent(GH_WORKFLOW)}/dispatches`;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bunai-sync',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: GH_REF }),
    });
  } catch (e) {
    throw httpError(502, 'Could not reach GitHub to start the sync — ' + (e.message || 'network error'));
  }

  if (r.status === 204) return res.json({ ok: true });

  const text = await r.text().catch(() => '');
  let msg = `GitHub API ${r.status}`;
  try { const j = JSON.parse(text); if (j.message) msg = j.message; } catch (_) {}
  if (r.status === 401 || r.status === 403) throw httpError(400, `GitHub rejected the token (${msg}). It needs Actions: write on the repo.`);
  if (r.status === 404) throw httpError(400, `Workflow not found (${msg}). Check the repo/workflow name and that the token can see it.`);
  throw httpError(502, `Could not start the sync — ${msg}`);
}));

module.exports = router;
