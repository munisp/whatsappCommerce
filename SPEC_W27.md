# Wave 27 SPEC — Feature Expansion (single source of truth)

Base: main @ 7533c191 (post-Wave-26). Repo: file:///mnt/agents/output/w27-share (master = pristine base).
Stack: Express+tRPC, React/Vite tenant portal, Drizzle/PostgreSQL, PGlite simulation harness, Temporal, vitest.

## Hard invariants (all coders)
- Additive-only schema. drizzle-kit is BROKEN — hand-write SQL + journal + snapshot.
- Integer cents for ALL money. No unseeded Math.random in business logic (use shared/prng.ts).
- All tRPC procedures guarded: protectedProcedure + tenantId in input + assertTenantAccess, or adminProcedure, or internalProcedure (server-to-server), or hardened publicProcedure (tracking.ts exemplar). Authz scanner must stay green; exemptions only via EXEMPTION_ALLOWLIST with justification.
- New env vars → append to env.example.txt. No package.json/lockfile changes.
- paymentConfirm.ts is PINNED (md5 2f77ea4816d1adc5cb35473bd35d1697) — do not touch.
- Do NOT edit: payment.ts, paymentConfirm.ts, receiptVerification.ts, escrow.ts, orderCrud.ts, codFlow.ts internals (integration via their public interfaces only). If integration requires changes there, note in report for the merger.
- WhatsApp flows: integrate via existing inbound/useCases/nlp pipeline patterns (see locationInbound.ts, discoveryMenu.ts for exemplars).
- Durability: /tmp wipes randomly. Work in /tmp clone; commit + push to file:// origin after EVERY step; rsync tree to /mnt/agents/output/w27/tree-<x>/ periodically.
- Gate per branch: npx tsc --noEmit = 0; targeted vitest green.

## Ownership & allocations

| Coder | Branch | Features | Migration idx | Journeys |
|---|---|---|---|---|
| A | w27/catalog-ai | Voice-note→listing (STT via existing llm/whisper pipeline), photo→listing (vision), price suggestion | 0070–0071 | J127–J130 |
| B | w27/bookkeeping | Sales summaries (daily/weekly digests), expense capture via receipt photo, tax-ready export | 0072–0073 | J131–J134 |
| C | w27/storefront-i18n | Public shareable storefronts (slug URLs, catalog sync), multi-language framework (en/ha/yo/ig/sw/am/fr menus + NLU locale) | 0074–0075 | J135–J137 |
| D | w27/credit | Merchant credit score (from order/COD/payment history), micro-loans (extends server/services/tradeCredit), auto-repay from sales | 0076–0077 | J138–J141 |
| E | w27/delivery-loyalty-reviews | Delivery aggregation (quote/book via pluggable courier adapters + escrow tie-in), loyalty points (ledger-backed), verified reviews (purchase-verified, ties to trustScore) | 0078–0079 | J142–J145 |
| F | w27/b2b-groupbuy | B2B wholesale marketplace (wholesaler listings, retailer orders, trade-credit checkout), group buying (pool orders → bulk discount threshold) | 0080–0081 | J146–J149 |
| G | w27/savings-insurance-vouchers | Stokvel/group savings circles (rotating payouts via escrow+ledger), micro-insurance (parametric products at checkout, partner adapter interface), government/NGO voucher rails (issue/redeem/reconcile) | 0082–0083 | J150–J153 |

## Shared-file edit protocol (minimize merge conflicts)
- drizzle/schema.ts: append your tables at the END of the file, inside a clearly marked banner comment `// === W27 <feature> ===`. Never reorder existing lines.
- server/routers.ts (or wherever routers register): append your router import+registration at the end, marked banner. One line per registration.
- simulation journey registry/runner: append-only registration of your journey IDs.
- client route registration: append-only.
- _journal.json: append your entries after idx 0069 in YOUR branch; merger will re-chain all entries in idx order and rebuild cumulative snapshots (ids/prevIds). Your snapshot file: derive from 0069 snapshot + your tables only (merger unions them).
- env.example.txt: append under banner `# === W27 <feature> ===`.

## Interface contracts
- Credit score service: `getMerchantScore(tenantId, merchantId, db) → {score: number (0-1000), factors: {...}, computedAt}` — D owns; E/F/G may consume via import from server/services/creditScore.ts (D creates; others code against this signature).
- Loyalty ledger: `awardPoints({tenantId, customerPhone, points, reason, orderId?}, db)` / `redeemPoints(...)` in server/services/loyalty.ts (E owns).
- Delivery adapter interface: `interface CourierAdapter {quote(req): Promise<Quote>; book(req): Promise<Booking>; status(id): Promise<DeliveryStatus>}` in server/services/delivery/ (E owns); registry `getCourierAdapter(name)` like payment provider registry.
- Insurance partner adapter: `interface InsuranceAdapter {quote(productId, context): Promise<PremiumQuote>; bind(quoteId): Promise<Policy>; claim(...)} ` (G owns).
- Vouchers: `issueVouchers({programId, recipients[], amountCents, currency})`, `redeemVoucher(code, orderId)` (G owns).
- Storefront: public route `/shop/:slug` served by tenant portal; slug unique per tenant (C owns table `storefronts`).
- All new WhatsApp intents register in nlp.ts intent enum additively.

## Merger reconciliation (main agent / merge engineer)
1. Merge order: A B C D E F G.
2. Rebuild _journal.json: all entries sorted by idx; regenerate snapshot chain as cumulative union (each snapshot = previous + that migration's tables/indexes); verify migration-chain test + PGlite journey suite applies real SQL cleanly.
3. Fix journey count assertions (126 base + new = final count), router registration dupes, App route dupes.
4. Full gate: tsc 0; full vitest; all journeys; authz green.
