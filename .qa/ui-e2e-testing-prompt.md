# WhatsApp Commerce — Full UI End-to-End Testing Brief (for an executing Claude session)

> **Audience:** a Claude Code session (or human tester) with browser automation, tasked with testing the
> **entire** WhatsApp Commerce application end-to-end — every role, feature, workflow, permission, and
> integration — against a **running** instance. This brief is tailored to *this* codebase, not a generic
> checklist. Paste it into a fresh session that has the repo at `~/Documents/whatsappCommerce` checked out.

---

## 0. Prime directive & non-negotiables

1. **Do NOT assume a feature works because its UI renders.** For every action, verify the *effect*: the
   expected response, the **data actually persisted** (query Postgres / TigerBeetle), the event emitted, and
   that the **whole workflow** completes across the relevant roles. A page that loads is step one, not a pass.
2. **Verify cross-role consistency.** When role A changes state (e.g. a merchant marks an order shipped),
   confirm role B (buyer/admin) sees the correct, consistent result — in the UI *and* in the DB.
3. **Distinguish defects from environment/config.** A failure because a dependency (Keycloak, ML, Fluvio,
   Paystack) isn't running is an **environment note**, not a product bug — but you must say which, with
   evidence. Never report a green result you didn't observe. Never fabricate screenshots or logs.
4. **Investigate every failure** to a root cause before filing it; give a reproducible repro.
5. **Use realistic test data** (Nigerian phone numbers `+234…`, NGN amounts in kobo, real-looking product
   names). Clean up what you create (see §11).
6. **Secrets:** pull any real credentials from the repo's env/config or deployment docs; in local/test mode
   there are **no passwords** (you mint session tokens — see §3). **Never print a real secret** (Keycloak
   client secret, Paystack live key, DB password) into the report — reference it by name only.

---

## 1. Understand the app first (Phase 0 — inspect before testing)

Read these before touching the running app; build your own route×role×feature matrix from them:

- **Frontends (3 separate Vite+React apps):**
  - `client/src/App.tsx` — the main app, served at **`/`**. Buyer-facing-merchant + operator pages.
  - `ui/tenant-portal/src/App.tsx` — merchant/tenant portal, base **`/tenant-portal/`**.
  - `ui/platform-admin/src/App.tsx` — platform admin, base **`/platform-admin/`**, gated `role === "admin"`.
  - Pages live in each app's `src/pages/`. Shared layouts/guards: `client/src/components/*Layout.tsx`,
    `client/src/appShell.guards.test.ts`, `client/src/_core/hooks/useAuth.ts`.
- **Backend:** `server/_core/index.ts` (Express + tRPC mount at `/api/trpc`, REST webhooks, health, static
  serving of the 3 built UIs), `server/routers/*.ts` (**142 tRPC routers** — the feature surface),
  `server/_core/trpc.ts` (procedure types + guards), `server/_core/sdk.ts` (auth), `server/kafka.ts`
  (domain-event publish → Fluvio).
- **Auth/roles:** `server/_core/trpc.ts` (`assertTenantAccess`, `assertMoneyAccess`, `tenantRoleProcedure`,
  `adminProcedure`, `moneyProcedure`), `server/_core/sdk.ts` (`authenticateRequest`), `shared/const.ts`
  (`COOKIE_NAME = "app_session_id"`).
- **DB:** `drizzle/schema.ts` (tables), `drizzle/*.sql` (migrations). Models of note: `users`,
  `tenants`, `tenant_memberships`, `orders`, `order_items`, `payment_intents`, `escrow_transactions`,
  `escrow_disputes`, `ledger_transfers`, `whatsapp_templates`, `products`, `customers`, `conversations`.
- **Integrations:** TigerBeetle (via `rust/ledger-bridge` + `services/tb-adapter`), recon (`rust/recon-worker`),
  Fluvio events (`services/fluvio-consumer`, topics are **hyphenated** `wacommerce-orders` etc.), Paystack
  (webhooks in `server/_core/index.ts`), Keycloak (SSO), Dapr pub/sub, Medusa/Odoo/Twenty connectors, ML
  (`services/ml-stack`).
