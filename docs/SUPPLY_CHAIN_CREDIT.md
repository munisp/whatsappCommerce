# Supply Chain Credit Network (Wave 8)

**Status:** shipped — PRs #62–#65, main @ `4edf4eee`, verifier gate PASS (1,206 tests / 0 failed, tsc clean, build green)

The platform's B2B layer: tenants (traders/retailers) procure parts and raw materials from
manufacturer/wholesaler tenants **on credit**, underwritten by the platform's own trading
history — purchase orders over WhatsApp, supplier approval in-chat, automated repayment and
dunning, and bidirectional ERP sync.

---

## 1. Why this exists

Small traders buy stock from manufacturers through informal channels with paper-based
"pay later" arrangements. Because this platform already sees every sale and repayment a
trader makes, it can underwrite trade credit **from real trading history** — something no
standalone lender or the manufacturer's paper ledger can do. Wave 8 turns that data
advantage into a product: a supply-chain credit network between tenants.

## 2. Architecture

```
Trader (buyer tenant)                     Supplier (manufacturer tenant)
─────────────────────                     ──────────────────────────────
WhatsApp: "Restock / Buy supplies"  ──►   supplier approval action card
  └ supplier directory                      (Approve / Reject, ownership-checked)
  └ wholesale catalog (MOQ, terms)                │
  └ PO builder (multi-line, MOQ gate)             ▼
        │                              drawOnCredit (atomic, limit-guarded)
        ▼                                         │
purchase_orders (draft→submitted→…→paid)          ▼
        │                              credit_accounts / credit_ledger
        ▼                                         │
repayment link (Paystack) ◄── dunning sweeper (reminders→fees→freeze)
        │
        ▼
Odoo (POs, vendor bills, payments, credit limits) + Twenty (supplier pipelines)
   — bidirectional via wave-4 outbox/inbound middleware
```

## 3. Components

### 3.1 Trade credit engine — `server/services/tradeCredit/` (PR #62)

| Module | Responsibility |
|---|---|
| `accounts.ts` | Credit account CRUD (buyer×supplier), freeze/unfreeze, aging buckets (current / 1–30 / 31–60 / 61–90 / >90d) |
| `scoring.ts` | `score = 100·(0.5·onTime + 0.3·volumeFactor + 0.2·tenureFactor)`; suggested limit = 30-day order volume × (0.2 + 0.8·score/100), ₦50k floor / ₦50M cap, cold-start score 10. Deterministic, reasons returned for display |
| `draw.ts` | **Atomic claim-first draw**: single `UPDATE … SET outstanding = outstanding + amt WHERE id AND status='active' AND outstanding + amt <= limit RETURNING`; ledger `invoice_draw` (with due date) in the same transaction. Proven race-safe: 10 concurrent draws can never exceed the limit |
| `repayment.ts` | Claim-first guarded decrement (over-repay atomically refused), strict-FIFO settlement of draws, same transaction |
| `dunning.ts` | `runDunningCheck(now)`: window-aware WhatsApp reminders at −3d/0d/+3d/+7d (idempotent via claim-first markers), 2% late fee once per draw at +3d, account freeze at +7d. Sweep never throws |

API (consumed by procurement, integrations, simulation):
`drawOnCredit`, `getCreditAccount`, `suggestLimit`, `applyRepayment`, `runDunningCheck`
(+ `*Tx` cores for composing inside caller transactions).

### 3.2 B2B procurement — `server/services/procurement/` (PR #64)

- **Supplier profiles**: MOQ, lead time, terms offered (e.g. net-7/14/30), auto-approve threshold
- **Purchase orders**: `draft → submitted → approved/rejected → fulfilled → invoiced → paid`;
  `PO-YYYYMMDD-XXXX` collision-safe numbering
- **WhatsApp flow** (procurement use case, `useCases.ts`): *Restock / Buy supplies* →
  supplier directory → wholesale catalog (Medusa price lists → tier fallbacks) → PO review
  card with MOQ gate → terms picker (credit only offered with an active credit account) →
  submit → **supplier receives Approve/Reject interactive card** (ownership-enforced)
