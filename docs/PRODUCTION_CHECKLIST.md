# Production Go-Live Checklist

Sequential runbook for taking whatsappCommerce to production. Phases are
ordered — do not start a phase until the previous one is verified. Owner
legend: **Platform** = platform engineering, **Tenant** = tenant/business
owner, **Meta** = Meta Business Suite actions, **Paystack** = Paystack
dashboard/support actions.

Rollback reference for every phase: [RUNBOOK_ROLLBACK.md](./RUNBOOK_ROLLBACK.md).

---

## Phase 0 — External lead-time items (START WEEKS AHEAD)

These have third-party review latency. Start them before any infra work.

| # | Item | Owner | Notes / exit criteria |
|---|------|-------|-----------------------|
| 0.1 | Meta Business verification | Meta | Business verified in Business Manager (documents review: days–weeks). |
| 0.2 | Meta app review — **advanced `whatsapp_business_messaging`** | Meta | App Review submission with screencast; standard access caps messaging at the test tier. |
| 0.3 | Display-name review | Meta | Display name approved per Meta naming policy for every WABA number. |
| 0.4 | Number registration + 2FA PIN | Meta | Number registered via Cloud API; **store the 2FA PIN in the secrets manager** — required for re-registration and migrations. |
| 0.5 | Messaging-tier ramp expectations | Platform | Tiers ramp 250 → 1K → 10K → 100K unique customers/24h based on quality rating. Plan launch volume against the CURRENT tier; monitor `wa_quality` outputs. |
| 0.6 | Template pre-approval list | Tenant + Meta | All launch templates (order confirm, cart recovery, dunning, OTP, delivery updates) submitted and APPROVED before first send. |
| 0.7 | Paystack live KYC | Paystack | Business KYC approved; live keys issued. |
| 0.8 | Paystack settlement account | Paystack | Settlement bank account verified with a test payout. |
| 0.9 | Paystack webhook registration | Paystack + Platform | Live dashboard webhook → `https://<domain>/api/webhooks/paystack`; store the secret as `PAYSTACK_WEBHOOK_SECRET`. |

## Phase 1 — Infrastructure

| # | Item | Owner | Notes / exit criteria |
|---|------|-------|-----------------------|
| 1.1 | Postgres HA + automated backups | Platform | HA pair/managed instance; daily snapshots + PITR. **Restore rehearsal executed** per RUNBOOK_ROLLBACK.md — an untested backup is not a backup. |
| 1.2 | Redis | Platform | Managed/instance reachable at `REDIS_URL` (or `REDIS_TLS_URL`). Required for multi-node rate limiting and chat sessions — the in-memory fallback is single-node only. |
| 1.3 | Caddy multi-domain TLS | Platform | Certificates issuing for app + tenant domains; see docs/caddy-integration-analysis.md. |
| 1.4 | Keycloak prod realm + SSO roles | Platform | Prod realm (not master), roles mapped, redirect URIs restricted to prod domains. |
| 1.5 | Env matrix (below) populated | Platform | Every REQUIRED_BY_ENV var set; boot gate will REFUSE to start otherwise. |

### Environment matrix

Boot-gated in `server/_core/env.ts` (`REQUIRED_BY_ENV`) — missing any of these
in production = hard boot failure with the explicit list:

