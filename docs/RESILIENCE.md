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

## Backups (W39, PLT-1/PLT-2/PLT-8)

### Postgres — live cluster (`k8s-flux/backups/postgres-backup.yaml`)
This is what protects the deployed database. The compose/`k8s/` material further
down is the older single-node dev overlay and is **not** what runs on the cluster.

- **Where the data lives.** The app's DSN (`whatsapp-postgres-dsn`) points at the
  shared CloudNativePG cluster `pg-meridian` (ns `meridian`, PG 18, one instance,
  5Gi local-path PVC), database `whatsapp_commerce` (~24 MB). It is *not* in
  `pg-oracle` (that cluster's database is `ucard_oracle`). No CNPG cluster in the
  environment has a `ScheduledBackup`/`Backup`, and WAL archiving is not
  configured, so before this job existed **nothing** backed the data up.
- **`postgres-backup`** (nightly 03:15 UTC): `pg_dump --format=custom` with the
  same-major client image as the server (`ghcr.io/cloudnative-pg/postgresql:18.4…`
  — the old `k8s/backups.yaml` job uses `postgres:16` and cannot dump a PG 18
  server), read-only, from our namespace. Writes `.dump` + `.sha256` + `.counts`
  + `.meta` to PVC `postgres-backups`, keeps the newest 14. A dump is renamed
  into place only after `pg_restore --list` proves it has at least as many tables
  as the live DB, so a partial file is never mistaken for a backup.
- **`postgres-restore-verify`** (weekly, Sun 04:30 UTC): mounts the PVC
  **read-only**, checks age (≤ 36 h) and checksum, restores the newest dump into
  a throwaway Postgres inside the pod, and fails unless tables, foreign keys and
  migrations match and no table that had rows came back empty. A backup that has
  never been restored is not a backup — this is what proves it.
- **Alerts** (`deploy/otel/alert-rules.yml`, group `whatsapp-backups`):
  `PostgresBackupStale` (>26 h or series missing), `PostgresBackupRunFailing`
  (latest scheduled run of either job unsuccessful for 30 m),
  `PostgresRestoreVerifyStale` (>8 d). The shared Prometheus loads rules from the
  monitoring stack's ConfigMap, so that repo must import this group for them to
  fire.
- **Measured on the live cluster (2026-09-21):** backup 709 KB, 268 tables, 46
  FKs, 156 migrations, 1 s; restore-verify OK with rows 323 → 323; a deliberately
  truncated dump planted as the newest file was rejected and the job failed. The
  database is tiny, so this RTO says nothing about production volume — re-measure
  as data grows.
- **What this does NOT cover (be honest about the gap):**
  - The PVC is a local-path volume on the **same host** as the database. It
    protects against logical loss (bad migration, `DELETE`, dropped table,
    corruption noticed within 14 days; RPO ≤ 24 h). It does **not** protect
    against losing the host/disk. An off-host copy (object storage outside the
    cluster host, or CNPG `barmanObjectStore`) is still required and needs a
    destination the platform team must provide.
  - No point-in-time recovery. That needs WAL archiving on the CNPG cluster,
    which is another project's `Cluster` spec (and a restart), so it is a
    decision for `pg-meridian`'s owner.
  - Keycloak's own database (`keycloak-postgresql`) and TigerBeetle (ns
    `tigerbeetle`) are shared services owned elsewhere; neither is backed up by
    this job. The app holds no TigerBeetle data yet (the ledger-bridge is not
    wired to it), so a TigerBeetle backup becomes this project's obligation once
    it is; when wired, `ledger_transfers` is written to Postgres and therefore
    *is* covered by the dump above.
- **Restore procedure:** `kubectl -n whatsapp-commerce create job --from=cronjob/postgres-restore-verify drill-$(date +%s)`
  proves the latest dump restores. To restore for real, run `pg_restore
  --no-owner --clean --if-exists --dbname=<target>` from the same image against a
  pod that mounts `postgres-backups`, after verifying the checksum; scale the app
  to 0 first so nothing writes during the restore.

### Postgres — older dev overlay
- `k8s/postgres.yaml` data volume is now PVC `postgres-data` (10Gi). Minimal-
  change choice: standalone PVC + existing Deployment (Recreate) instead of a
  StatefulSet conversion — single-replica dev overlay, Recreate already
  guarantees at-most-one writer, and a StatefulSet would rename the pod
  identity for zero durability gain here. `tmp`/`run` remain emptyDir by
  design (ephemeral sockets/pids only).
- `k8s/backups.yaml` CronJob #42 `cron-postgres-backup` (`0 3 * * *`):
  `pg_dump --format=custom | gzip` into PVC `postgres-backups` (20Gi) with
  7-day in-job retention (`find -mtime +7 -delete`).
- Object storage: if `S3_BUCKET` (plus `S3_ENDPOINT`/`S3_ACCESS_KEY`/
  `S3_SECRET_KEY`, the env.example.txt S3 block) is present in
  `platform-secrets`, the job also uploads to `s3://$S3_BUCKET/pg/`. Configure
  a 7-day bucket lifecycle rule for off-cluster retention — the job does not
  prune remote objects.
- HONEST DEGRADE: without S3 configured, the in-cluster PVC copy is the ONLY
  backup — node/AZ loss can still lose it. The job logs this explicitly.

