# Resilience & Chaos Verification — whatsappCommerce

Branch: `fix/verify-resilience`. Every row below is pinned by an automated
test (vitest / go test / cargo test) unless marked *manual*.

## Chaos matrix

| # | Failure injected | Observed behavior | Recovery | Verdict | Pinned by |
|---|---|---|---|---|---|
| 1 | Redis down, request hits `/api/trpc` | **Before fix:** `redisIncrEx` silently returned 0 → limiter blind, unlimited traffic (silent-pass). **After fix:** `server/_core/rateLimit.ts` treats unreachable/null Redis as a FAILURE: prod returns **503 `rate-limiter-unavailable`** (fail-closed, `Retry-After: 30`), dev/test fails open with a warning (`degraded`). | Restore Redis → counter resumes, 429s enforce again | ✅ FIXED | `server/redisOutage.test.ts` |
| 2 | 100 duplicate signed Paystack webhooks, concurrent | **Before fix:** ledger commit ran BEFORE the guarded transition → storm double-committed. **After fix:** `payment.confirm` claims the intent FIRST via atomic `UPDATE ... WHERE status IN ('pending','initiated') RETURNING` (rowCount check); only the claim holder commits the ledger; commit failure rolls the claim back to `pending`. | Exactly **1 side-effect, 99 already-completed skips**; failed commit → intent back to `pending`, retry succeeds | ✅ FIXED | `server/webhookStorm.test.ts` |
| 3 | Escrow fee split, rate `numeric(6,4)` (0.03125) | **Before fix:** float split (`fee=amount*rate`, `net=amount−fee`, each `toFixed(2)`) violated `fee+net==gross` for ~2% of amounts. **After fix:** `splitEscrowAmounts` (shared module) does integer minor-units math — fee rounded ONCE (`round(grossMinor×rate)`), net = gross − fee. | Invariant holds for every amount (200 random kobo amounts × 6 rates, plus the old-split counterexample corpus) | ✅ FIXED | `server/feeInvariant.test.ts` |
| 4 | Wallet credit throws during PSP escrow settlement AFTER ledger capture | PG transaction rolls back (escrow stays not-settled) but the ledger commit survives → `compensateEscrowSettlementFailure` calls `/ledger/reverse` (idempotent, dedup `reverse:{pending_id}`), stamps `metadata.settlementFailure`, and flags `reconRequired` when the reversal itself is unconfirmed (bridge 5xx/unreachable). Wired into `escrow.buyerConfirm` and the bulk release path. A genuinely settled escrow is never unsettled — escalation instead. | Recon worker sweeps `metadata.settlementFailure.reconRequired` rows | ✅ FIXED | `server/sagaRollback.test.ts` |
| 5 | TigerBeetle down at `payment.initiate` | Honest failure: intent marked `failed` with `ledger_failed: …`, error surfaced — no silent success with zero ledger entries. Retry after recovery clears the failed intent (same idempotency key) and reserves cleanly. | Retry succeeds; exactly one refused + one accepted reserve | ✅ OK (pinned) | `server/ledgerOutage.test.ts` |
| 6 | Temporal down at workflow start | No crash; order/run persists as a synthetic **`local-*`** run in `temporal_workflow_runs` (`status=running`), caller gets `started:false, error:"temporal_unavailable"` and proceeds synchronously. | Temporal recovers → subsequent starts get real run ids; local-* runs are auditable | ✅ OK (pinned) | `server/temporalOutage.test.ts` |
| 7 | Recon-worker voids an orphaned pending transfer | Classification contract: `200 → voided` (repair confirmed), `400/409 → already-final` (nothing to repair), `5xx/unreachable → retry` next cycle. | Self-healing sweep | ✅ OK (pinned) | `cargo test -p recon-worker` |
| 8 | `/transfer` replay, dev in-memory fallback (LEDGER_ALLOW_INMEMORY) | **Before fix:** fallback never saved the `TransferRecord` → replay with the same idempotency key reserved AGAIN (double-reservation). **After fix:** record saved; replay returns the same `pending_id` (`replayed:true`) and exactly one reservation. | — | ✅ FIXED | `cargo test -p ledger-bridge` |
| 9 | Redis down at the Go gateway rate limiter | Fails OPEN (advisory first line of defense; authoritative fail-closed limiting is one hop downstream at `/api/trpc`). Never 429s/5xxs when it cannot count. | Restore Redis → sliding window resumes | ✅ OK (pinned) | `go test ./services/gateway/...` (`internal/ratelimit`) |

