# WhatsApp Commerce — LIVE UI End-to-End Testing Brief (deployed app + real accounts)

> **Audience:** a Claude Code session (or tester) with browser automation, testing the **deployed** app at
> **https://wa-app.newfire.app** end-to-end — every role, feature, workflow, permission, integration — using the
> real Keycloak test accounts below. This is the live/production system, so READ §0 before anything.

## 0. This is PRODUCTION — safety first
- **Non-destructive by default.** Read, navigate, and validate. For any *write* (create product/order, send
  broadcast, move money), **use only the `QA Test Tenant`** (owner `qa-owner@newfire.app`) — never touch real
  tenants' data. As platform admin, do NOT edit/disable/delete real tenants, real users, real payment configs.
- **No load/stress/chaos** against prod. No seeding scripts. No credential changes to real accounts.
- **Distinguish defect vs environment/config**, and **never report a green you didn't observe**. Capture
  evidence (screenshot, console, network, and — where you can read it — the DB/ledger effect).
- If an action looks irreversible or could affect real users/money, **stop and ask** rather than proceed.

## 1. Accounts (Keycloak realm `wacommerce`, password `QaTest@2026`)
Log in at **https://wa-app.newfire.app → "Sign In"** → you're redirected to `keycloak-servers.newfire.app` →
enter the email + password → back to the app. (Verified working for admin + owner.)

| Email | Role | Primary surface |
|---|---|---|
| `qa-admin@newfire.app` | Platform admin | `https://wa-app.newfire.app/platform-admin/` |
| `qa-owner@newfire.app` | Owner of **QA Test Tenant** | `/tenant-portal/portal` |
| `qa-operator@newfire.app` | Operator (QA Test Tenant) | `/tenant-portal/` |
| `qa-finance@newfire.app` | Finance (QA Test Tenant) | `/tenant-portal/` |
| `qa-analyst@newfire.app` | Analyst / read-only (QA Test Tenant) | `/tenant-portal/` |

Auth model (for reasoning about failures): the Keycloak login maps to a `users` row by the Keycloak `sub`;
**role** is on that row (`admin`) and **tenant role** is in `tenant_memberships` (owner/operator/finance/
analyst). Use one browser context per role; sessions are cookie-based after SSO.

## 2. What to test (per role) — exercise, don't just load
Walk every nav item and control for each role. Key surfaces:
- **Platform admin (`/platform-admin/`)**: tenants, tenant-analytics, onboarding, KYB review, SSO users,
  phone-auth, alert-rules, service/infra/system health, compliance, escrow, **reconciliation**, **revenue**,
  ml-ops, webhook-DLQ, audit-logs, agent console, nlp-simulator, hermes, cogs-disputes, logistics,
  credit-facilities, deploy-checklist.
- **Tenant portal (`/tenant-portal/`)**: portal dashboard, wallet, analytics, setup, products, inventory,
  menu-builder, sales-channels, medusa, suppliers, crm, journeys, consents, cod, procurement,
  credit-accounts, supplier-approvals, conversations, broadcast, templates, integration-health.
- **Main app (`/`)**: dashboard, products, orders, order timeline, cod, delivery, driver, loyalty, reviews,
  payments, scheduled-payments, approvals, escalations, inventory, buyer-credit, returns, integrations,
  invoices.

For each page: does it render with real data? Do its controls produce the expected effect (and persist on
reload)? Any console errors / failed `/api/trpc` calls (4xx/5xx)?

## 3. End-to-end workflows (run in QA Test Tenant)
Shop→order→pay→escrow→payout · dispute+evidence(`/evidence/:token`) · refunds (full/partial/idempotent) ·
approvals (owner-only policy) · onboarding/KYB · broadcast+templates · COD+driver · credit/BNPL/savings ·
inventory adjust/reserve · integrations (Medusa/Odoo/Twenty — real or honest "not configured"). For each:
happy path, invalid input (expect inline validation, not a crash), failure/recovery, idempotency (double-submit
→ one effect). **Note:** the Paystack `charge.success` webhook acks `{received:true}` and confirms the ledger
**asynchronously** (~sub-second) — poll, don't expect a synchronous result.

## 4. RBAC (in the UI)
- Non-admin at any `/platform-admin/*` → must show **"Platform admins only"** (not the admin console).
- Analyst → any money action → denied ("requires Finance capability" / FORBIDDEN).
- `qa-owner` (Tenant A) must never see another tenant's data; try navigating to an out-of-tenant resource.
- Confirm the **server** enforces even when the UI hides a control (the deny must come from the API, not just
  a hidden button).

## 5. Known state of THIS deployment (verify / expect)
- **Fixed & live:** the platform-admin + tenant-portal **white-screen** (they render now). Regress this first.
- **May still be present depending on deploy timing — report if seen:** admin **Revenue** dashboard 500
  (`revenue.summary`/`gmvLeaderboard`), tenant-analytics MoM 500, escrow wallet date-filter 500; recon-worker
  flagging healthy payments as discrepancies; **missing security headers** (no HSTS/CSP/X-Frame-Options/
  X-Content-Type-Options) and `x-powered-by: Express`; the WhatsApp bot not replying (expired Meta token —
  an integration/config issue, not a UI bug).
- Treat any self-audit "all green" claim with skepticism — **verify, don't trust**.

## 6. Report
One report: (1) scope + which accounts/surfaces covered + browser/viewport; (2) role×route×feature matrix with
PASS/FAIL/BLOCKED/UNVERIFIED + one line of evidence each; (3) bug reports (id, title, severity **and** priority,
affected roles/features, exact repro, expected vs actual, screenshot/console/network evidence, product-vs-env,
root cause); (4) RBAC findings; (5) coverage gaps; (6) overall **go/no-go** readiness for a non-engineer. Rank
most-severe first; every claim backed by evidence you captured.

Cleanup: nothing to tear down (shared live app) — but delete any throwaway records you created in QA Test
Tenant, and don't leave half-finished money/approval flows open.
