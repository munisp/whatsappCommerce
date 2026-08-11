# WhatsApp Feature Simulation

An end-to-end harness that exercises **every WhatsApp feature** of this repo
against the **real webhook handlers and services**, with only the external
edges (Meta Cloud API, LLM, Whisper, Paystack/Flutterwave, Keycloak) mocked.

## Run it

```bash
npm install --legacy-peer-deps --ignore-scripts
npm run simulate                 # all 46 journeys
npx tsx simulation/runner.ts j03 j18   # subset by id
npm test                         # vitest: unit tests + simulation wrapper
```

Exit code is 0 only when every journey passes. A matrix is printed at the end.

## How it works

| File | Role |
| --- | --- |
| `simulation/metaMock.ts` | Global `fetch` interceptor. Every outbound call is recorded in `outbound[]` (inspectable via `lastOfType` / `findByBody` / `toPhone` / `ofType`). Serves Graph API messages/media/templates/quality/catalog-items, the scripted LLM (`LLM_BASE_URL`), Whisper (`OPENAI_BASE_URL`) and Paystack/Flutterwave. The mock tenant has **full credentials**, so the real HTTP path in `waSender.ts` executes. Failure injection via `failNextSends()`. |
| `simulation/payloads.ts` | Meta webhook payload factory (exact `entry/changes/value` envelopes, deterministic `wamid`s). |
| `simulation/world.ts` | Boots a seeded tenant world: PGlite (embedded Postgres) exposed over a TCP socket so the **unmodified** `server/db.ts` connects via `DATABASE_URL`; all migrations applied; the real Express server booted; helper drivers `text/buttonReply/listReply/location/image/audio/reaction/status/runCron/ussd`, `settle`/`waitFor` for the async webhook pipeline, `backdate` for time travel, `patchTenantSettings`, `resetJourneyState` (clears mock state **and** restores seed stock between journeys). |
| `simulation/journeys/` | One file per journey (J01–J30), each with hard assertions on **both** outbound mock calls (payload content) **and** state changes (DB rows). |
| `simulation/runner.ts` | Sequential runner + matrix output. Also used by `simulation.test.ts` (vitest wrapper) so CI runs the suite. |

The server processes webhooks asynchronously after ack, so journeys use
`world.settle()` (outbound-quiescence) or `world.waitFor(predicate)` rather
than fixed sleeps.

## Journey coverage

Consent (en/fr), interactive + numeric menus, NLP order → cart → confirm →
pickup/delivery → payment link, delivery zones + native location, promos,
payment confirm → receipt + reservations, receipt-screenshot verification
(±₦100, manual review), order action cards (track/pay/cancel + phone spoof
guard), shipments + delivery PIN + reactions, PII-scrubbed tracking tokens,
smart reorder (repriced), abandoned-cart recovery (1×/24h, consent-gated),
FAQ without LLM, voice notes (transcribe → pipeline, fail-soft), sticky
multilingual, visual search, stock guard (concurrent last-unit race, OOS,
waitlist), restock notify, broadcasts (consent/window/dryRun/quality block),
template sync/create/picker, CTWA keywords, window-expiry nudges (dedupe,
template fallback), delivery-status callbacks + retry/dead-letter cron,
read receipts, webhook dedupe, disputes → admin alert, USSD (CON/END),
Meta catalog upsert/delete, contact provisioning.

Wave 8 (J31–J38) adds a second tenant to the world — "Lagos Plastics
Manufacturing" (supplier_profile, wholesale products + price tier, own
phone-number id/admin phone) plus a ₦500,000 net-14 trade-credit account
with the buyer tenant — and covers: procurement menu browse (supplier
directory + wholesale catalog with MOQ/min-qty), PO build → submit →
supplier approval card, approve → credit draw → invoiced + ledger,
over-limit refusal → buyer fallback, pay-now PO → Paystack link → webhook
settle (replay-safe), partial credit repayment (dedupe-claimed), dunning
milestones (idempotent reminders, 2% late fee once), and the +7d default
freeze (new draws refused).

The fetch mock also serves the **ledger-bridge** service
(`payment.initiate`'s 2-phase reserve), so PO payment links run the real
initiation path.

Wave 9 (J39–J44) drives the **agentic onboarding copilot** end-to-end. The
world sets `ONBOARDING_PHONE_NUMBER_ID`/`ONBOARDING_WA_TOKEN`, so a
prospect's texts hit the real `waOnboarding` webhook branch (platform intake
number) and the REAL copilot module — the harness LLM mock answers the
copilot's tool-registry requests with deterministic `tool_calls`
(extractIntake / proposeWaMenu / proposeUseCases / proposeBranding /
proposeIntegrations / revision re-drafts). The Graph mock additionally
serves `whatsapp_business_profile` updates, the resumable-upload flow and
`GET /{id}` phone-number/WABA lookups (with failure injection) so live
validation (`runTenantValidation`) executes. Covered: full WhatsApp
onboarding (intake → proposals → onb_approve → tenant live), the
edit/re-draft path, checkpoint enforcement, the validation-repair loop
(incl. the 3-round failure cap), webhook-redelivery idempotency + resume +
restart, and the admin-channel (portal) session.

