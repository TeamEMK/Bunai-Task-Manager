# Vin eRetail API Access — Requirement Document

**To:** Vinculum Solutions — Support / Account Management
**From:** [CLIENT COMPANY NAME]
**Prepared by:** [YOUR COMPANY NAME] (technology partner)
**Date:** [DATE]
**Vin eRetail account / tenant:** [TENANT NAME OR LOGIN URL]
**Client contact:** [NAME, DESIGNATION, EMAIL, PHONE]
**Technical contact:** [NAME, EMAIL, PHONE]

---

## 1. Background

[CLIENT COMPANY NAME] uses Vin eRetail as the system of record for inventory
and sales. We are building an internal task-management and reporting
application for their team.

Today the team reads stock and order information inside Vin eRetail and then
re-enters or re-checks the same information manually in their day-to-day
workflow. We want to remove that duplicate effort by pulling the data
automatically into the internal application.

To do that we need **read-only API access** to the client's Vin eRetail
account. This document lists exactly what we need and why.

---

## 2. What we are requesting

**Read-only REST API access** to the client's Vin eRetail tenant, covering
inventory, sales orders and item master.

We are **not** requesting write access. We will not create, modify, cancel or
delete any record in Vin eRetail. If write access is bundled by default with
the API user, please restrict the user to read-only permissions.

---

## 3. Data we need

| # | Data | Why we need it | Frequency |
|---|------|----------------|-----------|
| 1 | **Inventory / stock enquiry** — SKU, warehouse/location, available qty, blocked qty, last updated | Low-stock alerts and reorder tasks | Hourly or daily |
| 2 | **Sales orders** — order no., order date, channel/marketplace, customer city/state, SKU, qty, value, current status, last modified date | Pending-dispatch tracking, SLA breach alerts, sales reporting | Hourly or daily |
| 3 | **Item master** — SKU code, item name, category, brand, UOM, MRP | To label SKUs correctly in reports | Weekly, or on change |

If the exact endpoint names differ in the client's Vin eRetail version, please
share the equivalent endpoints for the above.

**Optional, if available:** purchase orders / inbound GRN, and returns (RTO /
customer returns). Not required for phase one, but useful to know whether they
can be enabled later without a fresh approval cycle.

---

## 4. Credentials and configuration required

Please provide the following. Credentials should be sent to the client contact
named above through a secure channel, not in plain email body.

| # | Item | Notes |
|---|------|-------|
| 1 | **API base URL** | The tenant-specific REST endpoint host for this account |
| 2 | **ApiKey** | Request header |
| 3 | **ApiOwner** | Request header |
| 4 | **API user ID and password**, if the account also uses a login/token step | Please confirm whether a token call is required before each session, and the token validity period |
| 5 | **Org / company code** | As used in request payloads |
| 6 | **Warehouse / location codes** | Full list of active codes for this account |
| 7 | **Channel / marketplace codes** | Needed to segment sales by channel |
| 8 | **API documentation** | The PDF or portal link matching the client's Vin eRetail version, with sample request and response payloads |

---

## 5. Technical questions

Please confirm the following so we can size the integration correctly.

1. **IP whitelisting** — Is API access restricted by source IP? If yes, please
   confirm the process and turnaround time; we will share our server's static
   IP address.
2. **Rate limits** — Maximum requests per minute / hour, and the response we
   should expect when a limit is hit.
3. **Pagination** — Page size limits per endpoint, and the maximum date range
   allowed in a single request.
4. **Incremental sync** — Do the sales order and inventory endpoints support a
   "modified since" / last-updated filter? This lets us pull only what changed
   instead of re-reading everything.
5. **Historical data** — How far back can we query? We would like to load the
   last [12] months once, then keep it updated incrementally.
6. **Sandbox / UAT environment** — Is a test tenant available so we can build
   and test without touching live data? If yes, please provide separate
   credentials for it.
7. **Order status values** — The complete list of order status codes used in
   this account, and their meaning.
8. **Timezone** — The timezone of date and timestamp fields in API responses.
9. **Webhooks / push** — Does Vin eRetail support pushing order status updates
   to a callback URL? If yes, we would prefer that over polling for order
   status.
10. **Commercials** — Is there any one-time or recurring charge for API
    enablement on this account? If yes, please share a written quote.

---

## 6. Alternative, if API access cannot be enabled

If REST API access cannot be enabled on this account, we can work with
**scheduled report exports** instead:

- Vin eRetail schedules the inventory and sales reports as CSV
- Delivered daily to an SFTP location or an email address we provide
- We pick up the files and load them automatically

This is a workable fallback and needs no IP whitelisting. Please confirm
whether this option is available on the client's plan, along with the report
formats and the scheduling frequencies supported.

---

## 7. Security commitments

- Access will be **read-only**; no data will be written back to Vin eRetail.
- Credentials will be stored as encrypted environment variables on the
  application server, never in source code or in any shared document.
- Data will be pulled to a private database accessible only to the client's
  authorised users, over HTTPS.
- Access is limited to inventory, sales and item master. We are not requesting
  customer contact details, payment information or any other personal data
  beyond the shipping city and state needed for regional sales reporting.
- Credentials can be revoked by the client at any time; we will confirm in
  writing when a credential is rotated or retired.

---

## 8. What happens after access is granted

| Stage | Work | Indicative time |
|-------|------|-----------------|
| 1 | Review API documentation, test connectivity in sandbox | [2–3 days] |
| 2 | Build the sync for inventory and sales orders | [1–2 weeks] |
| 3 | One-time historical load, then scheduled incremental sync | [2–3 days] |
| 4 | Alert rules — low stock, pending dispatch, SLA breach | [1 week] |
| 5 | Client review and sign-off | [as scheduled] |

Timelines start from the date working credentials and documentation are
received, and assume a sandbox environment is available.

---

## 9. Requested action

1. Enable read-only REST API access on the client's Vin eRetail account.
2. Share the credentials and configuration listed in **Section 4**.
3. Answer the questions in **Section 5**.
4. Confirm the fallback in **Section 6** if the API cannot be enabled.

Please confirm expected turnaround time. We are happy to join a short call
with your technical team if that is faster than email.

**Client authorisation:** [CLIENT CONTACT NAME] confirms that
[YOUR COMPANY NAME] is authorised to receive and use these API credentials on
[CLIENT COMPANY NAME]'s behalf for the purpose described above.

---

*Prepared by [YOUR COMPANY NAME] · [YOUR EMAIL] · [YOUR PHONE]*