- **Existing tests (reuse their helpers + patterns):** `simulation/` (605 scripted journeys J1–J607 — the
  canonical behaviour spec), `tests/e2e/` (dockerized stack + `helpers/stack.ts` with `seedUser`,
  `mintPlatformSession`, `trpcQuery/Mutation`), `tests/e2e/_idor-poc.ts` / `_load-burst.ts` /
  `_blackbox-probe.ts` / `_webhook-async-probe.ts` / `_fluvio-topic-probe.ts` (manual probes), and the QA
  record `.qa/reports/test-run-2026-10-27.md` (**read it — it lists already-found bugs to re-verify, §10**).

---

## 2. Bring the app up (environment prerequisites + start commands)

Everything runs locally without the slow Docker image builds (proven recipe):

```bash
cd ~/Documents/whatsappCommerce
# 2.1 Infra (prebuilt images)
docker run -d --rm --name wc-pg    -e POSTGRES_USER=wc_user -e POSTGRES_PASSWORD=wc_secret \
  -e POSTGRES_DB=whatsapp_commerce -p 5432:5432 postgres:16-alpine
docker run -d --rm --name wc-redis -p 6379:6379 redis:7-alpine redis-server --save "" --appendonly no
# (For money/ledger UI flows ALSO run real TigerBeetle + adapter + ledger-bridge + recon-worker —
#  see .qa/reports/test-run-2026-10-27.md "LEDGER CHAOS" section for the exact local recipe.)

# 2.2 Schema
DATABASE_URL="postgres://wc_user:wc_secret@127.0.0.1:5432/whatsapp_commerce" npx drizzle-kit migrate

# 2.3 Build the 3 UIs (platform serves them statically) — REQUIRED for UI testing
npm run build        # vite build x3 (dist/public, dist/platform-admin, dist/tenant-portal) + server bundle
#   (or, for live-reload dev: `npm run dev:platform-admin` / `dev:tenant-portal` vite servers alongside the API)

# 2.4 Boot the platform (serves API + the built UIs on :3000)
NODE_ENV=test PORT=3000 \
  DATABASE_URL="postgres://wc_user:wc_secret@127.0.0.1:5432/whatsapp_commerce" \
  POSTGRES_URL="postgres://wc_user:wc_secret@127.0.0.1:5432/whatsapp_commerce" \
  REDIS_URL="redis://127.0.0.1:6379" JWT_SECRET="e2e-jwt-secret" INTERNAL_API_KEY="e2e-internal-key" \
  PAYSTACK_WEBHOOK_SECRET="e2e-paystack-webhook-secret" APP_URL="http://localhost:3000" \
  npx tsx server/_core/index.ts
# Ready when GET http://localhost:3000/api/health/postgres → {"online":true}
```

- `NODE_ENV=test` relaxes fail-closed guards (prints warnings) and uses the HS256/Bearer auth path instead of
  requiring a live Keycloak. ML/Dapr/Fluvio degrade gracefully (logged warnings) — note which features need them.
- **Base URLs:** app `http://localhost:3000/`, tenant portal `…/tenant-portal/`, platform admin
  `…/platform-admin/`. If the built dirs are missing, §2.3 wasn't run (the server logs "Could not find build
  directory").
- Prefer **chromium/Playwright** or the in-app browser for driving + screenshots + console/network capture.

---

## 3. Authentication & how to log in as each role (CRITICAL — read fully)

**Model:** the session JWT carries only `{ openId, appId: "wacommerce", name }` (HS256, signed with
`JWT_SECRET`). The server (`sdk.ts authenticateRequest`) resolves the caller's **role and tenantId from the DB
`users` row**, not from the token. It accepts the session three ways: `wa_session` cookie, an
`Authorization: Bearer <jwt>` header, or the legacy `app_session_id` cookie.

