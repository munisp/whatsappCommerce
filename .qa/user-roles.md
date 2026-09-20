# User Roles / Stakeholders (derived from code, see prior session stakeholder audit)

## Platform operator (internal)
- **admin** (`users.role`) — full platform control, bypasses tenant scoping (`server/services/capabilities.ts:66`)
- **platform_engineer** — Go gateway only (`services/gateway/cmd/main.go:271`), Keycloak realm role
- Human-only (not in DB): DPO, Compliance/Legal, Security reviewers, DevOps, on-call, customer support (via Chatwoot)

## Tenant (merchant) staff — `tenant_memberships.role`
- **owner** — full tenant admin
- **operator** — day-to-day ops
- **analyst** — read-only
- **finance** — money-moving only (withdrawals/refunds/escrow release) — `moneyProcedure` gate
- **catalog** — product/catalog only

## Buyer-side
- **customer** — WhatsApp shopper (phone-keyed, not a platform account)
- **guest/public link visitors** — order tracking, public storefront, dispute evidence, SLA-extension approval — explicitly "never expected to have an account"
- **B2B buyer types**: retail, wholesale, distributor, government (B2G)

## Marketplace / B2B ecosystem
- **Marketplace sellers** (`marketplaceSellers` — KYC-verified, commission rate, bank account)
- **Supplier/wholesaler tenants** vs **retailer/buyer tenants** (trade-credit counterparties)
- **Lenders** (external credit facilities funding trade-credit book)
- **Agents/resellers** (commission via order attribution)

## Frontend personas with dedicated UI
1. Platform Admin (`ui/platform-admin`, `/admin`)
2. Merchant/Tenant (`ui/tenant-portal`, `/portal`)
3. Compliance/Regulatory Officer (`/compliance`, `/soc2`, `/kyb-review`)
4. ML/Ops Engineer (`/ml-ops`, `/infra-health`, `/reconciliation`)
5. AI Agent/conversational-flow engineer (`/agent`, `/agent-architecture`, `/nlp-simulator`)
6. End Customer/Buyer (public, link-based — `/track/:token`, `/shop/:slug`, `/discover`, `/evidence/:token`, `/sla-extension/:token`)
7. Supplier/Wholesale B2B trading partner (`/wholesale`, `/suppliers`, `/procurement`)
8. Merchant onboarding applicant (pre-tenant) — `/onboarding-wizard`

## Highest-risk workflows (money movement / irreversible / cross-tenant boundary)
- Escrow settle/release/dispute resolution (`server/services/paymentConfirm.ts`, `escrow.ts`)
- Payment webhook confirm (Paystack/Flutterwave/Stripe/Monnify) — fail-closed HMAC
- Wallet withdrawal (atomic conditional debit)
- Ledger 2-phase reserve/commit/void (TigerBeetle via `rust/ledger-bridge`)
- Trade credit approval / credit limit scoring
- Tenant isolation (any cross-tenant data access)
- KYB/KYC approval (gates tenant activation)