## Quorum / fencing adaptation (prompts 40–50)

This platform is not a Raft cluster at the app tier; the insurance-platform
quorum/fencing prompts map onto our stack as follows:

- **Split-brain circuit-breaker = ledger 503 fail-closed.** When TigerBeetle
  is unreachable, `ledger-bridge` returns `503 ledger_unavailable` and refuses
  to fabricate results (the dev in-memory fallback requires the explicit
  `LEDGER_ALLOW_INMEMORY=true` escape hatch). The TS layer propagates this as
  honest `ledger_failed` failures instead of writing phantom money. This is
  the circuit-breaker that prevents two sides of a partition from both
  believing they hold the ledger.
- **Redis locks are advisory only.** `SET NX EX` idempotency locks
  (payment initiation) and the gateway limiter degrade gracefully; correctness
  never depends on them.
- **Real fencing = PG unique constraints + guarded transitions + TB consensus.**
  - PG: idempotency-key unique constraints (`payment_intents.idempotencyKey`,
    escrow `escrow-hold:{orderId}`) and single-statement guarded transitions
    (`UPDATE ... WHERE status IN (...) RETURNING` with rowCount checks) make
    double-claim impossible even under a webhook storm.
  - TigerBeetle: double-entry transfers with deterministic ids —
    `uuid5(NAMESPACE_URL, idempotency_key)` (`deterministic_id` in
    `rust/ledger-bridge/src/main.rs`) — so a retry targets the SAME transfer
    id and TB's own consensus/dedup rejects duplicates. TB is the system of
    record for balances; its cluster consensus is the actual quorum.
- **Rust services have zero Redis dependency.** `ledger-bridge` and
  `recon-worker` do not link a Redis client at all (see their `Cargo.toml`s) —
  a Redis outage cannot double-reserve or double-post at the ledger, and recon
  keeps classifying/repairing against PG + the bridge only.

## Multi-node TigerBeetle deployment notes

- Run TB as a **3- or 5-replica cluster** (odd quorum); `ledger-bridge` takes
  the replica address list via `TIGERBEETLE_ADDRESS` and the shared
  `TIGERBEETLE_CLUSTER_ID`.
- Never run two independent single-node TB instances behind one bridge — that
  is the split-brain the 503 fail-closed behavior guards against; a bridge
  that cannot reach quorum must stay down, not fall back.
- Pending transfers carry `pending_timeout_secs`; on replica failover, recon's
  orphan-void sweep (200/400-409/5xx classification above) converges any
  reservation whose payment never confirmed.
- Backups: replicate the TB data file per the official replication protocol —
  do NOT file-copy a running replica.

## Test inventory (this branch)

| Suite | Command | Covers |
|---|---|---|
| `server/redisOutage.test.ts` | `npx vitest run` | item 1 |
| `server/webhookStorm.test.ts` | `npx vitest run` | item 2 (100 duplicates → 1 side-effect) |
| `server/feeInvariant.test.ts` | `npx vitest run` | item 3 (~200 random kobo amounts) |
| `server/sagaRollback.test.ts` | `npx vitest run` | item 4 |
| `server/ledgerOutage.test.ts` | `npx vitest run` | item 7 (TB down) |
| `server/temporalOutage.test.ts` | `npx vitest run` | item 7 (Temporal down) |
| `services/gateway/internal/ratelimit/ratelimit_test.go` | `go test ./...` | item 6 (fail-open dev) |
| `rust/ledger-bridge` tests | `cargo test -p ledger-bridge` | item 5 + uuid5 dedup |
| `rust/recon-worker` tests | `cargo test -p recon-worker` | item 7 (void classification) |
