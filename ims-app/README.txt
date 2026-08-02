BUNAI IMS — native, built into the Task Manager (admin-only)
==============================================================

The FULL IMS frontend is already here:  ims-app/index.html
(same logic as your Apps Script, improved CSS, reads the same Google Sheets
via a service account through /api/ims/*). You do NOT need to paste anything.

ONE-TIME SETUP ON HOSTINGER
---------------------------
1. Service account key — SIMPLEST: just drop the .json key file into the
   folder  bunai/secrets/  (e.g. secrets/credentials.json). The app
   auto-detects it — no environment variable needed.
   (Alternatives still work: GOOGLE_SERVICE_ACCOUNT_FILE = /path/to/key.json,
    or GOOGLE_SERVICE_ACCOUNT_JSON = full JSON. The file method is most reliable.)
   ⚠ Never put the key inside public/. Never share the key file.

2. Set BOTH spreadsheet IDs in .env — there are no built-in defaults:
       IMS_SS_ID=<your IMS spreadsheet id>
       SALES_SS_ID=<your Sales spreadsheet id>
   (ID = the part between /d/ and /edit in the sheet URL.)
   Then share BOTH spreadsheets with the service account email (Viewer is
   enough). Do NOT share with "Anyone" — only the service account email.

3. Keep your Apps Script DAILY 7AM TRIGGER running. It still crunches/writes
   the sheets; this app only READS them. (Your formulas stay untouched.)

4. Redeploy. Log in as admin → sidebar → "IMS".

VERIFY (cross-check)
--------------------
Open IMS and compare a few numbers vs your existing Apps Script dashboard
(Dashboard, To Be Order, Sales Rank, Top Products). They should match.
Logic was unit-tested offline (15/15 checks). If a 45-day-window edge differs,
tell us and we'll set IMS_TZ (default Asia/Kolkata) to align it.

OPTIONAL ENV
------------
IMS_SS_ID, SALES_SS_ID  — REQUIRED, no defaults (see step 2)
IMS_TZ                  — timezone for the day window (default Asia/Kolkata)
