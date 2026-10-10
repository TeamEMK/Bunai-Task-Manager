# Daily sync on Railway

The daily data sync (SKU master, stock, orders, returns) runs as a **Railway cron
service**. One command, `node backend/scripts/daily-sync.js`, does all four and
exits.

## Why Railway and not GitHub Actions

The GitHub workflow was written because the old Vin eRetail stock sync took six
minutes and could not finish inside a Vercel function. Two things have changed:

- Unicommerce takes **9 seconds** for SKUs and stock, against 361 seconds on
  Vinculum, because it accepts 10,000 SKUs per call instead of 20.
- Railway already hosts the database, so the sync runs next to it with no
  function timeout to design around.

The workflow is still there, and it does work — the secrets were added at some
point, and the app's "Sync now" button dispatches it successfully. It stays as
the manual, on-demand path. What it must **not** get is a `schedule:` block of
its own: two schedules pulling the same window would double the API calls and
leave it unclear which one filled a table. The recurring run belongs here.

## One-time setup

1. In the Railway project, **New → GitHub Repo** → this repository. Call the
   service something like `bunai-sync`.
2. Service **Settings → Deploy**, set three things by hand:

   | Field | Value |
   |---|---|
   | Start Command | `node backend/scripts/daily-sync.js` |
   | Cron Schedule | `30 1,4,7,10,13,16,19,22 * * *` |
   | Restart Policy | **Never** |

   Restart Policy is the one that bites. It defaults to *On Failure* with ten
   retries, and this script exits 1 when a step fails — so one bad run would
   fire the sync ten times over, each one hitting the API again. *Never* means
   a run happens once and the next one is at the next scheduled slot.

   **Not Config-as-code.** Railway deprecated it on 2026-08-28: existing files
   keep working until 2026-12-01, but a service that never used it cannot opt
   in, which includes any service created now. `railway.cron.json` is kept in
   the repo as a record of the intended settings, and for Railway's newer
   Infrastructure-as-Code if that is ever adopted — but the dashboard fields
   above are what actually takes effect today.
3. Service **Variables** — the sync needs these and nothing else:

   ```
   DB_HOST  DB_PORT  DB_USER  DB_PASSWORD  DB_NAME  DB_SSL
   UNI_TENANT  UNI_USERNAME  UNI_PASSWORD
   VIN_BASE_URL  VIN_ORDER_API_KEY  VIN_ORDER_API_OWNER
   ```

   The `VIN_*` three are only for returns, which are still read from Vin
   eRetail. Everything else is Unicommerce.

   If the database is in the same Railway project, reference it instead of
   copying values: `${{ Postgres.DB_HOST }}` style variable references keep the
   two in step. Otherwise use the **public** host (`*.proxy.rlwy.net`).
4. **Deploy**, then hit **Run now** once to confirm it works before trusting the
   schedule.

## The schedule

`30 1,4,7,10,13,16,19,22 * * *` — Railway reads cron in **UTC**, and the half
hour lines up with India's offset, so these land on the hour in IST: **07:00,
10:00, 13:00, 16:00, 19:00, 22:00, 01:00 and 04:00**.

It used to be `30 1 * * *`, a single 07:00 IST run. That left the Sales page
showing the morning's snapshot for the rest of the day — orders placed at noon
did not appear until the next morning, which reads as a broken page rather than
a sync window. Eight runs put the longest stale stretch at three hours.

Running more often is cheap because every run pulls the same **10-day window by
UPDATED date** (`SYNC_ORDER_DAYS`), not just the new rows. Nothing is lost if a
run is skipped — the next one covers it — and a run takes well under a minute,
so no two overlap.

Raising it further is a question for Unicommerce's API limits, not for this
script. Hourly would be 24 pulls of the same window each day.

## What a run looks like

A healthy run takes about 45 seconds and ends with exit code 0:

```
✅ SKU master — 5883 SKUs (5.9s)
✅ Stock — 2879 rows, 2 facility (3.1s)
✅ Orders — 129 orders (34.0s)
✅ Returns (Unicommerce) — 0 returns (0.4s)
✅ Returns (Vin eRetail) — 0 returns (0.0s)

── 43.5s mein khatam ──
Sab theek.
```

Returns reading zero is expected for now, not a fault: the cutover was
1 October and Unicommerce had not produced a single return by the 5th. Returns
always lag orders. The step runs anyway so the first one is caught the night it
appears, instead of ageing out of the window unnoticed. Vin eRetail returns are
synced alongside, because the older ones are still closing — statuses change and
refunds land after the order side has gone quiet.

**A failing step does not stop the others.** Orders being unavailable is no
reason for stock to go stale too. Each step runs on its own and the summary at
the end names every one, so a half-finished run cannot report itself as fine.
The process exits 1 if any step failed, which is what Railway shows as a failed
run.

## Tuning

| Variable | Default | What it does |
|---|---|---|
| `SYNC_ORDER_DAYS` | 10 | How far back to refresh orders |
| `SYNC_RETURN_DAYS` | 10 | Same for returns |

Orders refresh by **UPDATED**, not CREATED: an order placed last week and
dispatched today would never reappear in a CREATED window and would keep its
stale status for ever.

A longer window is also how you backfill — `--days 90` as a one-off from **Run
now**, or locally:

```
node backend/scripts/daily-sync.js --days 90
```

Be aware that orders cost one API call each (Uniware's search returns headers
only), so a 90-day backfill is minutes, not seconds.

## What this does not replace

`vercel.json` still schedules `/api/cron/checklist-reminder`. That one is a
WhatsApp reminder, not a data sync, and it stays where it is.

The GitHub workflow is left in the repository. It does the same work, so if
Railway is ever the thing that breaks, adding the repository secrets brings it
back as a fallback.
