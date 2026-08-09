# WhatsApp Feature Simulation

An end-to-end harness that exercises **every WhatsApp feature** of this repo
against the **real webhook handlers and services**, with only the external
edges (Meta Cloud API, LLM, Whisper, Paystack/Flutterwave, Keycloak) mocked.

## Run it

```bash
npm install --legacy-peer-deps --ignore-scripts
npm run simulate                 # all 30 journeys
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

## Rules

- No changes to prod behaviour except bug fixes (listed above).
- No `skip`/`xit`; every journey asserts real payload content + DB state.
