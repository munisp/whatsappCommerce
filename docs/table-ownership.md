# Table Ownership (W62 F11)

W61 backend-graph audit flagged 18 tables with no writer detected by the
services/ scan. W62 verified each against the full codebase (routers,
server/db.ts, server/_core/sdk.ts, raw `sql`` templates, Go/Rust sidecars).
Schema annotations (`// W62 F11 WRITER:` / `DEPRECATED` / `EXTERNAL`) were
added at each `pgTable` definition. **No tables were dropped — additive-only
schema policy.**

## Verified writers (scan false positives)

| Table | Writer |
|---|---|
| session_revocations | `server/_core/sdk.ts` — drizzle inserts in revoke helpers (checked on every wa_session auth) |
| tigerbeetle_accounts | `rust/ledger-bridge` sidecar (ledger account mapping) |
| customer_wallets | `server/services/customerWallet.ts` — raw `sql`` INSERT/UPDATE (raw SQL invisible to the scan) |
| service_health | `server/db.ts` — `recordServiceHealth()` db helper |
| media_assets | `server/services/brandStudio/index.ts` (2 inserts) |
| manufacturer_credit_programs | `server/services/manufacturerPrograms.ts` (local pgTable mirrors 0059 physical schema) |
| merchant_clawbacks | `server/services/payments/disputes.ts`, `server/routers/orderCrud.ts` |
| dispute_evidence_submissions | `server/routers/evidencePortal.ts` |
| tenant_approval_policies | `server/routers/approvals.ts` |

## External-writer / append-only (intentionally writer-less in TS)

| Table | Intent |
|---|---|
| forex_rates | Reserved for FX rate feed sidecar; read via raw SQL/views |
| ltv_scores | ML stack offline scoring job; append-only |
| hermes_event_log | Hermes bridge pipeline (currently dormant — see docs/event-topology.md); read by server/routers/hermes.ts |
| ussd_sessions | Reserved for the USSD gateway; /ussd endpoint is currently stateless |
| telemetry_component_status | Telemetry/control-plane status feed |

## Deprecated (genuinely dead — retained per additive-only policy, do NOT write new rows)

| Table | Note |
|---|---|
| webhook_events | Superseded by processed_webhook_events (dedupe ledger), wa_webhook_events (WA DLQ), raw_webhook_events (W61 PSP landing pad). Imported in server/db.ts but never written. |
| digital_products | Digital-goods roadmap table; superseded by digital_pins / digital_product_purchases flows |
| seller_products | No writer or reader in platform code |
| government_contracts | GovProc roadmap table |
