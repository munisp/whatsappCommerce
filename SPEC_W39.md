# SPEC_W39 — Remediation: platform/security P0s (W36 verified audit)

Base: main @ c99a27fbb37f6a5cb7e6942dc37c49ff7126e95e (post-W38). BINDING. Sources: /mnt/agents/output/w36/p0-verification.md (PLT-1/2/3/4/8, PAY-8), audit-platform.md, audit-payments.md (PAY-8 row).

## Global invariants
- paymentConfirm.ts PINNED (md5 2f77ea4816d1adc5cb35473bd35d1697). Additive-only schema; hand-written migrations 0122+ (journal re-chain after 0121). Lockfiles FROZEN. Banner edits. Honest-status doctrine. Journeys continue numbering after 262 (merger owns final count). Fast-fail after 2 attempts per step.

## Coder A — data durability (PLT-1, PLT-2, PLT-8)
1. k8s/postgres.yaml: replace emptyDir with PVC (volumeClaimTemplates via StatefulSet conversion OR standalone PVC+Deployment — choose minimal-change path, document); resource requests honest for dev overlay.
2. k8s/tigerbeetle.yaml: same — PVC for TB data file.
3. Backups: pg_dump CronJob (nightly, gzip, to PVC-backed backup volume or existing object-storage env if present — READ env.example first for S3 vars; wire retention 7d honest) + TB backup doc/script (tb is copy-on-write friendly — file copy job or documented offline copy). Add k8s CronJob manifests (numbering continues from existing 41/42).
4. Journeys: manifests parse + PVC references exist (static yaml assertions, js-yaml if available); backup cron schedule valid; honest-degrade if no object storage configured.
Branch w39/durability.

## Coder B — web security (PLT-3, PLT-4)
1. PLT-3 CSRF: session cookie SameSite policy — read current cookie setup; implement CSRF defense compatible with existing clients: SameSite=Lax where possible + Origin/Referer check middleware for cookie-authenticated mutating requests (allowlist: webhook paths, server-to-service internal calls with internal token, tRPC batch from same-origin). Journeys: cross-origin POST with cookie -> 403; same-origin OK; webhook unaffected.
2. PLT-4 Medusa SSRF: route Medusa baseUrl through the EXISTING ssrfGuard/assertSafeOutboundUrl used by Odoo/customHttp (find it; reuse, no new dep); tenant config update path validates before persist AND at call time (defense in depth); admin API key never sent to unvalidated host. Journeys: tenant sets baseUrl=http://169.254.169.254/... -> rejected at update + at call.
Branch w39/websec.

## Coder C — chargeback/refund webhooks + J111 (PAY-8, MSG-adjacent debt)
1. PAY-8: _core/index.ts PSP webhook handler (L860-972 area) — chargeback/dispute events: create dispute record (new migration 0122 `payment_disputes`: tenant_id, order_id, provider, provider_ref, kind chargeback|dispute, amount_cents, status open|won|lost|accepted, payload jsonb, timestamps), debit-on-lost semantics documented, admin WhatsApp alert, order flagged; refund.processed/refund.failed webhooks: reconcile refund_attempts/refund rows (from W38) — processed confirms, failed marks + alerts; unknown event types still 200-ack but LOGGED with structured event (no silent drop). Journeys: chargeback creates dispute + alert; refund.processed closes attempt; refund.failed triggers alert; unknown type acked + logged.
2. J111 quiet-hours fix: READ the J111 journey + win-back code; reproduce reasoning from merge logs (it fails standalone on base). Fix ROOT CAUSE (likely timezone/quiet-hours boundary logic), not the test. If truly unfixable without spec ambiguity, document and leave — do not blind-rewrite.
Branch w39/webhooks.

## Merger (reuse warm coder)
Order A→B→C. Journal re-chain (0122 after 0121). Journey count = actual. Full gate: tsc 0 / vitest 0 fail / sim N+N / authz / pin md5 / lockfiles unchanged / no empty files / no conflict markers. merge-log + merged tree rsync. Publish by lead via fast path.
