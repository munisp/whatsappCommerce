# Wave 30 SPEC — Remediation of all Wave-29 verified CRITICAL/HIGH findings

Base: main @ 86e5540f (w30-share master @ 9bd3a82). Evidence: /mnt/agents/output/w29/{REPORT.md,phase0-maps.md,f1-f5.md,f2-f12.md,f3-f7.md,f4-f13.md,f6-f8.md,f9-f10.md,f11-f14.md,f15-f16.md,verify-v1.md,verify-v2.md,verify-v3.md} — READ the reports for your domain first; every finding has file:line.

## Hard invariants (as W26-28)
Additive-only schema; drizzle-kit broken (hand-write SQL+journal+snapshot from 0087 tip); integer cents for NEW money math (legacy float paths: convert touched code to exact decimal-string math via shared/escrowAmounts.ts helpers — do not migrate column types); no unseeded Math.random (shared/prng.ts); tenant-guarded tRPC; authz scanner green; paymentConfirm.ts PINNED (md5 2f77ea4816d1adc5cb35473bd35d1697) — do NOT touch; no package.json/lockfile changes; env vars → env.example.txt banner.
**Remediation doctrine (from methodology): never replace a mock with a better mock — integrate for real OR fail honestly.** For features with no real provider (insurance, local courier, momo): keep mock for dev/test but FAIL CLOSED in production (boot-warn + feature returns honest "unavailable in this deployment" instead of fabricating success) unless a real adapter is configured; statuses must never claim money moved when it didn't (use honest vocab: "recorded", "pending_payout", "simulated").
Shared-file protocol: schema.ts EOF banner `// === W30 <domain> ===`; routers.ts/runner.ts/App.tsx/env.example.txt append-only banners; journal entries appended after 0087 (merger re-chains); /tmp wipes — commit+push after every step; rsync to /mnt/agents/output/w30/tree-<x>/; FUSE ref corruption is transient — retry, never delete refs.
Gate per branch: tsc 0 (NODE_OPTIONS=--max-old-space-size=6144), targeted vitest green, your journeys pass.