Wave 10 (J45–J46) proves the hardening wave. The world sets a deterministic
`SECRETS_MASTER_KEY` (base64 32 bytes) so the real AES-256-GCM envelope path
runs. J45 drives secrets at rest end-to-end: `tenant.updateWhatsAppConfig`
stores `settings.whatsapp.accessToken` as a `v1:` envelope with no plaintext;
a real send then puts the DECRYPTED token on the wire (the fetch mock records
the raw bearer token in a test-only side channel — recorded headers stay
redacted); a hand-written legacy plaintext row still sends as-is
(`decryptSecret` passthrough) and is re-encrypted on the next write; the
integrations path (`setConfig` → `resolveIntegrationConfig`) round-trips the
Odoo apiKey the same way. J46 drives observability: the real
`/api/scheduled/integration-outbox-dispatch` cron fails an Odoo delivery
non-retriably (400 → 'failed', 'error' capture) then retriably (502 × 5 →
DLQ 'dead', 'critical' capture) — asserted via both the structured stdout
JSON line and the `infra.systemRecentErrors` admin procedure; planted
token-ish `extra` keys are redacted; `ERROR_WEBHOOK_URL` fire-and-forget POSTs
reach a scripted mock endpoint sanitized, and a webhook-sink outage is
swallowed without disturbing the outbox sweep. Fault injection uses the new
`meta.hostStatus` per-hostname status scripting in the fetch mock.

Wave 11 (J47–J52) proves the **universal provider framework** end-to-end. The
fetch mock gains scripted hosts for `api.stripe.com` (Checkout Sessions),
`api.monnify.com` (auth + init-transaction) and a generic custom-gateway mock
(`registerCustomGatewayHost`, e.g. the fictional `api.afripay.example`), plus
`pay.hostStatus` per-host failure injection for fallback testing; journeys
drive the REAL unified route `POST /api/webhooks/payments/:provider` with
per-provider signing helpers (flutterwave verif-hash, stripe `t/v1`
HMAC-SHA256, monnify HMAC-SHA512, custom configurable HMAC). Covered:
multi-provider tenants side-by-side with creds/config isolation (J47),
manual/bank-transfer instructions + receipt-upload confirm (J48), zero-code
declarative customHttp gateway incl. tamper rejection (J49), fallback under
failure + all-fail exhaustion (J50), credit repayment served by flutterwave
with replay dedupe (J51), and unified-webhook isolation across adapters and
unknown slugs (J52).

Wave 12 (J53–J60) ADVERSARIALLY tests the W12 merges (authz fixes,
tenancy/memberships/sessions, KYB gates) end-to-end in the multi-tenant
world. The world's auth mock doubles as a scripted **Keycloak realm** (OIDC
discovery + authorization-code token endpoint, per-code claims scripting,
every token POST recorded in `world.keycloak.tokenCalls`) so the REAL
`keycloak.exchangeCode` HTTP path executes; `resetJourneyState` gains W12
isolation (SSO profiles, KYB applications/documents, memberships, session
revocations, marketplace sellers, BI rows, Temporal runs, ad-hoc
tenants/credit accounts, `TEMPORAL_ADDRESS`/`KYC_GATE_DISABLED` env, and the
sdk revocation/membership caches). Covered: cross-tenant SSO session forgery
+ first-bind + bound-sub replay (J53), invite-mint by non-admins +
magic-link tenant scope + tampered tokens (J54), a four-router IDOR sweep
with a zero-rows-mutated DB diff (J55), rival-seller suspension abuse
(J56), KYB-gated go-live incl. the Temporal onboarding-workflow record
(J57), dual-side KYB gating of trade-credit approval + a real draw (J58),
supplier-profile activation gating + directory `kybVerified` trust flag
(J59), and the tenancy cross-cut — membership fallback in
`assertTenantAccess`, operatorProcedure role gating, 12h session TTL, logout
jti revocation, admin revoke-all, tenantType backfill to 'hybrid', and the
last-owner guard (J60).

## Prod bugs found by this suite (fixed surgically)

1. **`server/services/useCases.ts`** — the numeric menu selector hijacked
   "1"/"2" replies during NLP checkout (`awaitingFulfillment` /
   `awaitingAddress`), causing an infinite re-ask loop. Menu selection is
   now skipped while an NLP checkout step is pending.