### TigerBeetle
- `k8s/tigerbeetle.yaml` data volume is now PVC `tigerbeetle-data` (5Gi).
- TB 0.16.x has no snapshot API. Two honest paths:
  1. **Offline copy (safe, preferred):** `scripts/backup/tigerbeetle-backup.sh`
     scales the replica to 0, copies the data file off the PVC, scales back.
     Brief ledger unavailability; use in a maintenance window.
  2. **CronJob #43 `cron-tigerbeetle-backup` (`0 4 * * 0`):** crash-consistent
     copy of the LIVE data file to the backup PVC, 7-day retention. Dev safety
     net only — a torn tail is possible, so restores should prefer an offline
     copy. Mounts the same RWO volume as TB: both must schedule on the same
     node (fine in the single-node dev overlay; a multi-node cluster must add
     node affinity or use RWX storage).
- Production ledger durability requires a 3-replica TB cluster (VSR
  replication) per the multi-node notes above; backups complement, never
  replace, replication.

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

## W42 — Temporal versioning, real-PG money paths, PG pool leaks (PLT-10 / PLT-15 / PLT-17)

### PLT-10: Temporal workflow versioning + auto-approve stubs removed

- **Versioning story.** `@temporalio/workflow` is not a declared dependency
  (only `@temporalio/client` is), so `patch()` is unavailable at typecheck
  time. `services/temporal-workflows/workflows.ts` now carries **deterministic
  version constants** (`WORKFLOW_VERSIONS`) plus a `patched()`-compatible
  `versionGate(workflow, changeId, minVersion)` marker at every
  behavior-change point (`no-auto-approve-kyc`, `no-auto-confirm-payment`).
  The rule: never delete a code path below its recorded version — the same
  discipline Temporal's `patch()` enforces; change ids carry over if the SDK
  is adopted. The worker pins a deterministic **build id**
  (`WORKER_BUILD_ID`, overridable via `TEMPORAL_WORKER_BUILD_ID`) passed to
  `Worker.create({ buildId })` for Temporal worker versioning.
- **Auto-approve stubs REMOVED.** The old stub activities returned fixed
  values (`waitForKycApproval → "approved"`, `confirmPayment → true`,
  `reserveInventory → true`) — enabling the worker in prod would have
  auto-approved KYC and auto-confirmed payments. Activities now throw
  `activity_not_wired` unless REAL handlers are registered via
  `registerActivityHandlers()` (worker.ts wires its API-backed handlers at
  boot). Money/KYC paths never fabricate success.
- Pinned by journeys **J317** (version markers present, gates deterministic)
  and **J321** (unwired activities honestly fail; no fixed "approved").

### PLT-15: money paths tested against real PG (integration profile)

- The default sim world is PGlite; behaviors that only exist in real PG
  (`pg_advisory_xact_lock` in `server/routers/loyalty.ts`, `FOR UPDATE SKIP
  LOCKED` in `inventory.ts`, deferrable/unique partial indexes from
  migrations 0088/0099) are invisible there. **PGlite limitation, honestly
  stated:** PGlite is single-connection, emulates some wire behavior, and its
  lock/constraint semantics are not a proof of production behavior.
- **Real-PG profile (opt-in):** `docker-compose.yml` already ships a
  `postgres:16-alpine` service. `npm run test:pg-integration`
  (`scripts/pg-integration-money-paths.ts`, gated on `PG_INTEGRATION=1`)
  creates a scratch database on that server, applies ALL migrations, and runs
  the W38 refund/clawback money-integrity suite (J247–J253) via the
  simulation runner booted in external-PG mode (`SIM_DATABASE_URL`, see
  `simulation/world.ts` "W42 pg-integration"). The scratch DB is dropped on
  exit.
- **Honest skip:** without `PG_INTEGRATION=1`, or with PG unreachable
  (non-strict), the script prints the exact enable steps and exits 0 — it
  never silently fabricates a pass. `PG_INTEGRATION_STRICT=1` turns
  unreachable-PG into a hard failure for CI.
- Pinned by journey **J318** (gate is honest-skip when disabled, enabled with
  URL when `PG_INTEGRATION=1`).

### PLT-17: PG pool exhaustion — leak-free client swap + bounded queue

- **Client-swap leak FIXED.** `withRetry()` previously nulled `_db`/`_client`
  on transient errors and dropped the old postgres.js pool un-ended — its
  sockets leaked under error bursts. Now `resetDbConnection()` ends the old
  client (bounded 5s wait) BEFORE swapping; `getDbPoolResetCount()` exposes
  the swap count for regression pinning (journey **J319**).
- **Bounded queue.** postgres.js queues pending queries internally with no
  depth limit. `withRetry()` now sheds load: when in-flight/queued ops reach
  `PG_POOL_QUEUE_MAX` (default 4× `PG_POOL_MAX`, floor 25) the call rejects
  immediately with `db_pool_queue_saturated` (code
  `DB_POOL_QUEUE_SATURATED`, status 503) instead of hanging behind a pile-up
  (journey **J320**). Session-level `statement_timeout` (30s),
  `lock_timeout` (10s) and `idle_in_transaction_session_timeout` (60s) —
  overridable via `PG_STATEMENT_TIMEOUT_MS` / `PG_LOCK_TIMEOUT_MS` /
  `PG_IDLE_TX_TIMEOUT_MS` — bound how long a stuck query can hold a pooled
  connection in the first place.