**Real login flows (test these too, §6):**
- **Magic-login** (merchant staff invite): `/tenant-portal/portal/login#token=<INVITE_JWT>` → calls
  `tenantInvite.validate`, stores a session at `localStorage["portal_session_token"]`. Generate a real invite
  via the `tenantInvite.create` procedure (as an owner/admin).
- **SSO / Keycloak:** `/tenant-portal/portal/sso-callback?code=…&state=…` (PKCE). Needs a live Keycloak;
  if absent, note it and use token injection below.
- **Phone OTP** (drivers, phone-first users): `ui/platform-admin …/phone-auth` and the WhatsApp OTP flow —
  `phoneAuth.sendOtp({purpose:"login"})` + device fingerprint. OTP is delivered via WhatsApp (mock/log in test).
- **Driver app:** `/driver` — authenticates with a signed driver token from `drivers.signup` + OTP.

**Fast deterministic login for the test matrix (no password, works in NODE_ENV=test):**
1. **Seed a user per role** (reuse `tests/e2e/helpers/stack.ts` `seedUser`), e.g. via a tiny tsx script:
   - platform admin: `seedUser({ openId:"qa-admin", name:"QA Admin", role:"admin" })`
   - tenant owner: seed `role:"user"` with `tenantId:"<TENANT_A>"`, **plus** a `tenant_memberships` row
     `(tenantId:"<TENANT_A>", userId:<id>, role:"owner")` (owner/operator/finance are *membership* roles —
     required for `moneyProcedure`/`operatorProcedure`). analyst membership for read-only money views.
   - second tenant `role:"user"` + membership in `<TENANT_B>` (for cross-tenant isolation tests).
   - buyer/customer: interacts via the WhatsApp/Telegram simulator, not the web UI (see `simulation/`).
2. **Mint a session token** for each: `mintPlatformSession(openId)` (HS256 `{openId,appId,name}`).
3. **Inject it into the browser before loading a page** (the tRPC client at `client/src/main.tsx` reads it):
   ```js
   sessionStorage.setItem("manus-cookie", "app_session_id=" + MINTED_JWT);
   ```
   Then navigate. `auth.me` resolves the seeded user's role/tenant and the app renders that role's shell.
4. Tenants/products/orders referenced by the UI must exist in the DB — seed them (SQL or via the create
   procedures) so pages have real data. A tenant row is needed before a `tenant_memberships` row (FK).

**Expected deny behaviour to assert:** no/garbage/forged-signature token → `UNAUTHORIZED`; a non-admin at any
`/platform-admin/*` route → blocked (the `allow={user=>user.role==="admin"}` gate); a tenant-A user acting on
tenant-B resources → `FORBIDDEN`/not-found; analyst invoking a money mutation → `FORBIDDEN`.

---

## 4. Roles & permissions (build the matrix from code; here's the spine)

| Role (how set) | Where | Can do |
|---|---|---|
| **Platform admin** (`users.role="admin"`) | `/platform-admin/*` + admin redirects from `/` | Everything, cross-tenant: tenants, onboarding, KYB, escrow, reconciliation, revenue, ML-ops, audit logs, webhook DLQ, alert rules, SSO users, service health, agent console |
| **Tenant owner** (membership `owner`) | `/tenant-portal/*`, `/` merchant pages | Full tenant management incl. approval **policy** (owner-only), wallet/payouts, settings, staff invites, all money moves |
| **Operator** (membership `operator`) | tenant portal | Day-to-day ops: orders, inventory, conversations, approvals (approve/reject), money moves — but NOT owner-only policy |
| **Finance** (membership `finance`) | tenant portal | Money procedures (payouts/refunds/invoices) per `moneyProcedure` |
| **Analyst** (membership `analyst` / `users.role="analyst"`) | tenant portal (read) | Read/analytics; **never** money movement |
| **Buyer/customer** | WhatsApp/Telegram + token pages | Shop, order, pay, track (`/track/:token`), submit evidence (`/evidence/:token`), review-by-token |
| **Driver** | `/driver` | Go online/offline, update location, advance delivery status (own deliveries only) |
| **Supplier/retailer** (B2B) | tenant portal sales-channels | Wholesale listings/orders, procurement, trade credit |

