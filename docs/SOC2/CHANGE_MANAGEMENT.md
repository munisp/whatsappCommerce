# Change Management Policy (SDLC)

This policy reflects the **actual** repository process; it is descriptive first,
prescriptive second.

## 1. Change workflow

1. **Branch & PR.** All changes land on `main` via pull request. Direct pushes
   to `main` are not permitted.
2. **CI gates (blocking)** — `.github/workflows/ci.yml`:
   - `npx tsc --noEmit` — full typecheck must be 0 errors.
   - `npx vitest run` — unit/integration suite (baseline: 2812 passed /
     7 skipped / 184 files) must stay green.
   - `npm audit --omit=dev --audit-level=high` — production dependency audit,
     blocking at high.
   - CV-stack job — Python CV tests, Go orchestrator build, Rust
     post-processor check.
3. **Non-blocking signal** — `scripts/soc2-check.ts` runs in CI with
   `continue-on-error: true`: control drift is surfaced without blocking
   delivery; a FAIL requires a follow-up issue.
4. **Review.** At least one reviewer. Security-relevant files (below) require a
   reviewer from the security owner group.

## 2. Protected / invariant code

- `server/services/paymentConfirm.ts` — payment confirmation invariant.
  **Byte-identical across waves** unless a dedicated security-reviewed change
  is opened for it alone. Presence is asserted by `scripts/soc2-check.ts`.
- Authz ratchet: new or modified tenant-relevant tRPC procedures must include
  a tenant guard or a parsed `// authz:exempt <reason>` marker; enforced by
  `server/routers/__tests__/authzCoverage.test.ts` — a failing ratchet blocks CI.

## 3. Database migration discipline

- Schema lives in `drizzle/schema.ts`; migrations in `drizzle/`.
- **Additive-only**: new tables/columns must be nullable or defaulted; no
  destructive changes (drop column/table, tighten NOT NULL) in the same
  release as code that depends on the change.
- Migrations run via `scripts/migrate-prod.ts`; rollback per
  `docs/RUNBOOK_ROLLBACK.md`.
- Schema changes ship with tests where behavior changes (see e.g.
  `server/services/manufacturerPrograms.migration.test.ts`).

## 4. Environment & secret handling

- Secrets are injected via environment variables only; `env.example.txt`
  contains placeholders, never real values (checked by `scripts/soc2-check.ts`).
- No secrets in client bundle, logs, or tests. Rotations documented in the
  deployment log.

## 5. Emergency changes

For `critical` incidents (see `INCIDENT_RUNBOOK.md`): an expedited PR with a
single reviewer is allowed, but CI must still pass. A retroactive review note
is attached to the incident postmortem.

## 6. Traceability

- PRs reference the wave/task they implement; CI history + merge commits are
  the system of record for change authorization.
- The hash-chained audit log (`server/services/auditChain.ts`, verifiable via
  `compliance.verifyAuditChain`) records privileged runtime actions; it is
  checked on the SOC2 dashboard (`/soc2`).
