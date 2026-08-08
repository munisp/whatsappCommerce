# Compliance Audit — WhatsApp Commerce Platform

Scope: PCI-DSS / SOC 2 / NDPR (Nigeria Data Protection Regulation) / AML-CFT (NFIU-adapted SAR filing).
Every item is mapped to actual code evidence. Statuses: **PASS** (implemented + evidence), **PARTIAL** (implemented with caveats), **GAP** (missing).

Date of audit: branch `fix/verify-compliance`, main HEAD `e7d6337` + compliance changes.

---

## 1. Cardholder Data / PCI-DSS

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 1.1 | No PAN storage — card numbers never touch our DB | **PASS** | `drizzle/schema.ts:200` (`paymentIntents`) and the entire schema contain **no** card/PAN/CVV columns (grep for `card`, `PAN`, `cvv`, `cardNumber` → 0 hits). Payments are initialized at provider-hosted pages: Paystack `transaction/initialize` returns an `authorization_url` (`server/routers/payment.ts:368-389`), Flutterwave returns a hosted `link` (`server/routers/payment.ts:390-411`). Card data is entered on provider pages only (provider tokenization). |
| 1.2 | No sensitive auth data in logs | **PASS** | Only `reference`, `providerPaymentId` and provider response metadata are persisted (`server/routers/payment.ts:455-468`). No PAN fields exist to leak. |
| 1.3 | TLS in transit | **PASS** | TLS terminated at Caddy edge with ACME (`DEPLOYMENT.md:60-70`, `services/caddy-edge/`); mTLS between Caddy and APISIX (`DEPLOYMENT.md:49-57`); workload mTLS cert TTL 24h (`DEPLOYMENT.md:195`). DB connections use `sslmode=require` when configured (`server/db.ts:33`). |
| 1.4 | Secrets via env, fail-closed | **PASS** | Provider keys come from `process.env` only (`server/_core/env.ts:104`); `payment.initiate` throws `PAYSTACK_SECRET_KEY not configured` / `FLW_SECRET_KEY not configured` when absent (`server/routers/payment.ts:368,390`) — no default/fallback keys. K8s injects via `secretRef` (`k8s/api-gateway.yaml:26-29`). |
| 1.5 | Idempotent payment processing | **PASS** | Redis idempotency lock per order (`server/routers/payment.ts:203`), unique `idempotencyKey` column (`drizzle/schema.ts:209`), guarded status transitions preventing double-confirm (`server/routers/payment.ts:560-573`). |
| 1.6 | Double-entry ledger with 2-phase commit | **PASS** | Reserve-before-charge + commit/void on confirm (`server/routers/payment.ts:316-360`, `492-545`); ledger failure = payment failure, never silent success. |

## 2. Access Control (SOC 2 CC6)

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 2.1 | Authenticated procedures | **PASS** | `protectedProcedure` rejects unauthenticated callers (`server/_core/trpc.ts:15-28`). |
| 2.2 | Admin gate (RBAC) | **PASS** | `adminProcedure` requires `role === 'admin'` (`server/_core/trpc.ts:32-38`). |
| 2.3 | Defense-in-depth ReBAC | **PASS** | Permify check layered on admin gate, **fails closed in production** (`server/_core/trpc.ts:40-68`). |
| 2.4 | Tenant isolation | **PASS** | `assertTenantAccess` / `assertBuyerOrAdmin` on money paths (`server/routers/escrow.ts:49,57,623`); buyer cannot self-release escrow with `autoConfirmed` unless admin (`server/routers/escrow.ts:630-632`). |
| 2.5 | Admin-only compliance endpoints | **PASS** | `fraudCase.*`, `report.monthlySettlement`, `audit.export`, `privacy.listErasureRequests` are all `adminProcedure` (`server/routers/fraudCase.ts:94,128,161`, `report.ts:82`, `audit.ts:26`, `privacy.ts:173`). Pen-test: non-admin `markFiled` → `FORBIDDEN` (`server/compliance.test.ts` — "non-admin cannot mark their own case filed"). |

## 3. Audit Trail (SOC 2 CC7 / AML record-keeping)

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 3.1 | Immutable audit log table | **PASS** (new) | `audit_logs` table (`drizzle/schema.ts` — migration `drizzle/0029_compliance_privacy_fraud_audit.sql`), append-only writer `writeAuditLog` that never throws into money paths (`server/routers/audit.ts:11-21`). |
| 3.2 | Money-movement hooks | **PASS** (new) | Audit rows written on: escrow release (`server/routers/escrow.ts:644-654` — action `escrow.release`), withdrawal request (`server/routers/escrow.ts:1318-1328` — `wallet.withdrawal`), payment confirm (`server/routers/payment.ts:578-587` — `payment.confirm`), fraud flag (`server/routers/payment.ts:289-303` — `payment.fraudFlag`), fraud-case requeue/file (`server/routers/fraudCase.ts:112-122,176-186`). |
| 3.3 | Forensic export | **PASS** (new) | `audit.export` adminProcedure with actor/action/entity/date-range filters (`server/routers/audit.ts:26-54`). Test: requeueing a fraud case produces an exportable row (`server/compliance.test.ts` — "admin can export rows written by fraud-case requeue"). |
| 3.4 | Pre-existing webhook audit | **PASS** | `webhook_events` table with status machine (`drizzle/schema.ts:245`); shipment `webhookPayloads` raw-payload trail (`drizzle/schema.ts:1277`); WAF events table (`openappsecWafEvents`). |
| 3.5 | Audit row tamper-resistance | **GAP** | `audit_logs` has no hash-chain/WORM guarantee; a DB superuser could rewrite history. Acceptable for current maturity; recommend periodic anchoring/export. |

