# SPEC_W40 — Remediation: tenancy + messaging P0s (W36 verified audit)

Base: main @ a44298e16ec1f41069b7f5a8c1a122e9d8e56de0 (post-W39). BINDING. Sources: /mnt/agents/output/w36/p0-verification.md + audit-tenancy.md + audit-messaging.md.

## Global invariants
- paymentConfirm.ts PINNED (md5 2f77ea4816d1adc5cb35473bd35d1697). Additive-only schema; hand-written migrations 0123+ (journal after 0122). Lockfiles FROZEN. Banner edits. Journeys continue after 271 (merger owns count; NO duplicate IDs — coordinate ranges below). Fast-fail after 2 attempts. Push incrementally (/home/kimi can be wiped).

## Coder A — tenant enforcement + hijack fixes (TEN-1, TEN-3, TEN-11, TEN-4)
Journeys J272–J276.
1. TEN-1: enforce tenants.status — suspended/churned tenants blocked at (a) tRPC auth context creation (fail-closed 403 tenant_suspended), (b) WhatsApp webhook dispatcher (drop + structured log + no processing), (c) Telegram webhook (W37 path), (d) cron/service-account paths that act "as tenant" where a guard exists. Read sdk.ts/trpc.ts/webhook dispatch first; place ONE shared assertTenantActive helper + call sites. Journeys: suspended tenant API 403, WA inbound dropped, reactivated tenant works.
2. TEN-3: whatsappPhoneNumberId uniqueness — migration 0123: partial unique index on tenants(whatsapp_phone_number_id) WHERE not-null (verify column name; additive; if existing dupes possible in prod, index is still safe — dedupe doctrine documented); updateWhatsAppConfig pre-check with honest CONFLICT error; same for telegram botUsername (W37 added check — verify index too). Journeys: duplicate claim rejected; hijack scenario blocked.
3. TEN-11: marketplace.registerSeller — remove arbitrary tenantId public registration: require authenticated merchant context (protectedProcedure, own tenant only) + KYB-passed gate; bank details validation. Journey: public arbitrary-tenant registration rejected.
4. TEN-4: admin cross-tenant audit — writeAuditLog calls added to tenant/kyc/membership/tenantInvite/marketplace admin mutation paths (reuse existing audit util — find it); actor, action, targetTenant, before/after summary. Journey: admin cross-tenant action writes audit row.
Branch w40/tenancy.

## Coder B — privacy + KYC depth (TEN-5, TEN-8)
Journeys J277–J280.
1. TEN-5: KYC docs in GDPR scope — locate erasure/export implementation; extend to KYC document scans (S3 keys) + OCR text: erasure deletes/anonymizes S3 objects (or schedules deletion with tombstone + honest doc if immediate delete impossible), export includes doc metadata + OCR text. Migration 0124 if tombstone/queue table needed. Journeys: erasure covers KYC artifacts; export includes them.
2. TEN-8: sanctions depth — extend screening beyond business name: UBO/director fields on KYB profile (migration 0125 additive: ubo_name, ubo_dob nullable, pep_declared bool), screened through the SAME fail-closed screening path; ongoing re-screen: add periodic re-screen to existing sweep/cron (schedule + journaled last-screened-at). Honest scope note: screening provider capability unchanged — we add fields + cadence, not a new data vendor. Journeys: UBO fields screened; re-screen sweep updates timestamp; fail-closed preserved.
Branch w40/privacy.

## Coder C — messaging compliance + resilience (MSG-1, MSG-2, MSG-3 + template status)
Journeys J281–J285.
1. MSG-1: STOP honored mid-conversation — nlp.ts inbound path (and Telegram already revokes — verify parity): route text messages matching STOP/unsubscribe keywords (existing parseConsentReply — reuse) through consent revocation BEFORE bot reply generation; suppressed-reply confirmation message per Meta policy; honor on all subsequent inbound. Journeys: STOP mid-conversation revokes + bot silent thereafter; resubscribe via opt-in keyword.
2. MSG-2: template-status webhooks — handle message_template_status_update (REJECTED/PAUSED/DISABLED): mark template in waTemplates store (migration 0126 additive status column if absent), block campaign sends using dead templates with honest error + admin alert. Journey: REJECTED webhook disables template; campaign skips it.
3. MSG-3: broadcast circuit breaker — campaign-level failure threshold (e.g. >20% failures after min 20 sends -> pause campaign, mark paused_reason, admin WhatsApp alert, resume procedure documented). Reuse broadcast router; additive columns if needed (same 0126). Journey: failing campaign auto-pauses + alerts.
Branch w40/messaging.

## Merger (reuse warm coder)
Order A→B→C. Journal 0123→0124→0125→0126 re-chain (only migrations actually created). Journey count = actual (no dup IDs). Full gate: tsc 0 (8GB) / vitest 0 fail / sim N+N / authz / pin / lockfiles unchanged / no empties / no markers. merge-log + merged tree. Lead publishes via fast path.