Confirm each role sees only its permitted nav items/pages and that restricted actions are blocked in the UI
**and** server-side (try the direct route + the direct tRPC call).

---

## 5. Route × role matrix (exercise every route; not a loading check)

Extract the full list from the three `App.tsx` files. Key routes:

- **Platform admin (`/platform-admin/`)**: `/tenants`, `/tenants/:id`, `/tenant-analytics`, `/onboarding`,
  `/tenant-menus`, `/sso-users`, `/phone-auth`, `/whatsapp-profile`, `/alert-rules`, `/health`,
  `/infra-health`, `/system-health`, `/compliance`, `/soc2`, `/kyb-review`, `/escrow`, `/reconciliation`,
  `/revenue`, `/ml-ops`, `/webhook-dlq`, `/audit-logs`, `/agent`, `/nlp-simulator`, `/hermes`,
  `/cogs-disputes`, `/logistics`, `/logistics-map`, `/credit-facilities`, `/deploy-checklist`.
- **Tenant portal (`/tenant-portal/`)**: `/portal` (dashboard), `/portal/wallet`, `/portal/analytics`,
  `/portal/setup`, `/products`, `/inventory`, `/menu-builder`, `/sales-channels`, `/medusa`, `/suppliers`,
  `/crm`, `/journeys`, `/consents`, `/cod`, `/procurement`, `/credit-accounts`, `/supplier-approvals`,
  `/manufacturer-credit`, `/conversations`, `/multi-channel`, `/broadcast`, `/templates`, `/wa-templates`,
  `/integration-health`; public-token: `/track/:token`, `/evidence/:token`, `/sla-extension/:token`,
  `/portal/magic-login`, `/portal/sso-callback`.
- **Main app (`/`)**: `/dashboard`, `/products`, `/conversations`, `/orders`, `/orders/:orderNumber`,
  `/cod`, `/delivery`, `/driver`, `/loyalty`, `/reviews`, `/payments`, `/scheduled-payments`,
  `/recurring-rules`, `/approvals`, `/escalations`, `/inventory`, `/inventory-depth`, `/buyer-credit`,
  `/credit-scores`, `/bureau`, `/returns`, `/credit-facilities`, `/credit-insurance`, `/integrations`,
  `/templates`, `/template-versions`, `/broadcast`, `/journeys`, `/consents`, `/invoices`, `/portal`,
  `/track/:token`. (Admin-only pages here redirect to `/platform-admin`.)

For each: load as the intended role (expect render + real data), load as a wrong role (expect block/redirect),
and exercise every control on the page (§6).

---

## 6. Features & end-to-end workflows (the heart — run these fully, verify persistence + events)

For every form/button/modal/table/filter/upload/toggle/notification, do the action, then **verify the effect
in the DB and (where relevant) the ledger/events**. Priority end-to-end journeys:

1. **Shop → order → pay → escrow → payout.** Create a product (merchant) → place an order (buyer sim) →
   `payment.initiate` → deliver the signed Paystack `charge.success` webhook (`POST /api/webhooks/paystack`,
   HMAC-SHA512 with `PAYSTACK_WEBHOOK_SECRET`) → confirm the **escrow hold** and that **TigerBeetle** balances
   move (reserve→commit) → merchant payout/withdrawal → wallet reflects it. **Note:** the webhook acks
   `{received:true}` and confirms **asynchronously** (~sub-second) — poll the ledger, don't expect a synchronous
   `{ok,action}`.
2. **Dispute & evidence.** Buyer raises a dispute → merchant responds → evidence upload via
   `/evidence/:token` (token-gated) → admin review in `/platform-admin/escrow` → resolution → ledger effect.