- **Approval paths**: credit → draw → `invoiced` + due date (buyer notified); over-limit →
  graceful fallback to pay-now or limit-increase; pay-now → payment link → provider confirm
  → `paid`; auto-approve below threshold still runs the credit guard
- **Catalog pricing**: Medusa B2B price lists → `wholesale_price_tiers` →
  `metadata.wholesalePrice` → retail fallback

### 3.3 Integrations & repayment rails (PR #63)

- **Odoo B2B** (`integrations/odooB2B.ts`, bidirectional via wave-4 outbox/inbound):
  `po.submitted` → draft purchase.order; approval → confirm + vendor bill with due date;
  `repayment.posted` → matched payment; inbound stock-picking → PO `fulfilled`
  (exactly-once conditional update) + buyer WhatsApp notification
- **Twenty**: supplier Company + PO Opportunity with stage mapped from PO status
- **Repayment links** (`creditRepayLink.ts`): Paystack links (full or partial) with
  `credit_repayment` metadata; post-confirm hook in `paymentConfirm.ts` applies the
  repayment **exactly-once** — `processed_webhook_events` claim BEFORE apply, rollback on
  failure, replay never double-applies. The claim-first money path in `paymentConfirm.ts`
  is byte-identical (verifier-audited: +48/−0, hooks only)
- **Ops**: usage metering for credit ops; `/health/ready` reports B2B outbox lag

### 3.4 Frontend (PR #65)

- **Supplier Directory** (`/suppliers`) — cards with MOQ, lead time, terms chips, live
  credit summary
- **Procurement Hub** (`/procurement`) — My POs + Build PO drawer (catalog lines, MOQ
  validation, payment-mode radio with credit-availability logic)
- **Credit Accounts** (`/credit-accounts`) — buyer view (limit gauge, outstanding, next
  due, ledger, Repay / Request increase) and supplier view (score + reasons, editable
  limit/terms, freeze/unfreeze, 5-bucket aging cards)
- **Supplier Approvals** (`/supplier-approvals`) — pending inbox with credit-fit chips +
  history (mark paid / mark fulfilled follow-through)
- **Dashboard widgets** (credit summary, pending approvals) + "Supply Chain" nav group +
  `procurement` toggle in the WhatsApp Menu Builder (waMenu contract id, order 6)

## 4. Schema (additive; migrations 0041–0044)

- `credit_accounts` — buyer×supplier unique; limit/outstanding (kobo), terms_days,
  status (active/frozen/closed), score + reasons
- `credit_ledger` — invoice_draw / repayment / fee / adjustment; due_date; posted/settled/void
- `supplier_profiles` — per-tenant MOQ, lead time, terms_offered, auto-approve threshold
- `purchase_orders` + `po_items` — po_number, parties, status machine, payment_mode
  (credit/paynow), credit_account link, due_date

## 5. Risk controls

1. Supplier controls every limit; platform *suggests* from trading history (score + reasons)
2. Atomic draw guard — overdraw impossible even under concurrency (race-tested)
3. Cold-start conservatism — no history ⇒ score 10, floor limit
4. Automated dunning ladder: reminders → 2% late fee → freeze at +7d; frozen accounts cannot draw
5. Exactly-once money application everywhere (claim-first + webhook dedupe)
6. Full tenant isolation (assertTenantAccess on all 31 new procedure call sites; router tests)

## 6. Verification

- Independent verifier gate on fresh clone @ `4edf4eee`: **PASS, 10/10 checks** —
  1,206 tests (arithmetic-verified 1028+61+38+51+28), tsc 0 errors, build green,
  migration chain integrity, money-path audit with file:line evidence, security-invariant
  diff audit, wave-7 simulation still 30/30
- Simulation journeys **J31–J38** (separate PR): procurement browse → PO → approval card →
  credit draw → overdraw refusal → pay-now settle → partial repayment (replay-safe) →
  dunning fee → default freeze

## 7. Roadmap hooks

- `tradeCredit.requestAccount` endpoint (buyer-initiated credit requests; UI CTA already
  wired and degrades gracefully)
- Invoice discounting / financing partner integration against the ledger
- Cross-supplier composite scores; dynamic limit adjustments from live sales velocity
- Client bundle code-splitting (3.8 MB bundle — pre-existing, non-blocking)
