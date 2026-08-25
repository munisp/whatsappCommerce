# Embedded AP-as-a-feature API (W33)

Partner platforms embed accounts-payable (and receivables) features into their
own product via a small API-key HTTP surface: `/api/embedded/v1/*`. Every
endpoint is a **thin pass-through to the existing W31 services**
(`vendorBills`, `scheduledPayments`, `arInvoices`, `approvals`) — no money
logic is re-implemented, all amounts are **integer cents**, and all status
vocabulary is inherited unchanged from the underlying services.

## Enabling (fail-closed)

| Env var | Default | Meaning |
|---|---|---|
| `EMBEDDED_API_ENABLED` | `false` | **OFF by default.** Unless exactly `"true"`, the entire surface returns `404`. Enabling exposes tenant AP/AR data to API-key holders — enable only when clients are provisioned. |
| `EMBEDDED_API_RATE_LIMIT_PER_MIN` | `120` | Per-client requests/minute. Redis-backed fail-closed limiter: in production a limiter outage returns `503`, never silently unlimited. |

## Provisioning clients (admin tRPC)

Clients are created by platform admins via the `embedded` router
(`adminProcedure`):

- `embedded.createClient({ partnerName, tenantId, scopes })` → returns the
  **one-time plaintext API key**. Only its SHA-256 digest is stored
  (`embedded_clients.api_key_hash`); the plaintext is unrecoverable —
  rotate instead of asking for it again.
- `embedded.suspendClient({ clientId })` → key immediately fails with `401`.
- `embedded.rotateKey({ clientId })` → old key invalid immediately; returns
  the new one-time plaintext key.
- `embedded.listClients({ tenantId? })` → clients without any key digests.

Each client is bound to **exactly one tenant** (per-merchant clients). The
tenant context of every request is derived from that binding — tenant ids in
request params/headers are **ignored**.

## Authentication

Send the API key on every request, either header works:

```
X-API-Key: emb_...
Authorization: Bearer emb_...
```

The server SHA-256-hashes the presented key and timing-safe-compares it with
the stored digest. Errors:

| Status | Meaning |
|---|---|
| `401 missing-api-key` | no key presented |
| `401 invalid-api-key` | unknown key |
| `401 client-suspended` | client suspended |
| `403 scope-required` | key valid, scope missing (`scope` field names it) |
| `404` | surface disabled, or resource not in the client's tenant |
| `429 rate-limited` | per-client limit tripped (`Retry-After` header) |
| `503 rate-limiter-unavailable` | limiter outage, fail-closed (prod) |

## Scopes

`bills:read` `bills:write` `payments:read` `payments:write` `invoices:read` `invoices:write`

## Endpoints

### Bills (vendor bills AP inbox)

```
GET  /api/embedded/v1/bills?status=pending          (bills:read)
POST /api/embedded/v1/bills                         (bills:write)
GET  /api/embedded/v1/bills/:id                     (bills:read)
POST /api/embedded/v1/bills/:id/pay                 (payments:write)
```

`POST /bills` body: `{ vendorName, amountCents, currency?, billNumber?, description?, vendorContact?, issueDate?, dueDate? }` → `201 { bill, reviewRequired, ocrConfidence }`.

`POST /bills/:id/pay` body: `{ amountCents?, paymentRef? }` (defaults: full
remaining amount; deterministic `vbill:<billId>` idempotency ref). Returns the
underlying service result verbatim — including the **approval gate**: if a
tenant approval policy covers `vendor_bill_payment` and the amount crosses
the threshold, the response is honestly
`{ status: "pending_approval", approvalRequired: true, approvalId, chargedCents: 0 }`
and **no money moves** until an owner approves in-app
(`approvals.approve`), after which the same payment executes exactly once.
Embedded callers can **never** bypass the gate.

### Scheduled payments

```
POST /api/embedded/v1/payments/schedule             (payments:write)
GET  /api/embedded/v1/payments/:id                  (payments:read)
```

Body: `{ kind: "vendor_bill"|"payout"|"adhoc", amountCents, executeAt, currency?, targetId?, recipient?, idempotencyKey? }`.
Idempotent on `idempotencyKey` (`duplicate: true` on replay). Execution is
the existing claim-before-send cron engine (`sched:<id>` ledger refs).

### AR invoices

```
GET  /api/embedded/v1/invoices?status=sent          (invoices:read)
POST /api/embedded/v1/invoices                      (invoices:write)
```

Body: `{ amountCents, customerName?, customerPhone?, customerEmail?, description?, currency?, dueDate? }` → `201 { invoice }`
(tenant-scoped `invoiceNo` sequence, status starts `draft`).

## Auditing

Every mutation writes an audit row with `actorId = embedded:<clientId>`,
`actorRole = embedded`, actions `embedded.bill.create`, `embedded.bill.pay`,
`embedded.payment.schedule`, `embedded.invoice.create`. Vendor-bill events
carry the same actor. `embedded_clients.last_used_at` is touched
best-effort per authenticated request.

## Example

```bash
# one-time at provisioning (admin tRPC): apiKey = emb_...
curl -X POST $HOST/api/embedded/v1/bills \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"vendorName":"Seam Supplies","amountCents":50000,"dueDate":"2026-09-01"}'
# → 201 {"bill":{"id":"...","status":"pending",...}}

curl -X POST $HOST/api/embedded/v1/bills/<id>/pay -H "X-API-Key: $KEY" -d '{}'
# → {"ok":true,"status":"paid","paymentRef":"vbill:<id>",...}
# or, above the tenant approval threshold:
# → {"ok":true,"status":"pending_approval","approvalRequired":true,"approvalId":"..."}
```