| Variable | Required | Generation / source |
|----------|----------|---------------------|
| `DATABASE_URL` (or `POSTGRES_URL`) | ✅ boot gate | Postgres DSN from 1.1 |
| `JWT_SECRET` | ✅ boot gate | `openssl rand -base64 48` |
| `KEYCLOAK_URL` | ✅ boot gate | Keycloak prod base URL |
| `APP_URL` | ✅ boot gate | Public app origin |
| `REDIS_URL` (or `REDIS_TLS_URL`) | ✅ boot gate | From 1.2 |
| `SECRETS_MASTER_KEY` | ✅ (secrets at rest) | `openssl rand -base64 32` |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_APP_SECRET` | ✅ for messaging | Meta app → WhatsApp settings (Phase 0) |
| `ONBOARDING_PHONE_NUMBER_ID` / `ONBOARDING_WA_TOKEN` | optional | Platform intake number (w9 agentic onboarding); unset = feature off |
| `PAYSTACK_SECRET_KEY` / `PAYSTACK_WEBHOOK_SECRET` | ✅ for payments | Paystack live dashboard (0.7–0.9) |
| `ERROR_WEBHOOK_URL` | optional | Alert sink for platform error notifications |
| `CONFIRM_BACKUP` | operational | Not a service var — required in the shell env to run `scripts/migrate-prod.ts` non-dry-run (see 2.1) |
| `RATE_LIMIT_WEBHOOK_PER_MIN` / `RATE_LIMIT_AUTH_PER_MIN` / `RATE_LIMIT_API_PER_MIN` | optional | Edge limiter overrides (defaults 300 / 10 / 600) |

## Phase 2 — Deploy & migrate

| # | Item | Owner | Notes / exit criteria |
|---|------|-------|-----------------------|
| 2.1 | Run production migrations | Platform | ① Fresh backup verified (1.1). ② `npx tsx scripts/migrate-prod.ts --dry-run` — review pending SQL. ③ `CONFIRM_BACKUP=yes npx tsx scripts/migrate-prod.ts`. The runner holds a `pg_advisory_lock`, applies one transaction per migration, stops on first error with resume instructions, and verifies the journal↔ledger state post-apply. |
| 2.2 | Boot-gate expectations | Platform | Service starts clean; any `[ENV] FATAL` = missing Phase-1.5 var — fix and redeploy, never bypass. |
| 2.3 | Health verification | Platform | `GET /health` 200 (liveness) and `GET /health/ready` deep readiness green, incl. `/api/health/postgres` and `/api/health/redis`. These endpoints are rate-limit exempt — probe freely. |
| 2.4 | Smoke suite | Platform | `scripts/staging-e2e.ts` (wave-10 H2) green against the deployed environment. |
| 2.5 | Webhook signature checks | Platform | Send a bad-signature POST to each webhook — expect rejection (fail-closed in prod), not 200. |

## Phase 3 — First-tenant pilot

| # | Item | Owner | Notes / exit criteria |
|---|------|-------|-----------------------|
| 3.1 | Onboard ONE friendly tenant | Platform + Tenant | Low volume; tenant knows they are the pilot. |
| 3.2 | Watch observability outputs | Platform | Webhook dedupe ledger, integration outbox, error webhook (`ERROR_WEBHOOK_URL`), and rate-limit headers (`X-RateLimit-*`) during normal traffic. |
| 3.3 | Messaging-tier behavior | Platform | Confirm sends stay within the current Meta tier (0.5); watch quality rating daily. |
| 3.4 | Live dunning/repayment check | Tenant + Platform | Run a real dunning cycle with SMALL real amounts through Paystack; verify webhook → reconciliation → ledger end-to-end. |

## Phase 4 — Scale-out

| # | Item | Owner | Notes / exit criteria |
|---|------|-------|-----------------------|
| 4.1 | Tenant onboarding waves | Platform | Add tenants in waves (not all at once); re-run Phase-3 checks per wave at reduced intensity. |
| 4.2 | Rate-limit tuning | Platform | Watch 429 rates per bucket. Webhooks need headroom for Meta/Paystack retries; tighten auth only if abuse appears. Override via `RATE_LIMIT_*_PER_MIN`. Multi-node deploys MUST have Redis (in-memory fallback is single-node only). |
| 4.3 | Bundle monitoring | Platform | Track client bundle size/API latency per release; investigate regressions before the next wave. |
| 4.4 | Backup-restore drill cadence | Platform | **Weekly** restore rehearsal per RUNBOOK_ROLLBACK.md; log drill results. |

## Rollback triggers & steps

Trigger an immediate rollback (RUNBOOK_ROLLBACK.md) when ANY of:

- Post-migration verification fails or the migrator stops mid-run twice.
- `/health/ready` red for >5 minutes after deploy.
- Webhook signature verification rejecting legitimate Meta/Paystack traffic.
- Payment reconciliation divergence on the pilot tenant (Phase 3.4).
- Meta quality rating drops a tier during a scale wave (4.1) — pause onboarding.

Exact steps, backup restore procedure, and migration-resume instructions:
[RUNBOOK_ROLLBACK.md](./RUNBOOK_ROLLBACK.md); migration resume instructions are
also printed by `scripts/migrate-prod.ts` at the point of failure.
