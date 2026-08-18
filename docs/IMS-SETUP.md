# IMS — Inventory Management (admin only)

The full IMS frontend already ships with the app at
`frontend/ims-app/index.html`. It is the same logic as the original Apps Script
with improved CSS, and it reads the same Google Sheets through a service account
via `/api/ims/*`. Nothing has to be pasted in.

> This file used to sit at `frontend/ims-app/README.txt`, which the static
> middleware served publicly at `/ims-app/README.txt` — setup notes, secret
> paths and env-var names readable by anyone. It lives in `docs/` now.

## One-time setup

**1. Service-account key.** Simplest: drop the `.json` key file into `secrets/`
at the repo root (e.g. `secrets/credentials.json`). The app finds it on its own —
no environment variable needed.

Alternatives, all still supported:
- `GOOGLE_SERVICE_ACCOUNT_FILE` = absolute path to the key file
- `GOOGLE_SERVICE_ACCOUNT_JSON` = the full JSON, one line
- `GOOGLE_CREDENTIALS` = the same JSON (this is the one the rest of the app uses,
  so setting it configures both the Sheets features and IMS)

On Vercel a file cannot be committed, so use `GOOGLE_CREDENTIALS` as an
environment variable there.

⚠️ Never put the key inside `frontend/` — everything in that folder is served to
the browser. Never share the key file.

**2. Both spreadsheet IDs go in `.env`** — there are no built-in defaults:

```
IMS_SS_ID=<your IMS spreadsheet id>
SALES_SS_ID=<your Sales spreadsheet id>
```

The ID is the part between `/d/` and `/edit` in the sheet URL.

Then share **both** spreadsheets with the service-account email (Viewer is
enough). Do not share with "Anyone" — only that email.

**3. Keep the Apps Script daily 7 AM trigger running.** It still crunches and
writes the sheets; this app only reads them, so the formulas stay untouched.

**4. Redeploy**, then log in as admin → sidebar → **IMS**.

## Verify

Open IMS and compare a few numbers against the existing Apps Script dashboard
(Dashboard, To Be Order, Sales Rank, Top Products). They should match. The logic
was unit-tested offline (15/15 checks). If a 45-day-window edge differs, set
`IMS_TZ` (default `Asia/Kolkata`) to align it.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `IMS_SS_ID` | yes | — |
| `SALES_SS_ID` | yes | — |
| `IMS_TZ` | no | `Asia/Kolkata` |
