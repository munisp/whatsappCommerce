# SOC 2 System Description — WhatsApp Commerce Platform

## 1. Overview

The platform is a multi-tenant WhatsApp-native commerce system. Merchants (tenants)
sell to end customers entirely inside WhatsApp conversations; the platform provides
the conversational catalog, ordering, payments, credit, logistics, and AI-agent
layers, plus a web operator dashboard (this repo's `client/`).

### Core product capabilities

| Capability | Description | Key code |
|---|---|---|
| Conversational commerce | WhatsApp menus, NLP cart, journey builder | `server/services/waMenu.ts`, `server/services/nlpCart.ts`, `server/services/journeyBuilder.ts`, `server/routers/journeys.ts` |
| Orders | Order capture, timelines, tracking links | `server/routers/` (orders), `client/src/pages/Orders.tsx`, `client/src/pages/TrackOrder.tsx` |
| Payments | Paystack + mobile money, payment confirmation invariant | `server/services/paymentConfirm.ts`, `client/src/pages/Payments.tsx`, `client/src/pages/MobileMoneyPortal.tsx` |
| Cash on delivery (COD) | COD board, rider cash collection, reconciliation | `server/services/codFlow.ts`, `server/routers/cod.ts`, `client/src/pages/CodBoard.tsx` |
| Trade credit | Merchant credit accounts, repayment links | `server/services/tradeCredit/`, `server/routers/tradeCredit.ts`, `server/services/creditRepayLink.ts` |
| Manufacturer credit programs | Brand-funded retailer credit programs | `server/services/manufacturerPrograms.ts`, `server/routers/manufacturerPrograms.ts`, `client/src/pages/ManufacturerCredit.tsx` |
| Visual inventory | Photo-based stocktakes with CV stack | `server/services/visualStocktake.ts`, `server/services/visualInventoryApply.ts`, `client/src/pages/VisualInventory.tsx` |
| Journeys / automation | Drip journeys, cart recovery, broadcasts | `server/services/journeyBuilder.ts`, `server/services/cartRecovery.ts`, `server/routers/broadcast.ts` |
| Compliance / B2G | Tax filings (FIRS), CAC registrations, procurement bids | `server/routers/compliance.ts`, `client/src/pages/CompliancePortal.tsx` |
| Audit & observability | Audit log views, health, webhook DLQ | `client/src/pages/AuditLog.tsx`, `server/services/observability.ts`, `server/routers/webhookDlq.ts` |

## 2. Architecture

- **Client**: React SPA (`client/`) talking to the server over tRPC
  (`client/src/lib/trpc.ts`, typed against `server/routers.ts`).
- **Server**: Node/TypeScript tRPC routers (`server/routers/`) with business
  logic in services (`server/services/`), persistence via Drizzle ORM
  (`drizzle/schema.ts`, PostgreSQL).
- **Async/auxiliary stacks**: Go orchestrator (`go.work`), Rust bbox
  post-processor (`rust/`), Python CV services (`services/`, `ai-agent/`).
- **Messaging edge**: WhatsApp Business Cloud API webhooks with dedupe
  (`server/services/webhookDedupe.ts`) and dead-letter queue
  (`server/routers/webhookDlq.ts`).

## 3. Trust boundaries

1. **Meta/WhatsApp → platform webhook endpoint.** Inbound messages/statuses.
   Authenticated by webhook verify token + signature; replay handled by
   `webhookDedupe.ts`.
2. **End customer ↔ WhatsApp.** Customer PII (phone, name, location, order
   history) enters via WhatsApp; the platform never sees WhatsApp credentials.
3. **Merchant operator ↔ web dashboard.** Session/JWT-authenticated tRPC
   (`server/_core/trpc.ts`), role-filtered nav and admin-only procedures
   (`adminProcedure` in routers; `visibleGroupsForRole` in
   `client/src/components/DashboardLayout.tsx`).
4. **Tenant ↔ tenant (isolation boundary).** Every tenant-scoped procedure must
   authorize via `assertTenantAccess` / tenant guards; enforced by the static
   authz-coverage scanner (`server/routers/__tests__/authzScan.lib.ts`,
   `authzCoverage.test.ts`) which fails CI if a tenant-relevant procedure lacks
   a guard or an explicit `// authz:exempt <reason>`.
5. **Platform ↔ payment providers (Paystack, mobile money).** Payment
   confirmation only transitions state through the invariant-checked service
   `server/services/paymentConfirm.ts` (byte-locked; changes require security
   review).
6. **Platform ↔ subprocessors.** See `VENDOR_REGISTER.md`.

## 4. Data flows

- **Order flow**: WhatsApp message → webhook → conversation/cart services →
  order rows → payment confirm (paymentConfirm invariant) → fulfilment/COD →
  reconciliation.
- **Credit flow**: credit account creation → order-financed drawdowns →
  repayment links (`creditRepayLink.ts`) → ledger bridge
  (`ledgerBridge.ts`).
- **Audit flow**: mutating operations append to the audit log; the hash-chained
  audit chain (`server/services/auditChain.ts`, exposed as
  `compliance.verifyAuditChain`) makes tampering detectable.
- **Retention flow**: per-entity retention policies
  (`retention_policies` table, `server/services/retention.ts`) drive scheduled
  purge/anonymization; legal hold suspends deletion.
- **Incident flow**: operational/security incidents recorded in the `incidents`
  table (`incidents` router) with severity and status lifecycle; surfaced on
  the SOC2 dashboard (`client/src/pages/Compliance.tsx`).

## 5. Multi-tenancy & commitments

All merchant data is keyed by `tenantId`. The platform commits to: tenant
isolation enforced by code and static ratchet tests; confidentiality of
customer PII; availability of the ordering path; and auditable change
management (see `CHANGE_MANAGEMENT.md`).

## 6. Complementary controls

- Customers/end users are responsible for securing their WhatsApp accounts.
- Tenants are responsible for the accuracy of catalog/pricing data and for
  granting platform access only to authorized staff.
