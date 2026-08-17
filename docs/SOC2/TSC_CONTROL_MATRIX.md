# SOC 2 Trust Services Criteria — Control Matrix

Each control is mapped to **concrete, verifiable code evidence** in this
repository. Paths are relative to the repo root. Controls marked ⏳ are wired
to artifacts delivered in the current wave (compliance router endpoints,
audit-chain service, retention service, incidents table) — the matrix entry is
authoritative once those files land.

## CC1 — Control Environment

| ID | Control | Evidence |
|---|---|---|
| CC1.1 | Defined org roles; admin-only operations restricted | `adminProcedure` / `operatorProcedure` / `analystProcedure` in `server/_core/trpc.ts`; role-filtered nav `visibleGroupsForRole` in `client/src/components/DashboardLayout.tsx` |
| CC1.2 | Security/privacy policies published | `docs/SECURITY_AUDIT.md`, `docs/SECURITY_COMPLIANCE.md`, `docs/ZERO_TRUST.md`, this pack |
| CC1.3 | Onboarding/offboarding runbooks | `docs/AGENTIC_ONBOARDING.md`, `docs/PRODUCTION_CHECKLIST.md` |

## CC2 — Communication & Information

| ID | Control | Evidence |
|---|---|---|
| CC2.1 | System description maintained | `docs/SOC2/SYSTEM_DESCRIPTION.md` |
| CC2.2 | Internal status/incident communication | `INCIDENT_RUNBOOK.md` comms templates; incidents surfaced at `/soc2` (`client/src/pages/Compliance.tsx`) |
| CC2.3 | Deployment/rollback communication | `docs/RUNBOOK_ROLLBACK.md`, `DEPLOYMENT.md` |

## CC3 — Risk Assessment

| ID | Control | Evidence |
|---|---|---|
| CC3.1 | Fraud risk screening on credit/payment flows | `server/services/fraud.ts`, `server/routers/fraudCase.ts` |
| CC3.2 | Sanctions/KYB risk checks | `server/services/compliance/sanctions.ts`, `server/services/compliance/registryVerify.ts`, `server/services/kycGate.ts` |
| CC3.3 | Recurring compliance audit | `docs/COMPLIANCE_AUDIT.md`; self-check `scripts/soc2-check.ts` (CI, non-blocking) |

## CC4 — Monitoring

| ID | Control | Evidence |
|---|---|---|
| CC4.1 | Hash-chained, tamper-evident audit log with verification | ⏳ `server/services/auditChain.ts`; verify via tRPC `compliance.verifyAuditChain`; UI status card in `client/src/pages/Compliance.tsx`; operator views `client/src/pages/AuditLog.tsx`, `client/src/pages/AuditLogViewer.tsx` |
| CC4.2 | Authz coverage continuously scanned (tenant-guard ratchet) | `server/routers/__tests__/authzScan.lib.ts`, `server/routers/__tests__/authzCoverage.test.ts`, per-area ratchets `w12authz*.test.ts` |
| CC4.3 | Health/observability monitoring | `server/services/observability.ts`, `server/routers/infra.ts`, `client/src/pages/HealthStatus.tsx`, `client/src/pages/InfraHealth.tsx`, `client/src/pages/ServiceHealth.tsx` |
| CC4.4 | Controls self-check script in CI | `scripts/soc2-check.ts`; step in `.github/workflows/ci.yml` (`continue-on-error: true`) |

## CC5 — Control Activities

| ID | Control | Evidence |
|---|---|---|
| CC5.1 | Payment confirmation state invariant (money moves only via checked transitions) | `server/services/paymentConfirm.ts` (byte-locked invariant file); COD cash invariants in `server/services/codFlow.ts` + `server/services/codFlow.test.ts` |
| CC5.2 | Webhook replay/dedupe protection | `server/services/webhookDedupe.ts`, DLQ handling `server/routers/webhookDlq.ts`, e2e `tests/e2e/webhook-security.test.ts` |
| CC5.3 | Idempotent/reconciled funds flows | `tests/e2e/funds-flow.test.ts`, `server/services/reconMatch.ts`, `client/src/pages/ReconciliationSim.tsx` |
| CC5.4 | Rate limiting / abuse controls | `server/services/rateLimit.ts` (+ `rateLimit.test.ts`), `server/services/frequencyCap.ts` |

