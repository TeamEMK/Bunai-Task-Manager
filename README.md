# Bunai Task Manager

Checklist + Delegation web app with role-based access (Admin / HOD / PC / User),
daily task reports, leave tracker, holidays, weekly planning, and an optional
Google-Sheets FMS module.

> Note: All email and WhatsApp automation has been **removed** from this build.
> The app sends no external notifications.

---

## 🧰 Tech Stack

- **Node.js + Express** (`backend/`)
- **MySQL** (works with Hostinger's MySQL / phpMyAdmin)
- Plain HTML/CSS/JS frontend in `frontend/` (served by the same Express app)
- Tables are created **automatically** on first run.

---

## 📁 Project Structure

```
bunai/
├── backend/                   # Everything that runs on the server
│   ├── server.js              # Entry point: listen (local) or export (Vercel)
│   ├── src/
│   │   ├── app.js             # Express assembly — middleware, routes, errors
│   │   ├── config/            # EVERY environment variable, read in one place
│   │   ├── db/
│   │   │   ├── pool.js        # MySQL pool: retry, socket fallback, error typing
│   │   │   ├── schema.js      # Tables, columns and indexes as data
│   │   │   └── migrations.js  # Applies only what the database is missing
│   │   ├── middleware/        # auth, errors, compressed static delivery
│   │   ├── services/          # google, whatsapp, holidays, passwords, scheduler…
│   │   ├── routes/            # One module per feature area (20 of them)
│   │   └── utils/             # dates, collections, scores, spreadsheet cells
│   ├── ims.js                 # IMS sheet readers
│   ├── vinculum.js            # Vin eRetail API client
│   ├── vinculum-sync.js       # Stock sync job + its own tables
│   └── scripts/               # Standalone diagnostics, never imported by the app
│       ├── test-db.js         # Prove the DB credentials work
│       └── test-vinculum.js   # Probe the Vin eRetail API
│
├── frontend/                  # Everything the browser downloads
│   ├── index.html             # Login page
│   ├── app.html               # Main app — markup only
│   ├── assets/app.css         # Styles
│   ├── assets/app.js          # Behaviour
│   ├── ims-app/index.html     # Embedded IMS page
│   ├── manifest.json
│   └── bunai-logo.png         # Brand logo
│
├── data/                      # Exports and seeds (gitignored except its README)
│   └── vin-skus.csv           # SKU list the Vinculum stock sync reads
│
├── docs/                      # Everything that is prose, not code
│   ├── DEPLOY.md              # Vercel + Railway walkthrough
│   ├── IMS-SETUP.md
│   └── VINCULUM-API-*.md
│
├── package.json               # start → node backend/server.js
├── vercel.json
├── .env                       # Your secrets (fill this in — never commit)
├── .env.example               # Template
└── credentials.json.example   # Template — copy to credentials.json (gitignored)
```

Four top-level folders, four jobs: `backend/` is code that runs on the server,
`frontend/` is what the browser downloads, `data/` is neither, `docs/` is prose.
`backend/` never imports from the others — it only *serves* `frontend/`
(`config.publicDir`) and *reads* `data/` when you run a seed. `.env` and
`credentials.json` stay at the root because both halves of the deployment read
them.

Anything inside `frontend/` is public. Nothing that explains the setup, and
certainly no key, belongs there.

Text assets are served brotli/gzip-compressed with a content-hash `ETag`, so a
repeat visit re-downloads nothing that has not changed.

---

## 🚀 Deploy on Hostinger (Node.js + phpMyAdmin)

### Step 1 — Create the MySQL database (phpMyAdmin)

1. hPanel → **Databases → MySQL Databases**.
2. Create a new database, e.g. `bunai_task_manager`, and a database user.
3. Give that user **all privileges** on the database.
4. Note down: **DB host, DB name, DB user, DB password, port** (usually `3306`).

> You don't need to create any tables manually. The server creates all of them
> on first start.

### Step 2 — Upload the project

1. hPanel → **Website → Node.js** (or "Setup Node.js App") and create an app.
   - **Application root**: the folder where you'll upload these files.
   - **Application startup file**: `backend/server.js`
     ⚠️ If you are upgrading an existing app, change this — it used to be `server.js`.
   - **Node version**: 18 or higher.
2. Upload all project files (via File Manager or Git). Do **not** upload
   `node_modules` — it will be installed on the server.

### Step 3 — Fill in `.env`

Edit `.env` with the database details from Step 1:

```
DB_HOST=localhost          # or the host Hostinger shows for your DB
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=bunai_task_manager
DB_PORT=3306
DB_SSL=false

NODE_ENV=production
PORT=3000                  # Hostinger usually sets/forwards this for you
SESSION_SECRET=<long random string — one is pre-filled, keep it private>
APP_URL=https://your-domain.com
```

> `DB_HOST` is usually `localhost` when the database and app are on the same
> Hostinger server. If Hostinger gives you a separate DB hostname, use that.

### Step 4 — Install & start

In the Node.js app panel:

1. Click **Run NPM Install** (installs dependencies).
2. Click **Start / Restart** the application.

On first start the server will:
- Connect to MySQL
- Create all tables automatically
- Seed a default admin account — the address and password are printed to the
  server console on that first start

### Step 5 — Login

Open your domain and sign in with the seeded admin shown in the server console
on first start. Change that password immediately (Profile → Change Password).

> ⚠️ Change the default password immediately: **Profile → Change Password**.
> Then add your real users from the **Users** section.

---

## 💻 Local Development

```bash
npm install
# copy .env.example to .env and fill in your local MySQL details
npm run dev       # auto-restart (nodemon)
# or
npm start
```

Open `http://localhost:3000`.

Expected console output:
```
✅ MySQL Connected Successfully!
✅ DB migrations checked
🌱 Default admin seeded → <address printed here>
✦ Bunai Task Manager: http://localhost:3000
```

---

## 🗄️ Database Tables (auto-created)

On first start these tables are created automatically:

`users`, `clients`, `delegation_tasks`, `checklist_tasks`, `task_approvals`,
`task_comments`, `task_transfers`, `whatsapp_reminder_log`, `fms_sheets`,
`fms_steps`, `fms_step_doers`, `fms_extra_rows`, `week_plans`, `holidays`,
`leave_requests`, `meetings`, `meeting_attendees`, `daily_tasks`.

The stock tables (`vin_skus`, `vin_inventory`, `vin_sync_log`) are created by
the Vinculum sync the first time it runs.

`src/db/schema.js` is the single description of all of it — tables, the columns
added later, and every index. On boot, `src/db/migrations.js` asks the database
what it already has and issues only the missing DDL.

To start completely fresh, drop and recreate the database in phpMyAdmin:

```sql
DROP DATABASE IF EXISTS bunai_task_manager;
CREATE DATABASE bunai_task_manager
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Then restart the app — tables rebuild and the admin re-seeds.

---

## 📊 Optional: Google Sheets (FMS) feature

The FMS module syncs steps from a Google Sheet. It is **optional** and disabled
until you add credentials.

To enable:
1. Create a Google Cloud **service account** and download its `credentials.json`.
2. Either drop that file in as `credentials.json` / `secrets/credentials.json`
   (see `credentials.json.example` for the shape — the real file is gitignored),
   or paste its contents as a single line into `GOOGLE_CREDENTIALS` in `.env`.
3. Share your Google Sheet with the service-account email (read access).
4. Fill the sheet IDs in `.env` (`IMS_SS_ID`, `MERCH_FMS_SHEET_ID`, etc.) —
   they no longer have any hardcoded defaults.

If left blank, the rest of the app works normally — only the FMS sync is off.

---

## 🔧 Troubleshooting

**"MySQL Connection Failed"**
- Check `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` in `.env`.
- Confirm the DB user has privileges on the database.
- If app and DB are on the same Hostinger server, `DB_HOST=localhost` is correct.

**"Not authenticated" after login**
- Make sure `NODE_ENV=production` and you're on HTTPS, so the session cookie is sent.

**"too many connections"**
- Lower `DB_POOL_SIZE` in `.env` if your plan has a small limit (default 2 per instance).

**Logo / static files not loading**
- Confirm the `frontend/` folder uploaded correctly and `bunai-logo.png` exists.

