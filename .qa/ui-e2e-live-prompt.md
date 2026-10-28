# WhatsApp Commerce — TOTAL End-to-End Test Brief (live deployment, every actor · channel · action)

> **Audience:** a Claude Code session (or senior tester) with browser + HTTP automation, tasked with testing
> the **deployed** system at **https://wa-app.newfire.app** *completely* — every role, every channel, every
> action (UI, conversational, REST/webhook, scheduled, workflow), every permission, every integration — and
> delivering a release-readiness verdict. This is PRODUCTION; read §0 first. Repo is at
> `~/Documents/whatsappCommerce` (branch `development`) — inspect it to drive the exhaustive matrices in §4.

---

## 0. PRODUCTION SAFETY (non-negotiable)
- **Non-destructive by default.** Reads/navigation/validation freely. Any *write* (create product/order,
  send a message, move money, trigger a job) happens **only inside the `QA Test Tenant`** (owner
  `qa-owner@newfire.app`) or against **throwaway data you created**. Never mutate, disable, or delete real
  tenants, real users, real payment configs, or real money.
- **Never fire scheduled/cron/internal endpoints or Temporal workflows that act on ALL tenants** against prod
  unless you can scope them to QA Test Tenant. For those, assert behavior from code + logs/DB, or ask first.
- **No load/stress/chaos** on prod. **No credential changes** to real accounts. **No real outbound** (WhatsApp
  sends, emails, payouts) beyond QA Test Tenant / sandbox.
- **Prove every claim** with evidence (screenshot, console, network trace, DB/ledger read). Never report a
  green you didn't observe; never fabricate. Distinguish **product defect** vs **environment/config**.
- If an action could be irreversible or touch real users/money, **STOP and ask**.

---

## 1. ACTORS / ROLES (complete taxonomy — test every one)
Global `users.role` enum: `user`, `admin`, `operator`, `analyst`. Tenant membership roles
(`tenant_memberships.role`): `owner`, `operator`, `finance`, `analyst`. Plus non-DB actors.

1. **Platform admin** (`users.role=admin`) — cross-tenant everything (`/platform-admin/`, `adminProcedure`).
2. **Tenant owner** (membership `owner`) — full tenant control incl. owner-only approval policy, payouts, staff.
3. **Operator** (membership `operator`) — day-to-day ops + money moves, not owner-only policy.
4. **Finance** (membership `finance`) — money procedures (payouts/refunds/invoices; `moneyProcedure`).
5. **Analyst** (membership/`role=analyst`) — read/analytics; **never** money movement.
6. **Buyer / customer** — primarily **WhatsApp + Telegram** (conversational), plus token pages
   (`/track/:token`, `/evidence/:token`) and public storefront. NOT a web-dashboard login.
7. **Driver** — the `/driver` app, authenticated by a **signed driver token** (`drivers.signup` + OTP).
8. **Supplier / retailer (B2B)** — wholesale listings/orders, procurement, trade credit, manufacturer programs.
9. **Staff/invited user** — magic-login invite (`tenantInvite` → `/tenant-portal/portal/login#token=`).
10. **Internal / service** — `internalProcedure` (INTERNAL_API_KEY), the **cron/scheduler** caller, the
    **Temporal worker**, the **recon-worker**, **fluvio-consumer**, ledger-bridge. (System actors — verify
    they enforce auth and do the right thing; don't run tenant-wide jobs on prod blindly.)
11. **Unauthenticated / public** — storefront, public catalog, token portals, webhook senders (Meta/Paystack/…).

For each human role: confirm it sees only its permitted surfaces/actions, and that **every restricted action is
denied server-side** (not just a hidden button). Build the full role × action matrix in §4/§7.

---

## 2. CHANNELS (complete — the product is multi-channel, not just web)
1. **Web — main app** (`/`, served by the `server` deploy).
2. **Web — tenant/merchant portal** (`/tenant-portal/`).
3. **Web — platform admin** (`/platform-admin/`, admin-gated).
4. **WhatsApp conversational** (inbound webhook `/api/webhooks/whatsapp`, Meta Cloud API out).
5. **Telegram conversational** (`/api/webhooks/telegram/:tenantId`).
6. **USSD-style menus** (the `nlp`/`menu` engine — numbered menus, i18n: en/fr/sw/ha/ig/yo/pcm…).
7. **Driver web app** (`/driver`, token).
8. **Token-gated portals** — `/track/:token`, `/evidence/:token`, `/api/sla-extension/:token`,
   magic-login, CTWA QR (`/api/ctwa/:tenant/:campaign.png`).
9. **Public storefront / catalog** (unauthenticated reads).
10. **REST / webhook ingress** (§4b), **scheduled/cron** (§4c), **Temporal workflows** (§4d).

---

## 3. ACCOUNTS & HOW TO DRIVE EACH CHANNEL
**Web (SSO):** https://wa-app.newfire.app → **Sign In** → Keycloak (`keycloak-servers.newfire.app`, realm
`wacommerce`) → email + **`QaTest@2026`**. One browser context per role (cookie session after SSO).

