# Deploying Bunai Task Manager — Vercel + Railway

App on **Vercel** (serverless), MySQL on **Railway**.

> This is not a static frontend plus a separate API. `server.js` is one Express
> app that serves both the HTML in `public/` and every `/api/*` route, so the
> whole thing deploys to Vercel as a single serverless function.

---

## 1 — MySQL on Railway

1. [railway.app](https://railway.app) → **New Project** → **Provision MySQL**.
2. Open the MySQL service → **Variables** tab. You need the *public* connection
   values (Railway also shows internal ones, which only work between Railway
   services — Vercel cannot reach those):

   | Railway variable | Goes into |
   |---|---|
   | `MYSQLHOST` (public, `*.proxy.rlwy.net`) | `DB_HOST` |
   | `MYSQLPORT` (public, a 5-digit port) | `DB_PORT` |
   | `MYSQLUSER` | `DB_USER` |
   | `MYSQLPASSWORD` | `DB_PASSWORD` |
   | `MYSQLDATABASE` | `DB_NAME` |

3. Under **Settings → Networking**, make sure a **public TCP proxy** exists.
   Without it Vercel gets `ETIMEDOUT`.

You do **not** need to create any tables. The app creates them on first boot.

---

## 2 — Push the code to GitHub

The project is not a git repo yet:

```bash
cd n:\bunai
git init
git add .
git commit -m "Bunai Task Manager"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `credentials.json` and `secrets/`, so no
secret is committed. Confirm before pushing:

```bash
git status --porcelain | findstr /I ".env credentials secrets"
```

Nothing should print.

---

## 3 — Deploy on Vercel

1. [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
2. Framework preset: **Other**. Leave build/output settings empty —
   `vercel.json` already routes every request to `server.js`.
3. **Environment Variables** — add these before the first deploy:

```
DB_HOST         <Railway public host>
DB_PORT         <Railway public port>
DB_USER         <Railway user>
DB_PASSWORD     <Railway password>
DB_NAME         <Railway database>
DB_SSL          false
DB_POOL_SIZE    2

NODE_ENV        production
SESSION_SECRET  <fresh 48-byte hex, see below>
APP_URL         https://<your-app>.vercel.app

CRON_SECRET     <fresh 24-byte hex, see below>
```

Generate the two secrets — do not reuse the local ones:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # CRON_SECRET
```

4. **Deploy.**

### Optional env vars

Only add these when you actually use the feature:

```
GOOGLE_CREDENTIALS   whole service-account JSON on ONE line
IMS_SS_ID            SALES_SS_ID
MERCH_FMS_SHEET_ID   MERCH_FMS_GID
MERCH_FMS_22GODAM_SHEET_ID   MERCH_FMS_22GODAM_GID
PROCESS_FMS_SHEET_ID PROCESS_FMS_GID
PO_DRIVE_FOLDER_ID
AUMFIG_API_KEY       AUMFIG_API_URL
```

`credentials.json` is gitignored and `.vercelignore`d, so on Vercel the Google
service account **must** come from `GOOGLE_CREDENTIALS`.

---

## 4 — First login

Open `https://<your-app>.vercel.app`. On first boot the server creates every
table and seeds an admin:

```
aman@test.com / password
```

Change that password immediately (Profile → Change Password), then add real
users and delete the seeded one.

---

## Serverless limits you need to know

A Vercel function only lives for the duration of one request. Three things in
this app are affected.

### 1. The daily 10 AM reminder — already handled

`setInterval` cannot survive between invocations, so on Vercel the scheduler
disables itself and **Vercel Cron** drives it instead. `vercel.json` already
contains:

```json
"crons": [{ "path": "/api/cron/checklist-reminder", "schedule": "30 4 * * *" }]
```

`04:30 UTC = 10:00 IST`. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`,
which the endpoint checks. The existing DB lock (`UNIQUE (log_date, kind)`)
still prevents a double send.

> Vercel's Hobby plan allows **one cron job per project, daily granularity
> only**. That is exactly what this needs. Test it by hand any time:
> `curl "https://<app>.vercel.app/api/cron/checklist-reminder?key=<CRON_SECRET>"`

### 2. The WhatsApp queue will NOT work on Vercel — unresolved

Messages are queued with a random **4-5 minute gap** between them, and the
queue drains *after* the HTTP response is sent. On a normal server that is
fine. On Vercel the function is frozen the moment it responds, so only the
first message goes out and the rest are silently dropped.

Options:

- **Leave WhatsApp off** — keep `AUMFIG_API_KEY` blank and everything else works
  normally. This is the simplest choice.
- **Run the app on Railway instead of Vercel.** Railway containers run
  continuously, so both the queue and the original `setInterval` work untouched.
  Same repo, no code change.
- **Rework the queue** into a cron-drained job (one message per cron tick), which
  needs a paid Vercel plan for sub-daily cron.

### 3. Upload size cap

Vercel limits a serverless request body to **4.5 MB**; `multer` here allows
20 MB. PO document uploads above 4.5 MB will fail on Vercel with a 413.

---

## Troubleshooting

**`ETIMEDOUT` / `ECONNREFUSED` on boot**
Using Railway's internal host. Switch to the public `*.proxy.rlwy.net` host and
its 5-digit port.

**`ER_ACCESS_DENIED_ERROR`**
Wrong `DB_PASSWORD`, or the env var was edited without redeploying. Vercel only
picks up env changes on a new deployment.

**`Too many connections`**
Keep `DB_POOL_SIZE=2`. Each cold start opens its own pool, and Railway's
starter MySQL allows few connections.

**Login works, then "Not authenticated"**
`NODE_ENV` must be `production` so the auth cookie is sent with `secure: true`
over HTTPS.

**Google Sheets features error out**
`GOOGLE_CREDENTIALS` missing or not valid one-line JSON, the sheet IDs are
blank, or the sheets are not shared with the service-account email.