2. **`server/services/sessionWindow.ts`** — window-expiry nudges silently
   skipped every chat-placed order because those store the raw phone in
   `orders.customerId` (not a `customers.id`); phone resolution now falls
   back to the raw value.
3. **`server/services/useCases.ts`** — the "Pay Now" order action resent the
   checkout link for **cancelled** orders; now refused.

Wave 8 (found by J34/J35/J36):

4. **`server/services/tradeCredit/draw.ts`** — the guard-failure
   classification re-read inside `drawOnCreditTx` queried via `db` instead
   of `tx` while the transaction still held its connection (and the row
   lock): with a single-connection pool the over-limit path **self-deadlocked**
   and the supplier's Approve tap hung forever. Now reads through `tx`.
5. **`server/services/tradeCredit/repayment.ts`** — same `db`/`tx` mixup in
   `applyRepaymentTx`'s over-repayment refusal path; now reads through `tx`.
6. **`server/services/paymentConfirm.ts`** — wave-8 payment intents
   (`po_payment`, `credit_repayment`) reuse `paymentIntents.orderId` for
   non-storefront references (PO / credit-account uuids), but
   `confirmProviderPayment` treated every `orderId` as an `orders.id`: the
   escrow-hold insert violated the `escrow_transactions_order_id_orders_id_fk`
   FK and the webhook 500'd **before** the PO-settle / repayment hooks ran.
   Order confirmation now only fires for references that really are orders
   rows.

Wave 9 (found by J40):

7. **`server/services/onboardingCopilot/agent.ts`** — free-text feedback
   while proposals awaited approval (the WhatsApp `onb_edit:` flow's second
   step) fell through to a generic "please review the cards" reply in
   `handleApproving`: the stale proposal was rejected but nothing ever
   re-drafted it, so the edit path **dead-ended**. `handleApproving` now
   routes non-approve/reject text to `handleRevision`, which re-drafts the
   affected proposal kinds (LLM tool loop + deterministic fallback); the
   checkpoint invariant is untouched — re-drafts arrive PENDING.
8. **`server/services/brandStudio/index.ts`** — `generateBrandKit`'s `vibe`
   argument only reached the (env-gated) AI-logo provider; the always-on
   deterministic monogram path ignored it, so revision feedback like "use
   purple colors" could never change the palette. `paletteForVibe` now maps
   known color words to a muted (saturation-clamped) deterministic palette.

Wave 11 (found by J49/J52):

9. **`server/services/payments/providers/registry.ts`** — the declarative
   customHttp factory (`createCustomProvider`) existed but NOTHING resolved it
   at runtime: a tenant row whose provider id had no built-in adapter was
   silently skipped, so a "zero-code" custom gateway could never initiate or
   receive webhooks. The registry now builds + registers the adapter from
   `credentials.customHttp` when the config id matches the row provider
   (invalid configs fail closed — the row is skipped).
10. **`server/services/payments/providers/unifiedWebhook.ts`** — tenant/
    reference/currency extraction was paystack-shaped only: stripe
    (`data.object.*`), flutterwave (`data.tx_ref`, `data.meta`), monnify
    (`eventData.*`) and customHttp (`payload.*`) bodies failed tenant-cred
    resolution with `provider-not-configured` (401) even when correctly
    signed, and the paystack-only currency read then failed the confirm
    path's amount/currency verification. The route now reads all four body
    shapes; genuinely missing fields still fail closed.
11. **`server/services/payments/providers/registry.ts`** —
    `upsertTenantProviderConfig` used `onConflictDoUpdate` targeting
    `(tenantId, provider)`, but NO unique constraint exists on that pair
    (42P10 on every call) — tenant provider configs could never be written
    through the registry. The upsert is now a select-then-insert/update.

Wave 12 (found by J53/J55):

12. **`server/routers/keycloak.ts`** — `saveConfig` used `onConflictDoUpdate`
    targeting `(tenantId, provider)`, but NO unique constraint exists on that
    pair (42P10 on every call) — tenant Keycloak configs could never be
    written, so SSO setup dead-ended before `exchangeCode` could ever run.
    Same bug class as w11 #11; the upsert is now select-then-insert/update.
13. **`server/routers/analyticsBI.ts`** — `upsertCohort` and
    `upsertChurnPrediction` had the same broken pattern
    (`onConflictDoUpdate` on `(tenantId, cohortMonth)` /
    `(tenantId, customerPhone)` with no backing unique constraint), so every
    cohort/churn write 500'd. Both are now select-then-insert/update.

## Rules

- No changes to prod behaviour except bug fixes (listed above).
- No `skip`/`xit`; every journey asserts real payload content + DB state.
