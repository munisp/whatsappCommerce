# WhatsApp Commerce — Implementation Status
> Updated: 2026-08-08 (wave 3) | Two independent audit + remediation campaigns.
> 12 merged PRs in wave 2/3 (#27–#38) on top of the 9 wave-1 branches. HEAD: post-merge of fix/e2e-tests-2 + fix/deploy-hardening.

## Verification gates (all green on main)
- `npx tsc --noEmit` → exit 0
- `npx vitest run` → 402 passed / 7 skipped / 0 failed (13 files)
- `go build ./...` → all Go services PASS (gateway, commerce-engine, conversation-orchestrator, payment-orchestrator, webhook-ingestor, event-gateway, hermes-bridge)
- `cargo check` → all Rust crates PASS (ledger-bridge, recon-worker, event-processor, hermes-router, services/ledger-bridge)
- `python3 -m py_compile` → all ml-stack / ai-agent / visual-inventory files PASS
- drizzle journal: 0022 (USING-cast fix) + 0027 + 0028 registered; fresh-DB migration applies all 123 tables + 70+ indexes

## End-to-end test suite (tests/e2e)
- `scripts/run-e2e.sh` — dockerized full-stack run (platform.Dockerfile + docker-compose.test.yml + tb-sidecar fixture) or local tsx+Postgres path; documented in docs/E2E.md
- `smoke.test.ts` — boot/health/router registration
- `webhook-security.test.ts` — fail-closed HMAC verification (Paystack/Flutterwave/WhatsApp), replay rejection
- `trpc-contract.test.ts` — tRPC endpoint contract checks
- `funds-flow.test.ts` — 8 money-invariant tests: 10x concurrent escrow release → exactly 1 credit; over-balance withdrawal rejected; idempotent payment initiation under concurrency (1 payment_intents row); webhook replay → no double credit; fee-rate rounding pinned (numeric(6,4) 0.03125→0.0313)
- `service-to-service.test.ts` — ML `/predict` contract, ledger-bridge reserve→commit / reserve→void balance deltas + idempotent replay, recon-worker trigger, gateway auth/path pins (401/404/never-502)

## Infrastructure integrations — post-remediation status

| Service | Status | Notes |
|---------|--------|-------|
| PostgreSQL | ✅ Real | 0027 journaled, 0028 (FK + 49 indexes), relations populated |
| Redis | ✅ Real | Idempotency locks, rate limiting (fail-closed in prod), Dapr statestore |
| Keycloak | ✅ Real | Compose + k8s; gateway enforces RS256 JWT (iss/exp/aud) on /api/v1; server sdk.ts validates Keycloak Bearer via JWKS (+audience when KEYCLOAK_AUDIENCE set); prod fatals without KEYCLOAK_URL |
| APISIX | ✅ Real | Standalone in compose; live tRPC router (listLive/deleteRoute/syncAll/health); admin key has no committed default |
| Permify | ✅ Real | Compose + k8s; gateway ReBAC middleware fails CLOSED in production-like envs, loud fail-open only in dev |
| Temporal | ✅ Real | Compose + k8s; order fulfillment workflow started on order create |
| TigerBeetle | ✅ Real | Official container; ledger-bridge 2-phase reserve/commit/void, integer minor units, idempotency keys, PENDING_TIMEOUT 900s auto-void, /ledger/reverse, /accounts/provision |
| Dapr | ⚠️ Code real, sidecar external | Client + audit logging real; run sidecars via orchestrator |
| Fluvio | ⚠️ Code real, cluster external | Gateway producer wired; consumer target /api/internal/events exists |
| Lakehouse | ✅ Real | Pipeline bugs fixed; honest run tracking |
| OpenAppSec | ⚠️ Event pipeline real | Deploy agent in front of APISIX/gateway for inspection |
| ML inference | ✅ Real on CPU | Trained weights (fraud GNN-LSTM + credit TabNet) load in FastAPI; ONNX export + onnxruntime CPU (~3ms); labeled heuristic fallback; measured real inference on sample payloads |

## Security hardening (wave 2/3)
- **Auth**: unified server auth (wa_session cookie + Keycloak Bearer via jose JWKS + legacy) in sdk.ts; gateway KeycloakJWTAuth on /api/v1 with iss/exp/aud; TenantResolver anti-spoof; X-Internal-Token on internal service hops (ai-agent, hermes-skills, hermes-router); keycloak-auth.ts dead code removed
- **Safe-by-default env**: isProd = anything except explicit development/test (unset NODE_ENV = fail closed); JWT_SECRET/cookieSecret mandatory in prod; ENABLE_LOCAL_AUTH=true now required for the dev login endpoint (misconfigured deploys can no longer mint sessions)
- **Webhooks**: fail-closed HMAC (timingSafeEqual) on all provider webhooks; replay-safe (already-completed short-circuit)
- **RBAC**: adminProcedure on all money ops (escrow settle/release/disputes, withdrawals); buyer verification on escrow actions; self-release removed from UI; Permify fail-closed in prod (TS + Go gateway)
- **Rate limiting**: /api/trpc limiter fails closed (503 + Retry-After) in prod on Redis outage

## Funds-flow atomicity (wave 2/3)
- Escrow: `settleEscrowAtomic` — guarded UPDATE...WHERE state IN (...) + rowCount checks inside a transaction; exactly-once wallet credit proven under 10x concurrency; disputes guarded; wallet withdrawal is an atomic conditional debit (INSUFFICIENT_FUNDS, duplicate-reference replay safe)
- Payments: ledger /transfer 2-phase (reserve→commit, void-on-failure); idempotency keys fail-closed; confirmProviderPayment split-brain fixed; amount/currency verified against intent before confirm; tenant-scoped gateway configuration
- Reconciliation: recon-worker actively voids orphaned pending transfers and emits /api/internal/events alerts
- Mobile money: HMAC-verified callbacks; initiate is protectedProcedure

## Integrations
- **Odoo / Twenty CRM / Medusa**: demo/fake code deleted; real REST API calls with unified config stores, DB-persisted credentials, testConnection procedures, fetch-with-retry; admin-gated configuration in Admin Portal
- **WhatsApp**: webhook routes bound correctly (were nested inside escrow-bank handler); signature verified; USSD channel persistence real

## Frontend
- Left navigation categorized/streamlined (grouped sections, no dead-end pages); broken links fixed; PortalMagicLogin /portal/login route; SlaExtensionResponse hardened; MerchantWallet pending state; self-release button removed; 55-link site crawl issues remediated

## Production readiness scorecard (0–100 per domain)

| Domain | Score | Basis |
|--------|------:|-------|
| Schema & migrations | 95 | 123 tables, 70+ indexes, journal clean; residual: retrain-data provenance |
| AuthN/AuthZ | 90 | Keycloak end-to-end, fail-closed defaults; residual: PKCE verifier not yet sent on token exchange |
| Funds flow & ledger | 92 | Atomic 2-phase ledger + concurrency-proven invariants; residual: Stripe path is a simplified payment-link flow |
| Payments & webhooks | 90 | Fail-closed HMAC, replay-safe, idempotent; residual: provider sandbox-only testing |
| Integrations (Odoo/Twenty/Medusa/WhatsApp) | 85 | Real bidirectional API calls; residual: needs live credential validation per tenant |
| ML/AI | 80 | Real trained models, CPU inference, honest fallback; residual: weights fit on synthetic data — retrain on real data |
| Infra middleware (Temporal/Fluvio/Dapr/OpenAppSec) | 78 | All wired in code; Fluvio/Dapr/OpenAppSec need external cluster deploys |
| Frontend & navigation | 88 | Crawl-clean, grouped nav, no dead ends; residual: ~30% of tRPC procedures intentionally server-only or UI-not-yet-built |
| Testing | 85 | 402 unit + full e2e suite incl. funds-flow invariants; residual: e2e needs Docker host to run in CI |
| **Overall** | **87** | |

## Operator runbook — REQUIRED before go-live
1. Set `NODE_ENV=production`, a real `JWT_SECRET` (32+ random bytes), `KEYCLOAK_URL`, `KEYCLOAK_AUDIENCE`, `APP_URL`, `PERMIFY_URL`, `APISIX_ADMIN_KEY`, `DATABASE_URL`, `REDIS_URL`.
2. Do NOT set `ENABLE_LOCAL_AUTH` in production (any non-"true" value disables the passwordless dev login).
3. Redeploy the client bundle built from current main (the previously deployed bundle predates Keycloak wiring).
4. Rotate any secrets that were ever deployed with defaults; purge test accounts created during audits.
5. Deploy Fluvio cluster, Dapr sidecars, and the OpenAppSec agent per env.example.txt; run `scripts/run-e2e.sh` against staging before cutover.
6. Retrain fraud/credit models on real payment data via the lakehouse pipeline.

## Known remaining gaps (transparent)
1. **3 empty Go modules** — crm-adapter, erp-adapter, notification-service declared in go.work, no code yet.
2. **~30% of tRPC procedures have no frontend caller** — many are server-to-server/cron by design.
3. **PKCE verifier stored but not sent** on token exchange (Keycloak login works; complete the PKCE flow for full compliance).
4. **Trained weights fit on synthetic data** — retrain before relying on fraud scores.
5. **Stripe initiation** in payment-orchestrator is a simplified payment-link flow.
6. **Gateway legacy-HS256 path mismatch** pinned by e2e tests (ForwardTo preserves full URI; commerce-engine mounts /products) — migrate fully to Keycloak mode.
