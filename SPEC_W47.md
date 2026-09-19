# SPEC_W47 — Onboarding Robustness: Merchant + Individual Stakeholders

Source audits (read your assigned file FIRST, every finding has file:line evidence + fix sketch):
- /mnt/agents/output/w47/audit-merchant.md — 18 findings (5 P0)
- /mnt/agents/output/w47/audit-buyer.md — 13 findings (2 P0)
- /mnt/agents/output/w47/audit-stakeholders.md — 16 findings (1 P0)
- /mnt/agents/output/w47/audit-crosscutting.md — 15 findings (1 P0)

Total: 62 findings (9 P0). Mandate: fix ALL. IDs are contracts — journeys must reference them.

## Global invariants (binding)
- paymentConfirm.ts md5 2f77ea4816d1adc5cb35473bd35d1697 — adjacent seams only.
- Additive-only schema; hand-written migrations with journal idx+prevId chaining + cumulative snapshots (FULL column union).
- Integer cents; claim-first FOR UPDATE money guards; idempotency keys; fail-closed money, fail-open telemetry.
- Channel parity: every chat-facing change works on BOTH WhatsApp + Telegram via channelSender/notifyCustomer; channelParity categories.
- Banner edits `// === W47 <topic> ===`. No TEMP STUB. No empty files. Lockfiles untouched.
- Journeys lazy-import; runner ordered; simulation.test.ts count = actual (merger-owned).
- env.example.txt updated for any new env var. Audit-log every security-relevant onboarding transition.

## Coder A — Merchant go-live & lifecycle (audit-merchant.md, 18 findings)
Branch w47/merchant. Migrations 0163-0164. Journeys J427-J436.
Key fixes: ONB-M-1 KYB gate (or remove) legacy onboarding.complete; ONB-M-2 copilot goLive must enforce requireApprovedKyb same as web activate; ONB-M-3 OnboardingWizard real API wiring or honest removal (no fake verify/toast go-live); ONB-M-5 + M-8 lifecycle gate on paid order intake (draft/trial tenants cannot receive paid orders; KYB-expired/rejected live tenants stop new orders with buyer-facing honest message); all P1s/P2s in the file.
NOTE: ONB-M-4 (chat tenant has no owner login) is owned by Coder D (same root as ONB-SM-1) — do NOT touch onboardingCopilot owner bootstrap; coordinate seam = D exposes `bootstrapTenantOwner()` you may call in goLive if present.

## Coder B — Buyer identity & consent (audit-buyer.md, 13 findings)
Branch w47/buyer. Migrations 0165-0166. Journeys J437-J446.
Key fixes: ONB-B-1 age-gate must COMPARE captured digits to requiredAge (truthful minor must FAIL; attestedAge = actual digits; ratchet stays); ONB-B-2 recycled-number protection on chat surface (identity epoch / verification challenge before exposing order history or tracking); ONB-B-3 consent gate covers interactive buttons, media/AI-scan, CTWA, location on BOTH channels (fix WA/TG parity inversion); ONB-B-4 TG "NO" must follow the WA J1 contract (limited service, not silent drop); ONB-B-6 WA+TG identity merge wired into session/order/consent paths + waPhoneNumber column too short for telegram:<chat_id> keys (schema widening migration); consent proofWamid populated + real policy version; KYB-block buyer messaging with remediation path; erasure coverage (consents/sessions/messages/media) + post-erasure re-onboarding clean slate.

## Coder C — Membership & stakeholder rails (audit-stakeholders.md + ONB-TOK-1 from crosscutting, 17 findings)
Branch w47/stakeholders. Migrations 0167-0168. Journeys J447-J456.
Key fixes: ONB-S-1 (P0) role-change guard fires on ANY owner downgrade/removal not just grants — step-up OTP required, sole-owner protected; staff invite/acceptance flow (no arbitrary userId add; existence check + notification; no phantom memberships); ONB-S-3/TOK-1 tenantInvite.resend preserves boundPhone + audit row; invite revocation endpoint; ONB-S-8 vendor payee vetting (structured payee fields, editable-window lock pre-payment, vendor dedup, KYB tier for payout recipients); ONB-S-11 agent self-dealing guards (self-order exclusion, commissionBps cap, payout-phone change step-up); ONB-S-14 users.phone uniqueness strategy (dedup + conflict-safe OTP verify + login resolution); referral refund wallet clawback; capability gates fail-closed on lookup error.

## Coder D — Cross-cutting security & bootstrap (audit-crosscutting.md minus TOK-1, 14 findings)
Branch w47/crosscutting. Migrations 0169-0170. Journeys J457-J466.
Key fixes: ONB-ID-1 deviceAuth mandatory second factor policy for phone-only accounts + deviceHash required path (no silent legacy bypass — flag-gated with env var documented); ONB-ABU-1 intake-number metering + quota + fake-tenant factory throttle (unauthenticated flood must hit caps); ONB-ID-2 CAS/unique constraint for nlpSessions + onboardingSessions creation (race → single winner); ONB-SM-1/ONB-M-4 bootstrapTenantOwner() — chat-copilot tenant creation MUST create owner user + membership + governed recovery path (phone-bound invite auto-minted to adminPhone); ONB-I18N-1 onboarding/consent/age prompts translated through i18n.ts locales (at least en + ha + yo + ig + fr as existing catalog supports); remaining P2s.

## Merger (after A-D push)
Merge all 4 branches into w47-merged; re-chain journal 0162→0170; cumulative snapshots union; runner order J427-J466; simulation.test.ts count=actual; transcripts regen; full gate: tsc 0 / full vitest 0 fail / full sim N/N / authz 8/8 / md5 pin / lockfiles / TEMP STUB 0 / empties / journal chain / env.example. Push w47-merged; write merge-log.md; message lead.
