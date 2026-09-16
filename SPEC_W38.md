# SPEC_W38 — Remediation: money + stock integrity P0s (from W36 verified audit)

Base: post-W37 main (merger rebases). BINDING. Source of truth: /mnt/agents/output/w36/p0-verification.md + audit-payments.md + audit-orders.md. paymentConfirm.ts PINNED (md5 2f77ea4816d1adc5cb35473bd35d1697) — all ORD-1/ORD-3 fixes ADJACENT (inventory.ts, orderCrud.ts, callers), never edits.

## Global invariants
- Additive-only schema, hand-written migrations 0119+ (journal re-chain at merge).
- Integer cents; claim-first FOR UPDATE pattern for all money guards (mirror orderCrud.refund L478-505).
- Every fix gets journey(s); numbering continues from W37's final count (merger assigns actual).
- verify-before-compensate doctrine: on PSP timeout/ambiguity NEVER retry blindly — query provider status first.
- Banner edits on shared files; no lockfile changes; fail-open n/a (these are correctness fixes — fail-CLOSED honestly where money is ambiguous).

## Coder A — refund/escrow money integrity (PAY-1 residual, PAY-2, PAY-3, PAY-7, PAY-9)
1. PAY-2 double-refund: providers/paystack.ts refund gets idempotency key (deterministic: tenant+order+refundId hash) + verify-before-retry: on timeout, query Paystack transaction/refund status before any retry; sla.ts sweep only retries refunds whose provider-status check returns "not found/failed"; add refund_attempts table (mig) recording provider_ref, idempotency_key, status.
2. PAY-3 refund-after-payout: processRefund loads escrow state in same tx (FOR UPDATE); if escrow settled/paid-out -> create merchant_clawback debit record (new table) + block-or-flag per tenant policy; never silently double-spend. Journey: refund after payout -> clawback recorded, platform not debited twice.
3. PAY-1 residual: include status 'processed' in the cumulative refund SUM guard + add same cumulative cap inside processRefund approval path (claim-first).
4. PAY-7 bulk refund honesty: escrow.bulkUpdateState refund path must either call the provider per order or mark orders 'refund_pending' with an explicit sweep that executes provider refunds; never 'refunded' without money movement. Journeys for both branches.
5. PAY-9 scheduled bill double-debit: scheduledPayments claim tx re-checks bill paid status INSIDE the claim FOR UPDATE; sync marks bill paid before wallet debit is committed (or compensating credit with journey proof).
Journeys J-A1..J-A8 covering: idempotent refund retry, verify-before-retry on timeout, refund-after-payout clawback, cumulative cap incl. processed, bulk refund executes provider calls, scheduled payment skip on already-paid bill. Branch w38/money-integrity.

## Coder B — PoT reconciliation + stuck money (PAY-4/5/6, PAY-8 assist)
1. payOverTime: pending mandate charges (installment + early-settle) now WRITE to the reconciler's scan set (mandate_charges or a new pot_charges table the reconciler also scans — prefer extending reconciler coverage, keep compat); settlement-after-successful-charge gets retry path with verify-first; early-settle state machine closes stuck states.
2. Reconciler: extend to potcap/potsettle providers; settlement-reference dedupe (uniq constraint + claim-first); underpayment tolerance ±₦100 no longer auto-confirms full settlement — partial settlement state + alert.
3. Journeys: pending PoT charge reconciles to settled; provider timeout mid-charge reconciles not double-charges; early-settle full lifecycle; duplicate settlement reference rejected. Branch w38/pot-recon.

## Coder C — stock integrity (ORD-1, ORD-3, ORD-4, ORD-5; adjacency-constrained)
1. ORD-1: inventory.ts gains releaseCommittedReservations(orderId) for paid-cancel (committed -> released with restock) — called from orderCrud.cancel paths (adjacent to paymentConfirm, NOT inside it).
2. ORD-3 TTL race: reservation sweeper extension — reservations whose order has paymentStatus pending-but-attempted (webhook in flight / PSP attempt recorded) get TTL extension; slow-webhook journey proving paid order not oversold.
3. ORD-4 split-path cancel: single cancelOrder service fn used by BOTH updateStatus and cancel (restock + release + snapshot credit consistent); snapshot credit adds tenantId predicate (ORD-2 hygiene P3, one-line).
4. ORD-5 wholesale stock guard: placeWholesaleOrderTx checks seller stock (where listings track stock) or honestly marks fulfillment_untracked; never silent oversell — add guard + config flag per spec of existing listing model (read wholesaleCatalog first; choose honest minimal).
5. Journeys: paid-cancel restocks exactly once (both cancel paths), TTL extension under slow webhook, wholesale oversell rejected. Branch w38/stock-integrity.

## Merger
Order A→B→C on post-W37 main. Migration journal re-chain; journey count = actual; full gate (tsc 0 / vitest 0 fail / sim N+N / authz / pin md5 / lockfiles unchanged / no empty files). Deliver merge-log + merged tree.
