# Vinculum (Vin eRetail) — API integration notes

Working notes for the IMS module. Credentials never live in this file.

Everything below was established by probing the live tenant. Vinculum has not
sent documentation, so treat it as observed behaviour rather than spec.

## Account

| | |
|---|---|
| Tenant | `bunai.vineretail.com` |
| Real app server | `erp3.vineretail.com` — the UI's own AJAX goes here, so `bunai.` is likely an alias. Worth retrying the API against this host if the org id alone does not unblock it. |
| Version | 9.3.188 — quote this when asking for documentation |
| Location | Bunai Warehouse |
| API Owner | `Pooja` |
| API Key | in `.env` as `VIN_API_KEY` — works |
| Org Id | **unknown — this is the blocker** |
| Timezone | (GMT+5:30) Asia/Kolkata |
| Allowed IPs | blank (unrestricted) — set to the server IP before go-live |

API access was self-served from Admin → Api → Manage Api. No Vinculum support
ticket was needed to enable it.

## How a request has to be shaped

Three things about this API are not what you would guess, and each one cost a
round of probing:

**1. The version segment is per endpoint.** There is no single version that
serves everything. `/order/list` answers on `v2` and `v3`; everything else
answers on `v1`. Base URL therefore carries no version — `vinculum.js` adds it.

```
https://bunai.vineretail.com/RestWS/api/eretail  +  /{version}/{path}
```

**2. The content type is per endpoint, and mostly counter-intuitive.**
Almost every endpoint demands `application/x-www-form-urlencoded` and then
parses a JSON string out of the body. Sending the honest `application/json`
returns `415 Unsupported Media Type`. `sku/inventoryRealTime` is the lone
exception and does want real `application/json`.

**3. `OrgId` is an HTTP header, not a body field.** Putting it in the JSON
body has no effect at all. The header name was confirmed by the error changing:

| Request | Response |
|---|---|
| no `OrgId` header | `20 — OrgId is mandatory` |
| `OrgId: 1` header | `11 — Invalid API credentials` |

That shift proves the header is read; `1` is simply not this account's org id.

Full header set:

```
Content-Type: application/x-www-form-urlencoded   (or application/json — see above)
ApiKey:   <VIN_API_KEY>
ApiOwner: Pooja
OrgId:    <VIN_ORG_ID>
```

## Endpoints enabled

| Purpose | Version | Path | Content type |
|---|---|---|---|
| Inventory status | v1 | `sku/inventoryStatus` | form |
| SKU inventory | v1 | `sku/getInventory` | form |
| Inventory real time | v1 | `sku/inventoryRealTime` | **json** |
| Available inventory (warehouse) | v1 | `order/availableInventoryWH` | form |
| Stock detail | v1 | `stock/detail` | form |
| Order list | v2 | `order/list` | form |
| Order list V3 | v3 | `order/list` | form |
| Order status | v1 | `order/status` | form |
| Customer order | v1 | `order/customerOrder` | form |
| SKU master | v1 | `sku/getsku` | form |

All read-only. No write API was enabled — `Order Pull`, `Order Create`,
`Update Inventory` and similar were deliberately left out, since `Pull` in
Vin eRetail marks orders as processed rather than just reading them.

`stock/getWhInventory` is listed in the Manage Api panel but 404s on every
version tried, so the panel's URL column is a label rather than the literal
route for that one. Left out of `vinculum.js`.

## Response codes seen

| Code | Meaning |
|---|---|
| 9 | Generic error — usually a malformed filter |
| 11 | Invalid API credentials — OrgId does not match this key |
| 16 | API key needs Read-Write access — tick Access Rights in Manage Api |
| 20 | OrgId header not sent |
| 616 | SKU is mandatory |
| 807 | No filters found for fetching orders |
| 9189 | No data found for the given filters |
| 10221 | Stores are mandatory |

Note that errors come back as **HTTP 200** with the code in the body, so status
codes alone tell you nothing. `vinculum.js` surfaces `responseCode` as `code`.

## Live inventory — working

`v1/sku/inventoryRealTime` is in production use. It is the one endpoint that
never validates OrgId, so it runs on the API key alone.

Request — only these two fields; any extra field returns a bare "Generic Error":

```json
{ "sku": ["BUNA-0216-M", "VSKD2470-M"], "stores": ["BUN", "GUJ"] }
```

Response:

```json
{ "responseCode": 0, "responseMessage": "Success",
  "inventory": [ { "sku": "VSKD2470-M",
                   "stores": [ { "storeId": "BUN", "availableQty": 50.000 },
                               { "storeId": "GUJ", "availableQty": 40.000 } ] } ] }
```

Three limits found the hard way:

