# data/

Data files — not code, not secrets.

Everything here is **gitignored except this README**: these files are either
regenerable (an export you can pull again) or customer data that has no business
sitting in a public repo. The folder itself is committed so the path always
exists and nothing has to `mkdir` at runtime.

## What lives here

| File | What it is | Where it comes from |
|---|---|---|
| `vin-skus.csv` | The SKU list the stock sync asks Vinculum about | Vin eRetail → WMS → Inventory → Inventory View → Search → **Export** |

### Why `vin-skus.csv` has to exist

Vinculum's live-inventory endpoint will not enumerate. It answers *"here is the
stock for the SKUs you named"* and nothing else, so something has to hold the
list of SKUs to ask about. The SKU-master API would supply it, but that endpoint
is still blocked on `VIN_ORG_ID`.

Consequence, stated plainly: a SKU created in Vin eRetail after the last seed is
invisible to the Stock page until someone re-seeds.

Load it with:

```bash
node backend/vinculum-sync.js seed data/vin-skus.csv
```

## What does NOT go here

- **Secrets** — `.env`, `credentials.json`, service-account keys. Those stay at
  the repo root / `secrets/`, and are ignored separately.
- **Anything the app writes at runtime.** Nothing in the app writes to this
  folder; uploads are streamed to Google Drive, never to disk (the deployment
  targets have read-only or ephemeral filesystems).