## CC6 — Logical & Physical Access

| ID | Control | Evidence |
|---|---|---|
| CC6.1 | Tenant isolation enforced on every tenant-relevant procedure | `assertTenantAccess` in `server/_core/trpc.ts`; enforced repo-wide by `server/routers/__tests__/authzCoverage.test.ts` (guards or parsed `// authz:exempt` required) |
| CC6.2 | Quarterly access review of users, roles, sessions | ⏳ tRPC `compliance.accessReview`; UI table in `client/src/pages/Compliance.tsx` |
| CC6.3 | Phone/OTP and SSO access paths controlled | `client/src/pages/PhoneAuthPage.tsx`, `server/routers/keycloak.ts`, `client/src/pages/SsoUsers.tsx` |
| CC6.4 | Secrets only via environment, never committed | `env.example.txt` placeholders only (verified by `scripts/soc2-check.ts`); runtime env documented in `DEPLOYMENT.md` |
| CC6.5 | Session management | `server/_core/` auth stack; active session counts surfaced by `compliance.accessReview` |

## CC7 — System Operations (incidents & change)

| ID | Control | Evidence |
|---|---|---|
| CC7.1 | Incident recording with severity + status lifecycle | ⏳ `incidents` table (`drizzle/schema.ts`), incidents router; rollup via tRPC `compliance.incidentStatus`; UI in `client/src/pages/Compliance.tsx` |
| CC7.2 | Incident response runbook + postmortems | `docs/SOC2/INCIDENT_RUNBOOK.md` |
| CC7.3 | Change management via PR + CI gates | `.github/workflows/ci.yml` (typecheck, vitest, prod audit, CV-stack gate); `docs/SOC2/CHANGE_MANAGEMENT.md` |
| CC7.4 | Webhook failure recovery (DLQ) | `server/routers/webhookDlq.ts`, `client/src/pages/WebhookDLQ.tsx` |
| CC7.5 | Resilience engineering | `docs/RESILIENCE.md`, `server/routers/heartbeat.ts` |

## CC8 — Change Management

| ID | Control | Evidence |
|---|---|---|
| CC8.1 | All changes via reviewed PR with green CI | `.github/workflows/ci.yml`; branch protection on `main` |
| CC8.2 | Migration discipline (additive-only; reviewed) | `drizzle/` migrations; policy in `docs/SOC2/CHANGE_MANAGEMENT.md` |
| CC8.3 | Invariant files protected from silent modification | `server/services/paymentConfirm.ts` byte-identity rule enforced by wave checklists; `scripts/soc2-check.ts` asserts presence |

## CC9 — Risk Mitigation (vendors & continuity)

| ID | Control | Evidence |
|---|---|---|
| CC9.1 | Subprocessor register with data categories | `docs/SOC2/VENDOR_REGISTER.md` |
| CC9.2 | Backup/rollback procedures | `docs/RUNBOOK_ROLLBACK.md`, `scripts/migrate-prod.ts` |
| CC9.3 | Staging E2E before production | `tests/e2e/`, `scripts/run-e2e.sh`, `scripts/staging-e2e.ts`, `docs/STAGING_E2E.md` |

## A — Availability

| ID | Control | Evidence |
|---|---|---|
| A1.1 | Health/readiness endpoints | `server/services/healthReady.ts`, `server/routers/infra.ts` |
| A1.2 | Deployment topology & scaling | `Dockerfile`, `docker-compose.yml`, `k8s/` |

## C — Confidentiality / PI — Privacy

| ID | Control | Evidence |
|---|---|---|
| C1.1 | Data classification tiers mapped to tables | `docs/SOC2/DATA_CLASSIFICATION.md` |
| C1.2 | Consent management | `server/services/consent.ts`, `server/routers/consents.ts`, `client/src/pages/Consents.tsx` |
| C1.3 | Per-entity retention & legal hold | ⏳ `retention_policies` table, `server/services/retention.ts`; exposed via tRPC `compliance.retentionPolicies`; UI in `client/src/pages/Compliance.tsx` |
| C1.4 | PII minimization in logs | Structured logging via `server/services/observability.ts`; classification rules in `DATA_CLASSIFICATION.md` |
