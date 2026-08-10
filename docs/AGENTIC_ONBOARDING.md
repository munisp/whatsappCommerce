# Agentic Onboarding Copilot (Wave 9)

**Status:** shipped — PRs #67–#70, main @ `f9e71981`, verifier gate PASS 12/12
(1,379 tests / 0 failed, tsc clean, build green, 38/38 simulation regression)

Tenant onboarding driven by an AI copilot instead of forms: describe the business in
natural language — in the admin portal **or by messaging the platform's own WhatsApp
number** — and a tool-calling agent proposes the full configuration, a human approves
each artifact, the agent applies it, validates live credentials, repairs failures, and
takes the tenant live. Also ships tenant brand-kit generation and WhatsApp
business-profile branding.

---

## 1. Why

Form-based onboarding took ~30 minutes and assumed the owner knew what a WABA, a use
case, or an integration mapping was. The copilot reduces time-to-live to **one
conversation**, while every consequential action remains behind a human approval
checkpoint enforced in code.

## 2. Architecture

```
Admin portal chat (C4)                WhatsApp platform number (C3)
        │                                     │  ONBOARDING_PHONE_NUMBER_ID
        ▼                                     ▼  (additive webhook branch, env-gated)
        └──────────────►  Onboarding Copilot (C1)  ◄──────────────┘
                          tool-calling agent loop on the shared LLM client
                          state machine: intake→proposing→approving
                                         →configuring→validating→live|failed
                          CHECKPOINT INVARIANT: apply/pushProfile/goLive
                          refuse without an approved proposal (service layer)
                                │                    │
                ┌───────────────┘                    └───────────────┐
                ▼                                                    ▼
   tenantConfig APIs (waMenu, use-cases,        Brand studio (C2)
   branding, integrations — wave-4/5)           generateBrandKit: seeded monogram
                                                logo (≤45% HSL enforced), palette,
   Validation-repair loop:                      tagline; env-gated AI image provider
   validationFailureReasons →                   pushWhatsappProfile: about/description/
   targeted questions, 3-round cap              address/photo → Graph business profile
```

## 3. Components

### 3.1 Copilot core — `server/services/onboardingCopilot/` (PR #70)
- **Tools**: `extractIntake`, `proposeWaMenu` (zod-validated against the waMenu
  contract), `proposeUseCases`, `proposeBranding`, `proposeIntegrations`,
  `applyProposal`, `pushProfile`, `runValidation`, `goLive`
- **Checkpoint invariant** (`session.ts` `assertProposalApproved`; `tools.ts:437/456/552`):
  proposals are created freely by the agent; **apply, profile push, and go-live throw
  unless approved**; edited payloads are zod re-validated and replace the original;
  goLive additionally requires `validating` + `validationPassed`
- **Repair loop** (`repair.ts`): maps validation failure reasons to targeted questions
  ("your token can't read the WABA — re-paste it from Meta Business Settings"), max 3
  rounds → `failed`
- **Idempotency** (`index.ts:144-147`): exact-repeat inbound = no-op (Meta redeliveries)
- **Supersession**: new session for a phone abandons the prior active one (audited)
- **Terminal `goLive` proposal** emitted on validation pass; literal `"go live"` text
  also honored; goLive proposals are not editable
- LLM-down **template fallbacks** — the flow never dead-ends; audit entry per
  transition/tool/apply

### 3.2 Brand studio — `server/services/brandStudio/` (PR #69)
- `generateBrandKit`: deterministic monogram (FNV-1a seeded, unicode initials), palette
  with **saturation clamped ≤45% HSL** on every output, template taglines; optional AI
  image provider (`IMAGE_GEN_API_KEY`/`OPENAI_API_KEY`, safe-default OFF, silent
  monogram fallback)
- `pushWhatsappProfile`: Graph v21.0 — about (≤139, word-boundary clamp), description,
  address, vertical; profile photo via Meta's resumable-upload handle flow
  (raster-only guard); per-field `pushed[]`/`failed[]`; **never throws**
- Branding schema extended additively: `secondaryColor`, `tagline`, `waProfileAbout`,
  `logoGeneratedAt` (old settings JSON still parses)

### 3.3 WhatsApp intake — `server/services/waOnboarding.ts` (PR #68)
- One additive webhook branch: `phone_number_id === ONBOARDING_PHONE_NUMBER_ID` →
  copilot intake keyed by sender phone; env unset ⇒ predicate always false, tenant
  dispatch untouched (verifier-audited)
- Renders copilot replies: text → WhatsApp text; cards → interactive buttons
  (`onb_approve:<id>` / `onb_edit:<id>`), >3 actions → numbered-list fallback
- Edit flow: rejects the stale proposal, feeds the user's free text back for re-draft
- Voice notes transcribed when configured; restart/start-over anytime; fail-safe
  friendly message on copilot errors (webhook always 200s)

### 3.4 Admin UI — `client/src/pages/OnboardingCopilot.tsx` (PR #67)
- Chat thread (typing indicator, auto-scroll, system lines), kind-specific proposal
  previews (waMenu / brand kit with logo / use-cases / integrations), Approve-Reject
  vs Edit routed to the correct endpoints (edits shallow-merge to stay schema-complete),
  validation checklist with repair guidance, go-live button wired to the terminal
  `goLive` proposal, success panel, resume banner; brand panel in Tenant Settings shows
  the generated logo + WhatsApp-profile push status

## 5. Schema (additive)
- `media_assets` (0045) — generated brand assets per tenant
- `onboarding_sessions` (0046) — channel, phone, state machine, transcript, proposals
  (JSON: kind/summary/payload/status), intake facts, error

## 6. Security & safety invariants (verifier-audited with file:line)
1. Checkpoint enforcement in the **service layer** (not the prompt) — refusal tested
2. Edited payloads zod re-validated before store; goLive gate double-checked
3. All 6 router procedures `protectedProcedure` + tenant access assertions
4. Onboarding envs optional — never in the prod boot gate; feature inert when unset
5. WA profile push + brand kit never throw; no new secret storage (reuses waSender
   credential resolution); zero new dependencies
6. Idempotent message handling; session supersession audited; every apply audited

## 7. Verification
- Independent verifier @ `f9e71981`: **PASS 12/12** — 1,379 tests (exact arithmetic),
  checkpoint/idempotency/isolation citations, no-new-deps diff, migration chain,
  38/38 simulation regression
- Simulation journeys **J39–J44** (separate PR): WhatsApp full onboarding → live,
  edit path, checkpoint guard, validation-repair + 3-round failure, idempotency/resume/
  restart, admin-channel path

## 8. Configuration
| Env | Purpose |
|---|---|
| `ONBOARDING_PHONE_NUMBER_ID` | Platform WhatsApp intake number (unset = feature off) |
| `ONBOARDING_WA_TOKEN` | Token for the intake number |
| `IMAGE_GEN_API_KEY` / `OPENAI_API_KEY` | Optional AI logo provider (monogram fallback) |
| `WHATSAPP_APP_ID` | Needed for profile-photo upload handle |

## 9. Roadmap hooks
- Multilingual copilot intake (leverage wave-5 i18n packs)
- Product-catalog bootstrap from price-list photos (visual search pipeline exists)
- Abandoned-session nudger (72h sweeper)
- Copilot-driven *ongoing* configuration ("add a loyalty program") beyond onboarding