## Coder A — w30/loans-credit (mig 0088–0089, J162–J165)
Files: server/services/tradeCredit/microLoans.ts, capture.ts, repayment.ts, server/routers/credit.ts, schema.ts banner.
1. Double-disburse race (V1#3): partial UNIQUE index on merchant_loans (tenantId, merchantId) WHERE status IN ('active','disbursed') [mig 0088]; move existing-loan check INSIDE the tx with SELECT ... FOR UPDATE on the merchant credit account; handle 23505 → return existing loan.
2. Repayment race (V1#4): wallet row FOR UPDATE before debit; conditional decrement `availableBalance >= debit`; loan outstanding updated from locked row in same tx; sweep and manual repay share one locked helper; deterministic references (sweep: loanId+walletTxId already; manual: loanId+ISO timestamp is fine once lock held).
3. Unbacked disbursement (V1#12): add funding leg — debit a platform/lender funding account (credit_facilities commitmentCents, decrement atomically; if insufficient commitment → reject offer) AND post TigerBeetle entry via ledgerBridge (follow escrow.ts:301-318 pattern); loans beyond facility → honest rejection.
4. Mandate double-charge (V1#5): deterministic repaymentReference (hash of mandateId+amountCents+outstandingMarker, no randomInt); FOR UPDATE on credit account before charge; pre-charge pending-marker insert (unique) so concurrent calls collide and the loser returns the in-flight result.
5. creditEnforcement fail-open hole (f2-f12 MEDIUM, kyc/creditEnforcement :71): fail closed per STRICT flag intent.
Journeys: J162 concurrent accepts → single loan; J163 sweep+manual concurrent → conservation; J164 disbursement funding leg (facility decrement + TB entry; insufficient facility rejected); J165 mandate double-submit → single charge.

## Coder B — w30/escrow-lifecycle (mig 0090–0091, J166–J169)
Files: server/services/sla.ts, server/routers/orderCrud.ts, server/routers/escrow.ts, server/_core/index.ts (cron blocks only, banner), server/routers/logistics.ts (delivery window), server/services/medusa/orderBridge.ts, server/services/delivery/service.ts.
1. SLA scan settles undelivered (V1#6): runSlaScan must join orders and skip (alert) any escrow whose order is not delivered/fulfilled; cancelled orders → refund path, never release.
2. Cancel abandons escrow (V1#8): orderCrud.cancel of a paid/escrowed order must, in the same tx, invoke the real refund path (refundEscrowAtomic) or mark escrow for refund sweep.
3. Dispute resolution moves no money (V1#7): review resolution must execute the actual refund/release via the hardened atomic helpers in the same flow; email only after money moved; dispute_resolved consumable by exactly one terminal action.
4. Refunds bookkeeping-only (V1#9): implement provider refund via Paystack refund API (providers/paystack.ts refund method + adapter interface) executed for PSP-custody refunds; where provider refund is impossible (COD, PSSP), use honest status vocab (refund_recorded vs refund_paid) and never claim "returned to buyer" until confirmed; make refunds.processed reachable (provider webhook or admin confirm with evidence).
5. Zero-window delivery (V1#14): ALL delivery_confirmed transitions (webhook paths index.ts, logistics.ts, orderBridge.ts, delivery/service.ts) must set/reset the buyer-protection deadline (shared helper, used everywhere).
6. bulkUpdateState bypass (V2#3): align allowedFromStates with the single-row path (delivery_confirmed only) + require reason + audit row.
7. Escrow auto-confirm cron (V1#13): make flip+credit+fee a single transaction (reuse settleEscrowAtomic instead of re-implementing), collect the platform fee leg, post the TigerBeetle commit.
Journeys: J166 SLA skip undelivered + cancelled→refund; J167 cancel-of-paid → escrow refunded; J168 dispute resolution executes refund (mock provider asserts refund API call) + processed reachable; J169 window reset on all delivery paths + cron settle atomic with fee leg.

## Coder C — w30/feature-ring (mig 0092–0093, J170–J173)
Files: server/services/stokvel.ts, savingsWa.ts, insurance.ts, insurance/adapters.ts, groupBuy.ts, loyalty.ts, vouchers.ts, server/routers/savings.ts, server/routers/marketplace.ts, server/routers/invoice.ts, server/services/mobileMoney.ts, server/services/geoDiscovery.ts, server/routers/geo.ts, schema.ts banner.
1. Stokvel (V1#1): contributions require a verified payment reference (reuse hasVerifiedPayment from payments/verifyProviderStatus) or stay `pending`; payouts must credit the recipient's wallet (create if needed; wallet_tx with reference stokvelpay:<circleId>:<cycle>) or remain `pending_payout` — never "paid" without movement; wrap cycle advance in one transaction; honest WhatsApp copy.
2. Insurance (V1#2): claims never auto-"paid" — mock adapter claims become `approved_pending_payout` with honest copy; payout only via real adapter or manual ops confirm; prod guard: when only mock adapter is available, premium add-on is DISABLED in production (fail honestly at quote time); parametricEvent → adminProcedure.
3. GroupBuy (V1#10): joinDeal requires verified paymentRef (same helper); expiry/refund must record real outcome (refund_failed status + reconciliation surface, never auto-"refunded" on failure); fix `void escrowRefunded` discard.
4. Loyalty (V3#9): FOR UPDATE balance lock (or conditional guarded update) on redeem/earn; enforce the 20% cap inside redeemPoints itself; unique index (tenantId, customerPhone, orderId, kind) where orderId not null [mig]; deterministic.
5. Vouchers (V3#10): FOR UPDATE on program row for budget check+decrement in one tx.
6. Marketplace commissions (V3#12): derive saleAmount/rate server-side from the order + tenant commission config; unique orderId dedupe; guarded settle flip.
7. Invoice commission (V1#15): rate from platform config (escrow_config/platform settings, admin-set), not client; revenue SQL grouped by currency, reject mixed-currency invoicing.
8. MobileMoney (V3#14): prod guard — façade disabled in prod without provider config; stats clearly labeled simulated in non-prod.
9. Sponsored spend (V2#16): implement spend writer — debit spentTodayCents on served sponsored impressions/clicks (deterministic per-pageview debit within discover flow) with daily reset job; enforce cap at serve time; honest billing rows.
10. Float income (V3#13): unique (date) constraint; skip-if-exists; credit accrual to platform fee wallet (or label projection-only honestly).
Journeys: J170 stokvel verified contribution + real payout wallet credit; J171 insurance honest statuses + prod guard + group-buy verified join + refund_failed honesty; J172 loyalty concurrent redeem blocked + cap enforced + voucher budget locked; J173 commissions server-derived + invoice config rate + sponsored spend debit/cap.

## Coder D — w30/auth-gates (mig 0094–0095, J174–J177)
Files: server/services/kycGate.ts consumers, server/_core/trpc.ts, server/routers/escrow.ts (withdrawal section only — coordinate: B owns escrow.ts lifecycle; you touch ONLY requestWithdrawal + assertBuyerOrAdmin), server/routers/membership.ts, server/routers/payment.ts (confirm + fraud), server/services/kyc.ts, server/services/sanctions.ts, server/services/geoDiscovery.ts (KYB fail-open), server/routers/phoneAuth.ts, oauth.ts, tenantInvite.ts, server/_core/index.ts (/ussd + logout, banner), server/services/payments/providers/customHttp.ts, server/routers/paymentGateway.ts, server/routers/odoo.ts (baseUrl validation), index.ts mojaloop block, logistics.ts PIN.
1. KYB on money paths (V2#1): evaluate kycGate (fail-closed, cached) in requestWithdrawal, createHold, credit.accept.
2. Withdrawal kill chain (V2#2): (a) step-up OTP — build stepUpVerify using existing phoneAuth OTP: payout-destination change or withdrawal > threshold requires fresh OTP to tenant admin phone (mig: step_up_challenges table); (b) payout bank details change becomes a separate audited procedure with step-up, never silently inline; (c) money procedures require operator+ role — introduce role-aware guard (moneyProcedure = protectedProcedure + tenantId + assertTenantAccess with role in owner/operator) and apply to withdrawal, refunds, escrow release paths; keep read-only analyst reads working.
3. membership.add can't grant owner (V2#12): restrict to ≤ operator; owner grant requires owner + step-up.
4. ENABLE_LOCAL_AUTH prod guard (V2#7): boot-fatal in prod if true.
5. Logout revokes jti (V2#13): wire existing revocation registry into Express logout.
6. Invite links (V2#13): single-use (consumed marker), TTL 24h.
7. /ussd auth (V2#6): shared-secret header from USSD gateway (env, fail-closed prod) + rate limit; phone identity still server-session-bound.
8. buyerConfirm identity (V2#14): require verified session/buyer token, not self-asserted string.
9. Fraud screening blocks (V2#5): high risk → payment rejected/blocked before ledger reserve (configurable threshold, default block).
10. payment.confirm fail-closed on provider probe failure (V2#4) — keep admin override but require explicit reason + audit + step-up.
11. KYB screening default-on (V2#10): enabled by default; explicit env to disable (non-prod only); sanctions fail-closed polarity in prod (V2#15).
12. Geo KYB fail-open (V2#11): catch → exclude, not include.
13. SSRF (V2#8): odoo testConnection baseUrl z.string().url() + block private IPs (shared ssrfGuard helper); customHttp provider baseUrl same guard at config-write time.
14. Mojaloop (V2#9): JWS validation default ON; key-fetch failure → reject (fail closed).
15. Delivery PIN (V3#17): attempt cap (5/day), hashed storage, timing-safe compare.
16. OTP hash upgrade (f9-f10#1): HMAC-SHA256 with dedicated OTP_HASH_SALT (already required) + per-OTP salt; keep verify path migration-safe.
17. Storage (V3#17): authenticate /api/storage/* (capability token or session); MIME sniff server-side, force Content-Disposition for risky types.
Journeys: J174 KYB blocks withdrawal/hold/loan for unverified; J175 step-up OTP on payout-change + withdrawal; role escalation blocked; J176 local-auth prod guard + logout revoke + invite single-use + ussd auth; J177 fraud block + confirm fail-closed + geo fail-closed + SSRF guard + mojaloop fail-closed + PIN cap.

## Coder E — w30/deploy-observability (mig 0096–0097, J178–J181)
Files: docker-compose.yml, k8s/ manifests, services/kyc-verifier/Dockerfile + app, server/_core/env.ts (boot checks, careful: many tests depend), client Dashboard.tsx/AdminPortal.tsx/DeployChecklist.tsx, server/routers/mlOps.ts, server/routers/infra.ts, server/routers/odoo.ts (only if D didn't — coordinate via report), hermes.ts, env.example.txt, docs.
1. Unbootable compose (V3#1): add missing env vars to compose platform service (dev-safe values + documented overrides); fix tigerbeetle/platform port 3000 collision (V3#5).
2. kyc-verifier mock (V3#2): default VLM_MOCK_MODE=false in Dockerfile; mock only via explicit compose override; extend Node boot gate to verify sidecar mode (probe /health or config echo).
3. Scheduler-less crons (V3#3): add a scheduler service to compose/k8s (lightweight node cron caller using CRON_JWT with per-route allowlist) invoking all /api/scheduled/* on their cadences; document in DeployChecklist with correct auth'd curl (V3#20).
4. Hermes wiring (V3#4): set HERMES_BRIDGE_URL=http://hermes-bridge:8096 in platform compose/k8s; INTERNAL_API_KEY added to REQUIRED_BY_ENV for prod; approvePO propagates email failure (honest error + retryable state).
5. Recon/ml wiring (V3#8): compose sets RECON_WORKER_URL/ML_STACK_URL service DNS; reconciliation button fails loudly with setup hint.
6. Dashboard honesty (V3#6): remove hardcoded charts/integration statuses — wire real queries or render explicit "no data yet" states; mlOps: serve honest unavailable when mlruns absent (no simulated metrics presented as real); drift cron reports skipped honestly.
7. Mobile money/mojaloop defaults: MOJALOOP_VALIDATE_SIG default true in compose; document simulator dev-only (align with D#14).
8. CI: add docker build job for platform + note SOC2 check gating (make it required, not continue-on-error) if straightforward, else document.
9. env.example.txt: add SWEEP_SECRET/PLATFORM_API_KEY and any new vars from W30.
Journeys: J178 compose env completeness (boot-gate dry check) + scheduler invokes crons with auth (mock HTTP assert); J179 kyc mock guard + hermes URL + approvePO failure honesty; J180 dashboards no-fabrication (components render empty-state without hardcoded series) + mlOps honest-unavailable; J181 recon wiring + checklist auth examples validity.

## Merger notes
Merge order A B C D E. Journal idx 88–97 cumulative snapshots from 0087. Journey count 161+20=181 (assertion 182). escrow.ts shared between B (lifecycle) and D (withdrawal section) — merge carefully, both keep changes. Full gate: tsc 0 (6GB heap), full vitest, 181/181 journeys, authz green, paymentConfirm pin intact.