3. **Refund paths (W38).** Full/partial refund, refund retry idempotency, refund-after-payout clawback,
   bulk refund, refund cap. Verify no double refund; recon shows no discrepancy afterward.
4. **Approvals.** Over-threshold money action → queued for approval → owner/operator approves/rejects →
   state transition + money effect only on approve. (Policy set is **owner-only**.)
5. **Onboarding / KYB.** Tenant onboarding wizard (`/platform-admin/onboarding`), provisioning
   (Medusa/Twenty/Odoo/channel/payment), KYB document review (`/kyb-review`). Verify each step persists and
   gates the next.
6. **Broadcast & templates.** Create a WhatsApp template → submit for approval → build a broadcast campaign →
   simulate delivery → A/B test winner selection. Verify audience filtering + per-tenant isolation.
7. **COD / delivery / driver.** COD order → assign driver → driver app updates status (own delivery only) →
   escrow hook fires → buyer tracking page updates.
8. **Credit / BNPL / trade credit / savings (stokvel).** Buyer credit accept/repay, credit scoring, bureau
   pull/consent, trade-credit account approval + repayment, savings circle contribute/payout/voucher.
9. **Inventory.** Manual adjust, reserve/release, visual inventory (image upload → VLM count → apply to
   stock — needs ML; note if absent), depth/warehouse/batch/expiry.
10. **Integrations.** Medusa product import/push, Odoo sync, Twenty CRM sync, integration-health page.
    Verify real calls or honest "not configured" states.
11. **Invoices / recurring / scheduled payments.** Generate invoice → pay → mark paid; schedule/cancel/retry
    a scheduled payment; recurring rules.

For **each** workflow test: the happy path, an **invalid-input** path (empty/negative/huge/unicode/malformed —
expect inline validation, not a crash), a **failure/recovery** path (dependency down, provider error, replay),
and **idempotency** (double-submit → single effect).

---

## 7. RBAC / access-control (do it in the UI, not just the API)

The API-level isolation was already proven (`tests/e2e/_idor-poc.ts`: 11/11). Re-exercise through the UI:
- Log in as tenant-A operator; manually navigate to a tenant-B resource URL / call a tenant-B-scoped action →
  expect `FORBIDDEN`/not-found, never tenant-B data.