## 4. Data Privacy — NDPR/GDPR

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 4.1 | Data-subject portability export | **PASS** (new) | `privacy.exportMyData` gathers caller's user row, customer profiles (matched by WhatsApp phone), orders, escrow transactions, merchant wallet + ledger into one JSON document (`server/routers/privacy.ts:36-83`). |
| 4.2 | Right to erasure with regulatory retention | **PASS** (new) | `privacy.requestErasure` nulls `name`/`email`/`phone` on `users` and tombstones customer profiles, while **keeping financial rows** (orders/escrows/wallet ledger) for AML/tax retention (`server/routers/privacy.ts:86-170`). |
| 4.3 | Honest erasure guards | **PASS** (new) | Erasure is **blocked** (status `rejected` + `blockedReason`) when the user has open escrows or pending withdrawals — no silent success (`server/routers/privacy.ts:107-147`). |
| 4.4 | Erasure oversight | **PASS** (new) | `erasure_requests` table + admin `privacy.listErasureRequests` (DPO view) (`server/routers/privacy.ts:173-187`). |
| 4.5 | Consent management for marketing | **PARTIAL** | Per-user WhatsApp notification opt-ins exist (`drizzle/schema.ts:50-52` — `whatsappNotifOrders/Status/Marketing`), but no explicit consent-timestamp/NDPR consent register. |
| 4.6 | Data-residency documentation | **GAP** | No documented region pinning for Postgres/Redis; NDPR cross-border transfer assessment not in repo. |

## 5. AML / Fraud (NFIU-adapted SAR filing)

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 5.1 | ML fraud scoring endpoint | **PASS** | `POST /api/ml/predict` → FastAPI ML stack with statistical fallback (`server/_core/index.ts:2697-2762`); fallback heuristic shared with payment path (`server/services/fraud.ts:27-50`). |
| 5.2 | High-risk payment flagging | **PASS** (new) | `payment.initiate` scores every initiation; `riskLevel === 'high'` (score > 0.7, `server/services/fraud.ts:11,42`) flags intent metadata and **creates a fraud case** (`server/routers/payment.ts:246-303`). Before this change, high-risk payments were **not** flagged — this was a real gap, now closed. |
| 5.3 | SAR-style filing queue | **PASS** (new) | `fraud_cases` table with `pending → filed / failed → dead_letter` machine (`drizzle/schema.ts`); filing goes through the notification path + optional `AML_WEBHOOK_URL` webhook (`server/routers/fraudCase.ts:44-78`). |
| 5.4 | Retry + DLQ | **PASS** (new) | `fraudCase.retryFailed` (guarded `failed → pending`, concurrency-safe) and cron-processable `fraudCase.processQueue` with optimistic claim and dead-letter after 3 attempts (`server/routers/fraudCase.ts:94-126,156-190`; `FRAUD_CASE_MAX_ATTEMPTS = 3` at line 10). Tests cover retry cycle, DLQ, and concurrent requeue/worker safety. |
| 5.5 | Filing integrity (no self-adjudication) | **PASS** | `fraudCase.markFiled` is admin-only; a non-admin cannot mark their own case filed (pen-test in `server/compliance.test.ts`). |
| 5.6 | PEP / sanctions screening | **GAP** | No PEP/sanctions list screening of customers/vendors; KYC router exists (`server/routers/kyc.ts`) but no list-matching. Recommended next phase. |

## 6. Financial Reporting (regulator-adapted monthly settlement)

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 6.1 | Monthly settlement/fee report | **PASS** (new) | `report.monthlySettlement` (admin) computes per-tenant gross volume, platform fees, net merchant payouts, refund totals, escrow in-flight, and month-over-month deltas via SQL aggregates on `escrow_transactions` (`server/routers/report.ts:82-135`). Math verified against hand-computed values in `server/compliance.test.ts`. |
| 6.2 | Escrow custody accounting | **PASS** | Escrow state machine with atomic transitions (`server/routers/escrow.ts:246-303` `settleEscrowAtomic`), platform fee rate config (`drizzle/schema.ts:1155`), wallet ledger with before/after balances (`drizzle/schema.ts:1227-1250`). |

## 7. Summary

- **PASS**: 20 | **PARTIAL**: 1 | **GAP**: 3 (audit tamper-resistance 3.5, data residency 4.6, PEP screening 5.6)
- New surface in this change: `privacy`, `fraudCase`, `report`, `audit` routers; `erasure_requests`, `fraud_cases`, `audit_logs` tables (migration 0029); shared fraud heuristic; payment-path fraud flagging.
- Validation: `npx tsc --noEmit` = 0 errors; `npx vitest run` = 430 passed / 7 skipped (28 new compliance tests).
