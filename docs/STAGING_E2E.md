# Staging E2E Harness (real credentials)

`scripts/staging-e2e.ts` is a smoke suite that exercises the **deployed**
staging instance and the real third-party sandboxes (Meta Graph, Paystack
test, Odoo/Twenty/Medusa staging). It is **not** part of the vitest suite —
run it explicitly:

```bash
npx tsx scripts/staging-e2e.ts
```

It prints a PASS/FAIL/SKIP matrix and exits non-zero on any FAIL. Any
integration whose environment variables are unset is **SKIPPED with a
message, never failed**, so partial credential sets still give signal.

## 1. Topology

```
┌────────────────────┐   HTTPS    ┌──────────────────────────────┐
│ scripts/staging-e2e│ ─────────► │ staging whatsappCommerce      │
│  (your machine/CI) │            │  - GET /health/ready          │
│                    │ ─────────► │  - /api/trpc/notifications.*  │
└───────┬────────────┘            │  - /api/webhooks/whatsapp ◄───┼── Meta webhook delivery
        │                         └──────────────┬───────────────┘
        │ Graph /messages                        │ tRPC poll (admin)
        ▼                                         ▼
   Meta Graph API (test WABA)            merchant_notifications
        │
        │ initialize / verify
        ▼
   Paystack test API  ── (manual test-card step) ──► /api/webhooks/paystack
```

## 2. Required environment matrix

| Variable | Required for | Notes |
|---|---|---|
| `STAGING_BASE_URL` | health, Meta round-trip | e.g. `https://staging.example.com` — script refuses to run without it |
| `META_TEST_PHONE_NUMBER_ID` | meta.credentials, meta.send | Test WABA phone-number id |
| `META_TEST_ACCESS_TOKEN` | meta.credentials, meta.send, meta.waba | Permanent test token |
| `META_TEST_WABA_ID` | meta.waba | Optional WABA reachability check |
| `META_TEST_RECIPIENT` | meta.send, meta.roundtrip | The **test number** registered in the Meta app (see §3) |
| `STAGING_TENANT_ID` | meta.roundtrip | The staging tenant wired to the test WABA |
| `STAGING_ADMIN_TOKEN` | meta.roundtrip | Bearer token for an admin user (tRPC `notifications.adminList`) |
| `PAYSTACK_TEST_SECRET_KEY` | paystack.init, paystack.verify | `sk_test_…` |
| `PAYSTACK_TEST_EMAIL` | paystack.init | Optional; defaults to `staging-e2e@example.com` |
| `ODOO_URL` | integration.odoo | JSON-RPC base URL |
| `TWENTY_URL`, `TWENTY_API_KEY` | integration.twenty | GraphQL API key |
| `MEDUSA_URL`, `MEDUSA_API_KEY` | integration.medusa | Admin API token |
| `STAGING_POLL_TIMEOUT_MS` | meta.roundtrip | Default `90000` |

## 3. Meta test-number setup

1. In the Meta app dashboard → WhatsApp → API Setup, note the **test phone
   number id** (`META_TEST_PHONE_NUMBER_ID`) and generate a permanent token
   (`META_TEST_ACCESS_TOKEN`).
2. Under "To", add the recipient test number and verify it by OTP — this is
   `META_TEST_RECIPIENT` (E.164 without `+`, e.g. `2348012345678`).
3. Point the app's webhook at `STAGING_BASE_URL/api/webhooks/whatsapp` with
   the staging verify token; subscribe to `messages`.
4. On staging, create/configure the staging tenant (`STAGING_TENANT_ID`)
   with the same phone-number id + token so inbound messages resolve to it.
5. The script sends a marker text from the test WABA to the recipient and
   polls `notifications.adminList` (as `STAGING_ADMIN_TOKEN`) for the marker.
   Polls every 5 s up to `STAGING_POLL_TIMEOUT_MS`.

## 4. Paystack test-card steps

The script only **initializes** a ₦100 (`10000` kobo) test charge and
**verifies the reference is pending** — it never auto-completes a payment.

Manual follow-up when you want the full webhook path exercised:

1. Open the `authorization_url` from the `paystack.init` step output
   (or re-initialize via the dashboard).
2. Pay with the Paystack test card `4084 0840 8408 4081`, any future expiry,
   any CVV, PIN `0000`, OTP `123456`.
3. Paystack delivers `charge.success` to
   `STAGING_BASE_URL/api/webhooks/paystack` — confirm the order/intent
   transitions to paid and (for B2B repayment references) that the credit
   ledger was debited exactly once.

## 5. Interpreting results

- **FAIL health.ready** — instance down or a hard dependency (db/redis/
  keycloak/tigerbeetle/odoo outbox) is not ready; the failing component is
  named in the detail.
- **FAIL meta.credentials** — token expired/revoked or wrong phone-number id.
- **FAIL meta.send / meta.roundtrip** — send rejection (recipient not a
  verified test number) or the webhook pipeline didn't surface the message
  (check webhook subscription, tenant mapping, and staging logs for
  `[integrations-webhook]` / captured errors via `infra.systemRecentErrors`).
- **FAIL paystack.init** — wrong/ revoked test secret key.
- **FAIL paystack.verify** — reference unexpectedly `success` (someone
  completed it) or verify API error.
- **FAIL integration.\*** — staging integration URL/credentials wrong, or the
  service is down.

Exit code: `0` = everything ran PASS or SKIP; `1` = at least one FAIL;
`2` = misconfiguration (`STAGING_BASE_URL` unset).

## 6. What this does NOT cover

- **Load / throughput** — single-shot requests only; use the k6/artillery
  suites for load.
- **Failover / chaos** — no dependency kill tests; readiness flapping under
  failure is covered by unit tests, not this script.
- **Real money movement** — Paystack is test-mode only; the charge is never
  auto-completed.
- **UI / client journeys** — API-level smoke only.
- **Multi-tenant isolation** — a single staging tenant is probed.