- Log in as analyst; attempt a money mutation (payout/refund/approval) → expect `FORBIDDEN`.
- Log in as a non-admin; open any `/platform-admin/*` route directly → expect block/redirect.
- Tamper the injected token (wrong signature, expired, swapped openId) → expect `UNAUTHORIZED`, no access.
- Confirm the **server** enforces even if the UI hides a control (call the tRPC endpoint directly with the
  role's token).

---

## 8. Backend / data / integration verification

- **Persistence:** after each UI action, query Postgres (`docker exec wc-pg psql -U wc_user -d
  whatsapp_commerce -c "…"`) and confirm the row(s). Re-login / reload → state survives.
- **Ledger:** money flows must reconcile — TigerBeetle double-entry balances, `ledger_transfers` status
  (`committed`/`voided`/`reversed`), and `recon-worker` `/recon/trigger` reporting **0 discrepancies** for
  healthy traffic (a completed payment whose transfer is committed must NOT be flagged).
- **Events:** domain events publish to **hyphenated** Fluvio topics (`wacommerce-orders`, `-payments`,
  `-conversations`, `-inventory`, `-hermes-po`); the Kafka publish is vestigial (no consumer). If Fluvio
  isn't running, note dropped-event features; don't call it a product bug unless the topic names regress.
- **Webhooks:** Paystack/escrow-bank webhooks must **fail closed** on missing/invalid HMAC signature (401).
- **Email:** staff email / email-to-case / notifications — verify via the configured sink (Mailpit or logs
  in test); confirm no real send in test mode.
- **Document processing:** uploads (KYB docs, product images, evidence) store to object storage (MinIO) and
  are retrievable per-tenant only.
- **API contract:** tRPC errors should be clean JSON; in `NODE_ENV=production` no stack traces (fixed this
  session — see §10). 500s return a generic message, never a filesystem path.

---

## 9. UI/UX, responsiveness, accessibility, console/network

- **Console:** zero uncaught errors / unhandled rejections during each flow (capture them).
- **Network:** no unexpected 4xx/5xx; failed requests surface a user-facing message, not a blank/broken state.
- **Broken links / dead controls:** every nav item resolves; every button does something observable.
- **Responsiveness:** test phone (≤414px), tablet, desktop — no horizontal scroll, no clipped controls (this
  is a Nigeria-first, mobile-heavy product).
- **Accessibility:** keyboard navigation + visible focus, form labels, color-contrast, `alt` text, ARIA on
  modals/tables. Note WCAG issues.
- **Loading/empty/error states:** each async view shows a sensible loading, empty, and error state.

---

## 10. Known issues to re-verify (from this session's QA — see `.qa/reports/test-run-2026-10-27.md`)

All six were **fixed**; confirm they stay fixed (regression):
1. French USSD/menu i18n (J565) and Telegram "stokvel" keyword parity (J560).
2. recon-worker reconciled completed payments against the wrong id — now checks the `ledger_transfers` row;
   verify `/recon/trigger` reports 0 discrepancies for healthy committed payments.
3. Error-handler path leak (#4) — non-500 responses must NOT echo filesystem paths (`/api/<unknown>` → 404
   `{"message":"Not found"}`).
4. tRPC stack-trace leak (#5) — in a production-mode build, error bodies must have no `stack`.
5. Fluvio topic-name mismatch (#6) — producer now publishes hyphenated topics; confirm events reach the
   consumer (or note Fluvio absent).

Also treat the self-audit docs with skepticism: this repo has a history of inflated "all green" claims —
**verify, don't trust.**

---

## 11. Test data, setup, cleanup, dependencies

- **Seed** via `tests/e2e/helpers/stack.ts` helpers or direct SQL; use a distinct prefix (e.g. `QA-`,
  `qa-<role>`) for everything you create so cleanup is a single `DELETE … WHERE … LIKE 'QA%'`.
- **Dependencies by feature:** core UI/CRUD needs only pg+redis+platform; money/escrow/ledger needs
  TigerBeetle+adapter+ledger-bridge+recon; SSO needs Keycloak; visual inventory/fraud/credit-ML needs
  `services/ml-stack`; async events need Fluvio; Medusa/Odoo/Twenty need those services or honest
  "not configured" handling. Record which were up for each result.
- **Cleanup:** delete seeded users/tenants/orders/templates and any injected `sessionStorage`. Tear down
  containers (`docker rm -f wc-pg wc-redis …`). Do NOT leave the stack running.
- **Isolation:** same-account concurrent runs can clash (password/session resets); give each role its own
  seeded account.

---

## 12. Required deliverable — the report

Produce a single report with:
1. **Scope & environment** — commit hash, which services were running, browsers/viewports, how auth was done.
2. **Test matrix executed** — role × route × feature, each with **PASS / FAIL / BLOCKED / UNVERIFIED** and
   one line of evidence (what you observed + the DB/ledger check).
3. **Bug reports** — for each defect: id, title, severity (critical/high/medium/low) **and** priority,
   affected **roles + features**, exact **reproduction steps**, expected vs actual, supporting
   screenshot/console/network/DB evidence, and suspected root cause (and whether it's a product defect vs an
   environment/config issue).
4. **RBAC findings** — any unauthorized access or privilege escalation (in UI or via direct API).
5. **Coverage gaps / UNVERIFIED** — what couldn't be tested and why (missing dependency, no data, etc.).
6. **Overall release-readiness assessment** — a clear go / no-go with the top blocking issues, written so a
   non-engineer stakeholder can act on it.

Rank bug reports most-severe first. Keep every claim backed by evidence you actually captured.