| Email | Role | Surface |
|---|---|---|
| `qa-admin@newfire.app` | platform admin | `/platform-admin/` |
| `qa-owner@newfire.app` | owner (QA Test Tenant) | `/tenant-portal/portal` |
| `qa-operator@newfire.app` | operator | `/tenant-portal/` |
| `qa-finance@newfire.app` | finance | `/tenant-portal/` |
| `qa-analyst@newfire.app` | analyst | `/tenant-portal/` |

**Buyer (conversational):** two ways — (a) the **`simulation/` harness** (605 scripted journeys, the canonical
buyer+merchant behavior spec) run locally against a test stack; (b) against the live QA tenant, drive a real
WhatsApp/Telegram number bound to QA Test Tenant (only if one exists — do NOT hijack a real tenant's number).
**Driver:** `drivers.signup` + OTP → token → `/driver`. **Staff invite:** `tenantInvite.create` → magic link.
**Auth model:** Keycloak `sub` → `users.openId`; role on `users.role`, tenant role in `tenant_memberships`.

---

## 4. THE COMPLETE ACTION SURFACE (enumerate — don't sample)
Backend census (from code): **~1,052 tRPC procedures across 139 routers** —
publicProcedure q42/m26 · internalProcedure m19 · protectedProcedure q331/m395 · operatorProcedure q7/m22 ·
analystProcedure q26/m1 · moneyProcedure q4/m57 · adminProcedure q63/m58.

**Produce the full matrix.** For every procedure, test: valid call (expected effect + DB/ledger persistence),
each role (allowed vs FORBIDDEN/UNAUTHORIZED), invalid/boundary/malformed input, idempotency. Generate the list:
```
# every procedure, its router, guard type, and query/mutation:
grep -rnE '^\s+[a-zA-Z0-9_]+:\s*(public|internal|protected|operator|analyst|money|admin)Procedure' server/routers/*.ts
```

### 4a. tRPC routers — all 139 (each has its own procedures; enumerate them all)
agent · ai · alertRules · analytics · analyticsBI · apisix · approvals · arInvoices · audit · b2b · bookkeeping ·
broadcast · broadcastAb · bureau · buyerCredit · cashflow · catalogAI · catalogBootstrap · channels · cod ·
cogsDispute · compliance · consents · conversation · copilot · credit · creditFacilities · creditInsurance ·
creditRepay · creditScoring · creditServicing · crm · ctwa · customers · delivery · deliveryReceipts · drivers ·
embedded · embeddedSignup · erpProvision · escalation · escrow · events · evidencePortal · exchanges · fineTune ·
fraudCase · fxPayouts · geo · giftCards · groupBuy · heartbeat · hermes · i18n · infra · integrations ·
inventory · inventoryDepth · invoice · journeys · keycloak · kyc · labelStudio · logistics · loyalty ·
manufacturerPrograms · marketplace · medusa · medusaOnboarding · membership · membershipPlans · menu · metering ·
mlOps · mobileMoney · nlp · notifications · odoo · odooMedusaBridge · odooSync · onboarding · onboardingCopilot ·
onboardingProgress · onboardingStaff · operatorTemplates · orchestrator · order · orderCrud · payment ·
paymentGateway · payments2 · phoneAuth · privacy · procurement · product · productImages · promos · provisioning ·
quickReplyTemplates · receiptScan · reconciliation · recurringRules · report · revenue · reviews · rma · savings ·
search · serviceCommerce · shopifyIntegration · sla · slaExtension · storefront · taxStatements · taxonomy ·
telemetry · template · templateVersions · temporal · temporalInternal · tenant · tenantAnalytics · tenantConfig ·
tenantInvite · tenantPortal · tracking · tradeCredit · twenty · ucDocs · ucMoney · vendorBills · viCorrections ·
visualInventory · w44SubscriptionsPins · waTemplates · webhookDlq · whatsappMedia · whatsappNotifications · wholesale

### 4b. Webhook ingress (11) — verify signature fail-closed + correct processing
`/api/webhooks/paystack` · `/escrow-bank` · `/flutterwave` · `/payments/:provider` · `/mobile money (via these)` ·
`/medusa` · `/medusa-catalog` · `/medusa-fulfillment` · `/shopify` · `/shipbubble` · `/telegram/:tenantId` ·
`/whatsapp` (GET verify + POST). For each: missing/invalid signature → 401/403 (fail-closed); valid →
correct state change; replay → idempotent (no double effect).

### 4c. Scheduled / cron (61 endpoints) — cron-authed; verify logic, scope to QA tenant or assert from code+DB
`/api/scheduled/*` (generate-invoices, approvals-expiry, broadcast-dispatch/-scheduler, escrow-auto-confirm,
execute-payments, dispute-deadline-sweep, credit-score-refresh, credit-loan-repayment, installment-due,
inventory-expiry/-reservation-sweep, inventory-sync, cart-recovery, cashflow-forecast, forecast-snapshot,
ar-reminders, bureau-report, bandit-reward-tick, bookkeeping-digests, delivery-summary, drift-alert,
float-income, hermes-health-snapshot/-po-expiry, integration-outbox-dispatch, ab-test-metrics, …) and
`/api/cron/*` (orphan-tenant-sweep, webhook-dedupe-sweep). Also `/api/internal/*` (events, recon-settlements,
sweeps, wa-ops-alert) — INTERNAL_API_KEY gated. Confirm each requires its key/cron auth and is idempotent.

### 4d. Temporal workflows (4) — exercise + verify idempotency/recovery
TenantOnboardingWorkflow · OrderFulfillmentWorkflow · InventorySyncWorkflow · BroadcastCampaignWorkflow
(started via `temporal.*` procedures). Verify: start, activity retries, timeout/cancel, worker crash recovery,
no duplicate side effects.

### 4e. Health/observability — `/health`, `/health/ready`, `/api/health/{postgres,redis,tigerbeetle,kafka,
fluvio,dapr,keycloak,permify,opensearch,mojaloop}`, `/api/metrics`. Note which deps are healthy per run.

---

## 5. CONVERSATIONAL CHANNEL (the core product) — WhatsApp / Telegram / USSD
Drive the bot ("Mifi") end to end. The canonical spec is the repo's **`simulation/` suite: 605 journeys
(J1–J607)** covering: greeting/consent/language-picker, USSD menus + i18n (en/fr/sw/ha/ig/yo/pcm), shop →
cart → checkout → address → pay, order tracking, support/handoff, disputes, refunds, savings/stokvel
contribute/payout/voucher, credit/BNPL, geo "near me" discovery, deterministic-vs-LLM routing, Telegram parity,
offline queue/sync. Run them (`npm run simulate -- <Jxxx ...>` locally) and, where a real test number is bound
to QA Test Tenant, replay representative flows live. Verify each produces the right DB/ledger/event effect —
not just a plausible reply. (Known-fixed, regress: J565 French USSD menu, J560 Telegram stokvel parity.)

---

## 6. CROSS-CHANNEL END-TO-END WORKFLOWS (run fully in QA Test Tenant)
Shop→order→pay(Paystack `charge.success`, HMAC-SHA512; **async confirm** — poll the ledger)→**escrow**→payout ·
dispute→merchant respond→evidence(`/evidence/:token`)→admin review(`/platform-admin/escrow`)→resolution ·
refunds (full/partial, retry-idempotent, after-payout clawback, bulk, cap) · approvals (over-threshold →
owner-only policy) · onboarding/KYB + provisioning (Medusa/Twenty/Odoo/channel/payment) · broadcast (template →
approval → campaign → A/B winner) · COD→assign driver→driver status(own only)→escrow hook→buyer tracking ·
credit/BNPL/trade-credit/savings · inventory (adjust/reserve/visual-VLM/depth/batch/expiry) · invoices/recurring/
scheduled-payments. For **each**: happy path · invalid/boundary input (inline validation, no crash) · failure &
recovery (dependency down, provider error, replay) · idempotency (double-submit → one effect) · cross-role
consistency (what role A changes, role B sees correctly, in UI **and** DB).

---

## 7. AUTHZ / TENANT ISOLATION / RBAC (full matrix, UI + API)
- Non-admin → any `/platform-admin/*` → "Platform admins only"; analyst → money mutation → FORBIDDEN.
- Tenant-A actor → any Tenant-B resource/id (UI nav or direct tRPC/REST call) → FORBIDDEN/not-found, never B's
  data. Test resource-id IDOR on orders, escrow, products, templates, disputes, wallets, invoices.
- Token/JWT tampering (bad sig, expired, swapped openId) → UNAUTHORIZED. Webhook/internal without key → 401.
- Server must enforce even when the UI hides the control (call the endpoint directly with each role's session).

## 8. DATA / LEDGER / EVENTS / INTEGRATIONS
- **Persistence:** after each write, confirm the row(s) in Postgres; reload → survives.
- **Ledger:** TigerBeetle double-entry; `ledger_transfers` status; recon `/recon/trigger` → **0 discrepancies**
  for healthy committed payments (no false positives), real ones flagged.
- **Events:** domain events publish to **hyphenated** Fluvio topics (`wacommerce-orders`,…) consumed by
  `fluvio-consumer` → `POST /api/internal/events`. (Kafka publish is vestigial.)
- **Email/docs:** notifications/email-to-case via the configured sink; uploads (KYB/product/evidence) to object
  storage, per-tenant only.
- **Integrations:** Medusa/Odoo/Twenty/Shopify/Hermes/Flutterwave/ShipBubble/mobile-money — real calls or an
  honest "not configured" state (never a silent failure or a crash).
- **API hygiene:** clean JSON errors; no stack traces in prod; 500s generic (no filesystem paths); security
  headers present (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy); no `x-powered-by`.

## 9. UI/UX · responsiveness · accessibility · performance
Zero uncaught console errors / unhandled rejections per flow; no unexpected 4xx/5xx (failures show a user
message, not a broken state); every nav/button does something; responsive ≤414px (mobile-first, Nigeria);
keyboard focus/labels/contrast/ARIA; sane loading/empty/error states; first-paint not blank.

## 10. KNOWN DEPLOY STATE (verify)
Fixed & should be LIVE: SPA white-screen (admin+portal render), revenue/analytics/escrow 500s, Fluvio topic
names, baseline security headers, recon false-positive. Still your job to **confirm each live**. Separate
open issue: the WhatsApp bot not replying = expired Meta Cloud API token (integration/config, not UI).
Treat any "all green" self-audit doc with skepticism — verify, don't trust.

## 11. TEST DATA · PROD SAFETY · CLEANUP
Prefix everything you create with `qa-`/`QA`. Keep all merchant-side writes inside **QA Test Tenant**. Record
which dependencies were up per result (ML/Fluvio/Keycloak/Paystack/Medusa/Odoo/Twenty). Delete throwaway
records after; don't leave half-finished money/approval flows. Don't run tenant-wide scheduled jobs on prod.

## 12. REPORT (release-readiness)
Deliver one report: (1) scope — actors/channels/surfaces covered, environment, dependency status, browser/
viewport; (2) **coverage matrices** — role×route, role×procedure (all ~1,052), channel×workflow, webhook/cron/
workflow — each cell PASS/FAIL/BLOCKED/UNVERIFIED with one line of evidence; (3) **bug reports** (id, title,
severity **and** priority, affected roles/features/channel, exact repro, expected vs actual, evidence, root
cause, product-vs-env); (4) RBAC/isolation findings; (5) coverage gaps + why; (6) overall **GO / NO-GO** with
the top blockers, written for a non-engineer. Rank most-severe first; every claim backed by captured evidence.
```
# quick coverage counters to include:
# routers: ls server/routers/*.ts | grep -v .test | wc -l
# procedures: grep -rcE 'Procedure' server/routers/*.ts | ...   (and the enumerator in §4)
# webhooks / scheduled / temporal: see §4b/§4c/§4d ; journeys: ls simulation/journeys | wc -l
```
