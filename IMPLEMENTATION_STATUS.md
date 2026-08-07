# WhatsApp Commerce — Implementation Status
> Updated: 2026-08-08 | Independent full-stack audit + remediation (9 merged branches: fix/server-core, fix/routers, fix/schema, fix/infra, fix/ml, fix/go-rust, fix/frontend, fix/wave2 + direct fixes)

## Verification gates (all green on main)
- `npx tsc --noEmit -p tsconfig.json` → exit 0 (was 33 errors pre-audit)
- `go build ./...` → gateway, commerce-engine, conversation-orchestrator, payment-orchestrator, webhook-ingestor, event-gateway, hermes-bridge (CGO) all PASS
- `cargo check` → ledger-bridge, recon-worker, event-processor, hermes-router (now in workspace), services/ledger-bridge all PASS
- `python3 -m py_compile` → all ml-stack / ai-agent / visual-inventory files PASS
- drizzle journal: 0027 + 0028 registered with snapshots; `drizzle-kit migrate` now applies all 123 tables + indexes

## Infrastructure integrations — honest post-remediation status

| Service | Status | What changed in remediation |
|---------|--------|------------------------------|
| PostgreSQL | ✅ Real | 0027 journaled (8 infra tables now actually created), new 0028 (FK + 49 indexes), escrow column bug fixed, relations.ts populated |
| Redis | ✅ Real | Was already real (idempotency locks, rate limiting, Dapr statestore) |
| Keycloak | ✅ Real (deployed) | Added to docker-compose + k8s; auth flows real; `/api/auth/local` hardened (501 in prod, no more accept-any-password) |
| APISIX | ✅ Real (deployed) | Added to compose (standalone) + admin client + registered `apisix` tRPC router (was dead code); routes sync via `infra` + `apisix.syncAll` |
| Permify | ✅ Real (deployed) | Added to compose + k8s with schema; gateway ReBAC middleware wired (note: fails open when unreachable — set PERMIFY_URL in prod) |
| Temporal | ✅ Real (deployed) | Added to compose + k8s; order fulfillment workflow now actually started on order create (orderCrud) |
| TigerBeetle | ✅ Real (deployed) | Official container added to compose; ledger-bridge no longer fakes success (503 when unreachable; in-memory only behind LEDGER_ALLOW_INMEMORY dev flag; 10M pre-funding removed) |
| Dapr | ⚠️ Code real, sidecar external | Client + audit logging real; run sidecars via your orchestrator (documented); pubsub name aligned |
| Fluvio | ⚠️ Code real, cluster external | Producer now actually constructed in gateway + order/payment events published; consumer target `/api/internal/events` now exists; deploy a Fluvio cluster and set FLUVIO_ENDPOINT |
| Lakehouse | ✅ Real | Pipeline bugs fixed (timestamp features, fraud label); trigger now runs pipeline honestly (no phantom "running" rows) |
| OpenAppSec | ⚠️ Event pipeline real | WAF event ingestion real; deploy the open-appsec agent in front of APISIX/gateway for actual inspection |
| ML inference | ✅ Real models on CPU | FastAPI server now loads the committed trained weights (fraud GNN-LSTM + credit TabNet), ONNX export + onnxruntime CPU path, labeled deterministic heuristic fallback; Dockerfile + CPU requirements added |

## Critical runtime bugs fixed
- WhatsApp webhook routes were registered inside the escrow-bank handler (never bound at startup) — fixed
- `/api/ml/predict` called nonexistent `/predict/fraud` → now calls `/predict`, real model path
- payment.ts referenced 4 nonexistent payment_intents columns (would crash) — remapped to real columns
- sla.ts wrote nonexistent escrow columns (`status` vs `state`) — fixed
- Missing REST endpoints added: `/api/sla-extension/:token` (GET/POST), `/api/evidence/:token/submit` (binary), `/api/internal/events`, `/api/scheduled/generate-invoices`
- payment-orchestrator missing `context` import (Go build failure); hermes-router missing from cargo workspace; gpu_train_runner.py SyntaxError

## Mocks/placeholders eliminated
- Merchant wallet top-up was fake-crediting funds → now real provider-initiated payment intent, credited on confirmation
- Payment verification auto-approved unknown providers → now `pending_review` unless provider-verified
- Odoo↔Medusa sync wrote `Math.random()` stock → removed; honest `odoo_unavailable` status
- ML predict.py random-noise heuristic → deterministic shared model loader
- Gateway admin routes proxied to themselves (infinite loop) → explicit 501 with guidance
- AI gateway path mismatch (`/api/v1/ai/intent` → 404) → strip-prefix proxy fix

## Known remaining gaps (transparent)
1. **3 empty Go modules** — crm-adapter, erp-adapter, notification-service are declared in go.work but contain no code.
2. **~30% of tRPC procedures have no frontend caller** (149/489) — many are server-to-server/cron by design; some represent UI not yet built (e.g. admin KYC review screen).
3. **Keycloak JWT not enforced on tRPC** — tRPC auth still uses legacy session auth; keycloak-auth.ts exists but isn't in the request path. PKCE verifier is stored but not yet sent on token exchange.
4. **Trained weights were fit on synthetic data** (self-reported AUROC 1.0) — retrain via the lakehouse pipeline against real payment data before relying on fraud scores.
5. **Dapr sidecars / Fluvio cluster / OpenAppSec agent** are external deploys (not containerized in compose) — set the env vars documented in env.example.txt.
6. Stripe initiation in payment-orchestrator is a simplified payment-link stub.
