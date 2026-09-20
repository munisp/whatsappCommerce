# Architecture — WhatsApp Commerce Platform

## System summary
Multi-tenant B2B/B2C commerce platform built on WhatsApp as the primary customer channel, targeting African markets (Nigeria-first: NDPR, NFIU, CAC, FIRS integrations; Naira/Lagos sample data). Tenants are merchant businesses (retailer/supplier/hybrid); each tenant reaches its own customers over WhatsApp, with a web portal for tenant staff and a separate platform-admin app for the operator.

## Stack
- **Core app server**: TypeScript, tRPC routers (`server/routers/*.ts`, 100+ routers), Drizzle ORM over Postgres, Express-based (`server/_core`)
- **Frontend**: 3 Vite/React apps sharing a page library — `client/src` (monolithic/legacy), `ui/platform-admin` (admin-only, `AuthGate: role === "admin"`), `ui/tenant-portal` (merchant-facing, tenant-scoped)
- **Go microservices** (`services/*`, workspace via `go.work`): gateway (APISIX-fronted edge auth), commerce-engine, conversation-orchestrator, payment-orchestrator, webhook-ingestor, event-gateway, hermes-bridge, notification-service, crm-adapter/erp-adapter (**stub modules, no Go source — real logic lives in TS**)
- **Rust services** (`rust/`): ledger-bridge (canonical TigerBeetle 2-phase ledger bridge), recon-worker, event-processor, hermes-router
- **Python**: `ai-agent` (agent orchestration), `services/ml-stack` (fraud/credit models), `services/visual-inventory` (VLM/OCR), `services/kyc-verifier` (OCR/liveness/tamper detection)
- **Infra**: Postgres, Redis, Keycloak (OIDC/RBAC), APISIX (edge gateway), Permify (ReBAC), Temporal (workflows), TigerBeetle (ledger), Kafka/Fluvio (events), Dapr (sidecars)

## Request flow (typical buyer order)
```
WhatsApp buyer message
 → Meta Cloud API webhook → Go event-gateway (verifies X-Hub-Signature-256)
 → Kafka → Rust message-processor (dedup/routing)
 → TS server (NLP cart / conversation flow)
 → order created → escrow/payment intent (Paystack/Flutterwave/Stripe/Monnify)
 → payment webhook (fail-closed HMAC) → paymentConfirm.ts → ledger-bridge (TigerBeetle 2-phase reserve/commit)
 → Temporal fulfillment workflow → delivery (courier registry: only local/stub adapters wired)
 → buyer notified via WhatsApp
```

## Trust/security boundaries actually enforced (verified in code, not assumed)
- `users.role`: user | admin | operator | analyst (`drizzle/schema.ts:27`) — only `admin` is actively distinguished (`server/services/capabilities.ts:66`)
- `tenant_memberships.role`: owner | operator | analyst | finance | catalog (`drizzle/schema.ts:42`) — `finance` gates money ops, `catalog` gates product ops (`server/_core/trpc.ts:268-279`)
- Permify ReBAC schema (`services/middleware/permify-schema.perm`) — second, overlapping authorization model with `buyer`/`merchant`/`operator`/`assignee` relations
- Frontend has **no RequireRole/ProtectedRoute component** — `user.role === "admin"` is the only role check found client-side; everything else is "authenticated + has tenantId". Real boundary is server-side procedure guards (per `ui/shared/AuthGate.tsx` comment).

## Known infra limitations for local QA
- Docker daemon not running in this environment → docker-compose stack (Postgres/Redis/Keycloak/Temporal/TigerBeetle) and `tests/e2e` dockerized suite are **not runnable** without starting Docker.
- Fluvio, Dapr sidecars, OpenAppSec require external cluster per `IMPLEMENTATION_STATUS.md` — not present locally.
- Mobile money provider integration is an explicit façade ("records rows only", `server/routers/mobileMoney.ts`) — not a real integration to test against.
- No real courier is wired (only `localDispatchAdapter`/`motoDispatchStubAdapter`).

See `.qa/stakeholders.md` for the full role/actor inventory and `.qa/dependencies.md` for the external integration map.
