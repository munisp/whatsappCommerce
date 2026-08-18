# Platform Admin — route triage

All routes reuse existing page components from `client/src/pages` (via the
`@` alias) — nothing was copied or duplicated. This file records the triage
decisions from splitting the original single-app `client/src/App.tsx` (94
routes) into `ui/platform-admin` and `ui/tenant-portal`.

## Basis for the split

`client/src/components/DashboardLayout.tsx` already had a partial answer:
its nav config marks one group (`Administration`) as `adminOnly: true`,
gated by `role === "admin"`. Every route in that group landed here, plus
routes that are unambiguously platform infrastructure by name/purpose
(ML Ops, Reconciliation, Webhook DLQ, Audit Log(s), Label Studio, Scan
Stats, Integration Health, Supplier Approvals). Everything else — including
routes that were in the *same* nav but not admin-gated — went to
`ui/tenant-portal`, since the original engineer apparently intended those
visible to any authenticated user.

## `/admin` (AdminPortal) is the app's home page

`AdminPortal.tsx` is described in its own header comment as a "Unified Admin
Management Portal" covering integrations, user/tenant management, infra
health, Temporal, APISIX, Keycloak sync, reconciliation, and audit logs —
overlapping significantly with several of the standalone pages below (e.g.
`/infra-health`, `/audit-log(s)`, `/reconciliation`). It's plausible some of
those standalone pages are superseded by AdminPortal's tabs; not verified in
this pass, so both are kept reachable.

## Genuinely ambiguous placements (best guess, flag if wrong)

- `/setup` (CredentialWizard), `/phone-auth`, `/whatsapp-profile` — placed
  here because they were inside the legacy nav's `adminOnly` group, which
  reads as "platform admin configuring a tenant's WhatsApp credentials on
  their behalf," not the tenant's own self-service setup (that's
  `/portal/setup` in tenant-portal).
- `/onboarding` (TenantOnboarding) — admin-initiated tenant provisioning
  (uses `adminProcedure`-gated flows), distinct from the self-service
  `onboarding.start` path now used by `/onboarding-wizard` in tenant-portal.
- `/unified-onboarding` — unclear whether this is an admin tool or another
  tenant self-service onboarding variant; placed here on the "unified admin
  tooling" naming pattern, not confirmed.
- `/cogs-disputes` — grouped with reconciliation/finance-ops by name; could
  plausibly be tenant-facing.

## Not yet done: full `adminProcedure` audit

Several endpoints these pages call are still gated by the platform-only
`adminProcedure` even where a Tenant Super Admin should arguably have
access (e.g. `tenant.getWhatsAppConfig`/`updateWhatsAppConfig`). See the
note left in the main conversation — reclassifying those to
`tenantAdminProcedure` is a separate pass across ~40 routers, not attempted
here.