| Limit | Behaviour |
|---|---|
| **20 SKUs per call** | More returns code 10220 and no data |
| **Call quota — 40 hits** | The API Trace screen states it outright ("7/40"). Exceeding it returns code 13; a 1.2s gap between calls keeps the sync under it |
| **Out-of-stock SKUs are omitted** | Not returned as zero — absent entirely. A batch of only-empty SKUs answers 9189, not an empty success |

That last one is why `syncInventory()` zeroes any row it did not see this run.
Without it a sold-out SKU would keep showing its last known quantity, looking
fresh while being wrong.

First full run: 936 SKUs, 941 stock rows, 12,410 units in BUN and 200 in GUJ —
which reconciles with the Inventory dashboard's 12,642 saleable.

## What runs

| | |
|---|---|
| `vin_skus` | SKU list, seeded from an Inventory View export |
| `vin_inventory` | one row per (sku, warehouse) with quantity |
| `vin_sync_log` | one row per run — start, end, rows, error |
| `vin_stock_alerts` | one row per (sku, warehouse) with an open low-stock task |

Daily at 06:00 IST (`VIN_SYNC_HOUR`) on a normal server; on Vercel the same job
runs from `vercel.json` crons hitting `/api/cron/vinculum-sync`. Admins can also
run it from the Stock page.

Low-stock tasks are **opt-in**: without `VIN_LOW_STOCK_ASSIGN_TO` the sync still
runs but raises nothing, because there would be nobody to give the work to.

`vin_stock_alerts` is what stops the same SKU raising a task every morning for
weeks. A second task is only raised after the SKU climbs back above the
threshold and falls under it again — a genuinely new event rather than the same
one restated. `VIN_LOW_STOCK_MAX` (default 25) caps a single run, so a threshold
set too high drip-feeds instead of dumping hundreds of tasks at once. Worth
knowing: at a threshold of 3 this catalogue has ~156 low SKUs, so the first
week's runs will be at the cap.

## Blocked on

1. **`VIN_ORG_ID`** — the only thing standing between here and live data.

   The page source exposes the tenant's text keys, and none of them are it:

   | Tried | Source | Result |
   |---|---|---|
   | `BUNA` | `orgKey` hidden input | code 11 |
   | `BUNAI` | tenant subdomain | code 11 |

   So OrgId is an internal id, not the org key. Guessing stops here — iterating
   values against a live tenant is credential enumeration.

   **The application's own org id is `BUNA`, and the API rejects it.** Vin
   eRetail's dashboard passes `parentOrgId=BUNA&locations=BUN,GUJ&orgId=BUNA`
   in its internal calls, so that is unambiguously this tenant's org id. Sent
   to the API as an `OrgId` header — alone, with `parentOrgId`, with
   `locations`, in the body, in both — every combination still answers
   responseCode 11.

   **No value is ever accepted, which is the real finding.** The header is the
   only place `OrgId` is read — sending it as a form field or query parameter
   still answers code 20. And in the header, every value tried (`BUNA`, `buna`,
   `BUN`, `BUN_BUNA`) answers code 11, never anything else:

   | Sent | Response |
   |---|---|
   | no header | `20 — OrgId is mandatory` |
   | header, any value | `11 — Invalid API credentials` |

   A validator that rejects the product's own org id identically to obvious
   nonsense is not checking the value — it is failing to find a key-to-org
   pairing at all. So this is almost certainly a provisioning gap: the API key
   was created but never linked to the organisation. The correct numeric id,
   if one exists, would fail the same way.

   That reframes the ask for Vinculum: not "what is our OrgId" but "please link
   API key (owner: Pooja) on bunai.vineretail.com to our organisation".

   Everywhere else has been ruled out: the Admin and Master menus, page source,
   the dashboard's AJAX calls, the API key export (`ApiOwner` and `ApiKey`
   only), the Location Enquiry export, and the API Trace screen — which prints
   a call's entire request and response body and still carries no org id.

   Inventory does not wait on this — see above. What is still blocked is
   **orders** (`order/list`, `order/status`) and the **SKU master**
   (`sku/getsku`), which is why the SKU list is seeded from a CSV export.
2. **`get Order ListV3` access rights** — shows `No` in the Manage Api table,
   and `v3/order/list` returns code 16 accordingly. Tick it and re-save.

## Once unblocked

3. Work out the request payloads endpoint by endpoint — `node test-vinculum.js`
   prints what each one is asking for. Partial progress already:
   `sku/inventoryRealTime` wants `{"sku":[…],"stores":[…]}`, and `order/list`
   wants filters whose names are not yet known.
4. Then the MySQL tables and the scheduled sync. Not written yet, on purpose —
   no endpoint has returned a success payload, so the field names are unknown
   and any schema now would be invented.
