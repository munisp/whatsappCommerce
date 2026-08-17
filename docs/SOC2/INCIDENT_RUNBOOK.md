# Incident Response Runbook

## 1. Severity definitions

Severities match the `incidents` table enum (`drizzle/schema.ts`) and the
rollup shown on the SOC2 dashboard (`/soc2`).

| Severity | Definition | Examples | Response SLA |
|---|---|---|---|
| `critical` | Money movement incorrect, tenant data exposed cross-tenant, platform-wide ordering down | paymentConfirm invariant violation; authz bypass; WhatsApp webhook signature failure | Page on-call immediately; mitigate ≤ 1h |
| `high` | Major function degraded for one or more tenants, no data loss/exposure | payment provider outage; webhook DLQ growing; CV stocktake pipeline down | Ack ≤ 30m; mitigate ≤ 4h |
| `medium` | Limited impact, workaround exists | single-tenant config issue; delayed broadcasts; reconciliation mismatch | Ack ≤ 4h; resolve ≤ 3d |
| `low` | Cosmetic / no customer impact | UI glitch; doc drift | Next sprint |

## 2. Status lifecycle

`open` → `investigating` → `mitigated` → `resolved`
(matches `incidents` table statuses and `compliance.incidentStatus` rollup).

## 3. Triage steps

1. **Detect** — alert rules (`server/routers/alertRules.ts`), health pages
   (`/system-health`, `/infra-health`), audit-chain verification failure,
   or external report.
2. **Record** — create an incident row (title, severity, status `open`).
   Never delete incident rows; correct by update.
3. **Classify** — assign severity per §1. If money or cross-tenant data is
   involved, it is at least `high`.
4. **Contain** — feature-flag or disable the affected path (see
   `docs/RUNBOOK_ROLLBACK.md`); pause payouts/repayment links if funds flow
   is suspect (`server/services/paymentConfirm.ts`,
   `server/services/creditRepayLink.ts`).
5. **Investigate** — pull audit trail (`client/src/pages/AuditLogViewer.tsx`;
   run `compliance.verifyAuditChain` to confirm log integrity before trusting
   it), check webhook DLQ (`/webhook-dlq`), check tenant scope.
6. **Mitigate → Resolve** — ship fix through normal change management
   (`CHANGE_MANAGEMENT.md`); hotfixes still require PR + green CI (expedited
   review allowed for `critical`).
7. **Postmortem** — required for `critical` and `high` (template §5).

## 4. Communication templates

### Internal (on ack)
```
[INCIDENT][{severity}] {title}
Status: open → investigating
Impact: {tenants/functions affected}
Lead: {name}   Next update: {time ≤ 1h}
Tracking: incident #{id} (see /soc2 dashboard)
```

### Tenant-facing (if tenant impact)
```
We are aware of an issue affecting {function} on the platform.
Status: {status}. Impact: {what merchants see}.
Workaround: {if any}. Next update by {time}.
Reference: INC-{id}.
```

### Resolution note
```
[RESOLVED] {title} (INC-{id})
Root cause: {one line}. Fix: {PR link}.
Customer impact window: {start}–{end}.
Follow-ups tracked in postmortem.
```

## 5. Postmortem template

```markdown
# Postmortem: INC-{id} {title}

- Severity: {critical|high}
- Window: {openedAt} → {resolvedAt}
- Lead: {name}

## Summary
## Impact (tenants, orders, funds)
## Timeline (detection → mitigation → resolution)
## Root cause
## What went well
## What went poorly
## Action items (owner, due date) — each must map to a control in TSC_CONTROL_MATRIX.md
```
