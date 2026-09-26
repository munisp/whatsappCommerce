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
- **The ledger never gates `/health/ready`.** Readiness exists to drain a pod
  that is individually broken. The ledger-bridge is shared by every server
  replica, so failing readiness on it drains *all* of them at once and turns a
  payments-only outage into a platform-wide one — measured on the live cluster
  (chaos CX-02): a bridge restart left the Service with no endpoints, every
  server pod went unready, and every route (catalog, auth, webhooks included)
  returned 503 for 28 s (81 % availability). `checkTigerBeetle()` therefore
  reports `degraded` (`ok: true`) for every failure mode — bridge unreachable,
  non-2xx, or reachable with TigerBeetle/Postgres down — and payments fail
  honestly at the point of use (`payment.initiate` → `ledger_failed`, pinned by
  `ledgerOutage.test.ts` for both HTTP 503 and a dead network path). It stays
  visible: the `degraded` flag is on `/health/ready`, and it is alertable
  independently of readiness — `ComponentDown` (`infra_component_up{component=
  "tigerBeetle"}`, 5 m) when the bridge itself is unreachable, and
  `TigerBeetleUnreachable` (blackbox probe) / `TigerBeetleOpErrors` (bridge
  spans) when TigerBeetle is down behind a live bridge. (The gauge alone cannot
  see that state: the bridge's `/health` answers 200 either way.) Not gating is
  safe *because* the
  ledger fails closed; running the bridge with `LEDGER_ALLOW_INMEMORY=true`
  outside dev (it fabricates results) would invalidate that, and this decision
  would have to be revisited.
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

## Ledger wiring (bridge → adapter → TigerBeetle)

```
server ──HTTP──▶ ledger-bridge (Rust :8095) ──HTTP, loopback──▶ tb-adapter (Node, sidecar) ──native protocol──▶ TigerBeetle
                       │                                                                                     (shared, ns `tigerbeetle`)
                       └──▶ Postgres (ledger_transfers journal + durable idempotency)
```

**History — read this before trusting older ledger claims.** `rust/ledger-bridge`
talks HTTP to "a TigerBeetle HTTP sidecar". Native TigerBeetle has no HTTP API and
no such sidecar existed anywhere in this repo: the only implementation of the
bridge's `/api/v1` contract was the in-memory test double
(`tests/e2e/fixtures/tb-sidecar.mjs`), and the e2e stack also ran the bridge with
`LEDGER_ALLOW_INMEMORY=true`, which would have hidden a failing TigerBeetle call.
So the bridge's TigerBeetle path had never run against a real ledger. `services/
tb-adapter` is that sidecar. Building it against real TigerBeetle 0.16.66 found:

1. **The bridge's transfer flags are not TigerBeetle's.** Bridge 4/8/16
   (pending/post/void) vs TigerBeetle 2/4/8. Forwarded unchanged a *commit* is
   executed as a *void* and nothing is ever posted. The adapter translates;
   `server/tbAdapter.integration.test.ts` proves the collision by sending the raw
   flags to a real cluster.
2. **`amount: 0` does not mean "post everything"** in 0.16 — it posts nothing and
   consumes the hold. The adapter sends `AMOUNT_MAX` for a full commit.
3. **TigerBeetle remembers failed transfer ids** (`id_already_failed`). An account
   must exist *before* the first attempt; "try, create the account, retry" burns
   the id, and the bridge derives ids from the idempotency key. The adapter
   ensures accounts first (cached; accounts are never deleted).
4. **Provisioning and transfers disagreed about account ids and ledgers.**
   `/accounts/provision` mints a random id in ledger 700 that the server ignores;
   transfers use deterministic ids in ledger 1 that nothing created. The test double
   auto-created unknown accounts, which is why nobody saw it. The adapter does the
   same (`AUTO_CREATE_ACCOUNTS=true`, the transfer's own ledger, code 1000).
   `/accounts/provision` is now vestigial — it leaves one orphan account per
   (type, tenant, currency) per server restart. Fixing it properly means the server
   provisioning the ids it actually uses.
5. **Nothing stops an overdraft.** Accounts are created with no flags, so
   TigerBeetle itself accepts a reserve of ₦10,000 from a never-funded account
   (balance −1,000,000 kobo, observed). Inbound-payment "float" accounts
   legitimately go negative, but merchant/wallet accounts probably should not
   (`debits_must_not_exceed_credits`). Solvency is currently enforced, if at all,
   above the ledger — **an owner decision, not changed here**.

**Deployment (live).** `k8s-flux/ledger-bridge-deployment.yaml`: the adapter is a
second container in the bridge pod, listening on `127.0.0.1:3000` only (an
unauthenticated endpoint that can write the ledger must not be on the pod IP; there
are no NetworkPolicies). Consequences that were learned the hard way:
- The TigerBeetle client uses **io_uring**, which the runtime-default seccomp
  profile blocks — the sidecar sets `seccompProfile: Unconfined` explicitly (all
  other hardening stays: non-root, read-only rootfs, no capabilities).
- Liveness is an **exec** probe: kubelet TCP/HTTP probes connect to the pod IP, which
  a loopback-only listener refuses (it restart-looped on the first rollout). There is
  no readiness probe on purpose — a sidecar failing readiness would pull the bridge
  out of its Service; TigerBeetle health is already `tigerbeetle.healthy` on the
  bridge's `/health`.
- The adapter resolves `tigerbeetle-0.tigerbeetle-headless…` to an IP on every
  reconnect (TigerBeetle clients need IPs; the pod IP changes on restart) and bounds
  every call at 4 s, so a dead TigerBeetle answers 503 instead of hanging.
- `LEDGER_ALLOW_INMEMORY=false` is set explicitly; the bridge takes `DATABASE_URL`
  from the same secret as the app, so it follows the app if the database moves.

**Verified.** 57 unit tests (CI) + 21 integration tests against a real TigerBeetle
(env-gated); the real bridge container with the fallback off passed the repo's
bridge-level e2e ledger tests; a live smoke on the cluster (reserve → commit →
replay → reverse → void, all `"source":"tigerbeetle"`, journal rows present);
TigerBeetle stop/start: every call fails with `ledger_unavailable` ("refusing to
fabricate a ledger result"), and reserves work again with neither the adapter nor
the bridge restarted.

**Not done / limits.**
- `ledger-bridge` stays **one replica**; it is still the payments SPOF. Scaling it
  needs multi-replica replay to be tested first.
- The shared TigerBeetle is a **single replica with no backup** and is owned
  elsewhere. Payments now depend on it; that is a production blocker in its own right.
- `recon-worker` has no `DATABASE_URL` and its QA-029 fix is undeployed, so nothing
  reconciles the ledger against payment intents yet.
- Only the bridge was exercised on the live cluster; the server's `payment.initiate`
  → bridge path needs an authenticated tenant session and was not run live.
- Images are locally shipped (`whatsapp-tb-adapter:qa-local1`, `imagePullPolicy:
  Never`). CI now builds `tb-adapter` and — fixed here — builds `ledger-bridge` from
  `rust/ledger-bridge` instead of the deprecated `services/ledger-bridge` shim, which
  would otherwise have replaced the working bridge on the next release. The GitOps
  repo still needs an ImagePolicy for `whatsapp-tb-adapter`.
- To re-run the real-TigerBeetle tests: see the header of
  `server/tbAdapter.integration.test.ts`.

## Multi-node TigerBeetle deployment notes

- Run TB as a **3- or 5-replica cluster** (odd quorum); the `tb-adapter`
  sidecar takes the replica address list via `TB_ADDRESSES` and the real
  cluster id via `TB_CLUSTER_ID` (see "Ledger wiring"). The bridge itself only
  knows the adapter's HTTP address (`TIGERBEETLE_ADDRESS`).
- Never run two independent single-node TB instances behind one bridge — that
  is the split-brain the 503 fail-closed behavior guards against; a bridge
  that cannot reach quorum must stay down, not fall back.
- Pending transfers carry `pending_timeout_secs`; on replica failover, recon's
  orphan-void sweep (200/400-409/5xx classification above) converges any
  reservation whose payment never confirmed.
- Backups: replicate the TB data file per the official replication protocol —
  do NOT file-copy a running replica.

### Reality on this cluster (QA-034/036): one shared instance, three tenants, reformatted to 3 replicas

TigerBeetle here is **shared cluster-wide infrastructure, not ours** — ns
`tigerbeetle`, live-confirmed to also serve `lanai` (`lanai-portal`) and
`vpp` (`vpp-orchestrator`, `vpp-server`) in addition to `whatsapp-commerce`.

**Growing it to multiple replicas is not a live operation.** Confirmed from
the TigerBeetle 0.16.66 CLI itself (`tigerbeetle --help`): `format` fixes
`--replica-count` into a replica's data file permanently, and `recover` only
rebuilds a replica whose file was *lost*, within a cluster whose *other*
replicas already agree on the same replica-count — it cannot change an
existing cluster's replica-count. Taking a running single replica to 3
replicas means reformatting **every** replica from scratch, destroying
whatever was in it.

An earlier version of this work stood up a *separate*, dedicated 3-replica
TigerBeetle cluster for just `whatsapp-commerce` instead. That was the wrong
shape: the point of a *shared* TigerBeetle is that every tenant uses the
*same* instance, the same way `postgres-oracle` is one shared Postgres for
many projects rather than each project running its own. It was torn down.
While it briefly ran, its elected primary was deleted and recreated by
something other than this work (not a liveness-probe failure, not OOM, and
the app's Flux Kustomization was suspended and hadn't reconciled) — self-
healed in ~16 s via a benign data-file-lock crash-loop, cause unidentified.

**Reformatted live, 2026-09-21, at the owner's explicit direction** (the data
on the single replica was, by that point, QA/smoke-test data only — nothing
production-real had been built on the shared instance for any tenant yet).
A pre-reformat offline backup was attempted (scale to 0, copy the ~1.1 GiB
data file off the PVC to local disk) but the `kubectl cp` transfer failed
partway (`unexpected EOF`, checksum mismatch on the partial file) — the
resulting single-replica history is not recoverable. The instance was down
(0 replicas, so `lanai`/`vpp`/us all lost ledger access) for the ~15 minutes
this took. `k8s-flux/tigerbeetle-shared-reference.yaml` documents the applied
StatefulSet (not Flux-managed — this namespace isn't this project's to own —
so this file is a record, applied by hand, not part of any Kustomization).

The new cluster keeps the SAME cluster id (`145851240909969808468846706535455565498`)
and the SAME per-replica hostnames (`tigerbeetle-0/1/2.tigerbeetle-headless.tigerbeetle.svc.cluster.local:3000`,
resolved to an IP by each consumer's adapter at connect time — TigerBeetle
takes literal IPs only, and pod IPs change on restart, which is why each
replica's own startup script resolves all three hostnames itself rather than
relying on any static addressing). One replica now schedules onto the
control-plane node (tolerating its taint) since the two worker nodes were
already at 92–97% allocated CPU.

**Verified live:** all 3 replicas came up healthy, one per node, quorum
formed (view-change → elected primary) within seconds. A real reserve/void
through our bridge succeeded immediately, still addressed by only
`tigerbeetle-0` at that point — confirming existing single-address clients
(unmodified `lanai`/`vpp` configs) keep working against the new cluster.
Force-killing the elected primary under active writes produced **zero
failed writes** — VSR failed over to a new primary among the remaining two
instantly — and the killed replica rejoined within ~18 s.

**A client that only knows one replica address still works** (confirmed:
TigerBeetle forwards internally to whichever replica is primary) **but has
no fallback if that one specific replica goes down**, even with the other
two healthy — confirmed the opposite way too: stopping the *only* address a
test client knew, while the other two replicas stayed up, failed every
request from that client. So growing the cluster gives no redundancy to a
consumer until that consumer's own client config lists more than one
address.
- **Our bridge:** updated to list all three hostnames
  (`k8s-flux/ledger-bridge-deployment.yaml`) — applied live. We get the full
  benefit.
- **`lanai` and `vpp`:** still only configured with `tigerbeetle-0`. They
  keep working (their one known replica is up), but have no fallback if it
  specifically goes down, even though the cluster now tolerates that loss
  for everyone else. Their manifests are not this project's to edit —
  telling them to add the other two addresses is a follow-up for whoever
  owns those deployments, not something done here.

**What's live:** the 3-replica TigerBeetle cluster; our bridge at 2 replicas
with `PodDisruptionBudget`s (`maxUnavailable: 0` rollouts, spread over
nodes) and all three TigerBeetle addresses.
**What's written but not yet applied:** the server Deployment's equivalent
2-replica/PDB change and the `recon-worker` database wiring
(`k8s-flux/server-deployment.yaml`, `k8s-flux/recon-worker-deployment.yaml`),
pinned by `server/availabilityManifests.test.ts` /
`server/ledgerWiringManifests.test.ts`.
**What's NOT yet live:** the ledger-bridge and recon-worker container
IMAGES themselves still need rebuilding and reshipping to the cluster nodes
to pick up the QA-033 (ledger contract: overdraft protection, single-phase
legs, idempotent retries) and QA-035 (webhook path never committed the
ledger reservation) fixes — the live bridge is still running the
2026-08-31 build.

## Internal service authentication (QA-026, QA-038)

Two independent layers protect the three services that used to trust the network — `ledger-bridge`, `recon-worker`, `commerce-engine`:

1. **NetworkPolicy** (`k8s-flux/network-policies.yaml`) — *who may connect*. Ingress-only allowlists: bridge ← `server`, `recon-worker`; recon-worker ← `server`; commerce-engine ← `event-processor`. kindnet enforces these on this cluster (tested, not assumed). No default-deny, no egress rules: a wrong guess there is an outage.
2. **Shared secret** — *who may ask*. Every route except `/health` (and the bridge's `/health/ready`) requires `X-Internal-Api-Key` (`X-Internal-Token`/`X-Api-Key` also accepted), compared in constant time to `INTERNAL_API_KEY`. Same Secret and key everywhere: `whatsapp-server-internal-api-key`, key `INTERNAL_API_KEY`. This is the convention `server`'s `internalProcedure` and `gateway`'s `InternalTokenAuth` already used, not a new one.

**Semantics:** key **unset** on a service = allowed, with a startup warning (this is the "callers not updated yet" rollout stage); key **set** = enforced immediately. `commerce-engine` additionally fails closed (503) when `ENV=production`. Rejections are logged (`rejected request: missing or invalid internal API key`, method + path, never the key) — a caller that lost the header is otherwise invisible from the callee's side.

**Adding a caller** of any of these: give its Deployment `INTERNAL_API_KEY` from the Secret above, send it in the call, and add it to the NetworkPolicy allowlist. `server/internalAuthManifests.test.ts` and `server/networkPolicyManifests.test.ts` fail if a Deployment is pointed at one of these services without both. Send the key **only** to the service that needs it — `event-processor` fans out to five and scopes it to commerce-engine.

**Rolling it out / changing the secret — order matters, callers before callees:** (1) deploy the callers sending the header (harmless: nothing enforces yet), (2) deploy the callees with the key unset and confirm they are still open, (3) set the key on the callees. Reverse it the same way to roll back. **Emergency off-switch:** remove `INTERNAL_API_KEY` from a callee (`kubectl patch` … `remove` the env entry) and it returns to open-with-a-warning — instant, no image change. Note `recon-worker` already carried the key (it sends it to the platform), so a new recon-worker image enforces the moment it starts: deploy `server` first.

**Deployment hazard:** the manifests in `k8s-flux/` pin the *registry* image tags (and `tb-adapter:qa-local1`, since removed from the nodes). While the cluster runs hand-shipped `qa-local*` images with Flux suspended, **do not `kubectl apply` a service's manifest** to change one env var — it reverts the image and can take the service down. Use a targeted `kubectl patch --type=json` that adds only the env var. (Diff first: `kubectl diff -f` shows whether a manifest has image drift.)

**What this does not cover:** the shared TigerBeetle and `postgres-oracle` namespaces have no NetworkPolicy and TigerBeetle has no protocol-level auth (another team's namespaces — see QA-038); one shared secret means compromise of any holder is compromise of all; a `podSelector` trusts labels, so RBAC on the namespace matters; and an *empty* secret value would leave the Rust services open (a *missing* Secret stops the pod).

## Termination, rollouts, scaling and the resume gate (QA-041, QA-042)
Everything here was **measured on the live cluster**, with probes that run while the thing is being disturbed. The evidence and the mistakes are in `.qa/defects.md` (QA-039…042); this is what an operator needs.

**Terminating a pod must not fail a payment.** Kubernetes sends SIGTERM on every pod deletion — a rollout, a drain, a scale-down, an eviction. Every Rust service now handles it (drain, then exit); before, `ledger-bridge` ignored it as PID 1 and lived on for the whole 30 s grace period while its Node sidecar exited within 3 s, so every termination was a 30 s window of `503 ledger_unavailable` for clients pinned to that pod (measured: deleting one of two healthy replicas = 72.6 % availability, 150 failed reserves). The bridge pod now sequences its own shutdown: `preStop` sleep 5 s (the Service needs a moment to stop sending it new connections) → SIGTERM → drain; the `tb-adapter` sidecar sleeps 10 s so it **outlives the drain**. Measured after: rollout, graceful delete and abrupt delete (`--grace-period=0 --force`) of a bridge pod all **100.000 %** at 5 reserve→void/s.
- **Money-path probe:** `.qa/chaos/ledger-probe.mjs` — run it from a `server` pod so it uses that pod's own internal key: `kubectl -n whatsapp-commerce exec -i deploy/server -c server -- env PROBE_RPS=5 PROBE_SECONDS=90 node - < .qa/chaos/ledger-probe.mjs`. It drives real reserve→void pairs through bridge → adapter → shared TigerBeetle and reports failure *windows*. `/health` says a pod is up; this says money can still move. **Use it for any change that touches the bridge.**
- **Public probe:** `ssh newwaveclaw@america 'node - --url https://wa-app.newfire.app/api/trpc/auth.me --rps 10 --seconds 120' < .qa/chaos/probe.mjs` (from the host: the laptop's network to the public URL is unreliable).

**Replicas must not share a node.** A soft spread is only a preference, and the constraint's selector spans revisions, so a rolling update used to co-locate both replicas by chance (twice in a row). Both `server` and `ledger-bridge` now use `matchLabelKeys: [pod-template-hash]`. **After every rollout run `scripts/qa-local-ship.sh check-spread <deployment>`** — it fails if every replica is on one node and tells you how to fix it (delete one pod). The monitoring handoff has an alert for the same condition.

**Autoscaling.** `metrics-server` is installed (kube-system; `k8s-flux/cluster-addons/metrics-server.yaml`, hand-applied — not part of the app Kustomization). `server` has an HPA (`k8s-flux/server-hpa.yaml`): min 2, max 4, target an *absolute* 600 m per pod (not a Utilization %, which is relative to the deliberately small 100 m CPU request). The Deployment deliberately does **not** set `replicas`, or Flux would re-apply it and fight the autoscaler. **One gotcha at Flux-resume time:** removing `spec.replicas` from an already-applied Deployment resets it to 1 until the HPA re-scales it (seconds) — do not resume during peak. The workers are ~98 % *requested* but ~10 % *used*; 56 % of all requested CPU belongs to one other namespace, ours is 2.6 %.

**Overload.** One Node process saturates at ~1.1–1.3 k rps. In a closed loop (clients wait for replies) the tail is bounded — p99 ≈ 0.9 s at 800 concurrent, measured from inside the network (an earlier "13 s" figure was an artifact of the load driver's path; see `.qa/perf/summary.md`). In an **open loop** at 2× capacity the queue grows without bound (served p50 7–10 s, p99 ≈ 56 s) — and an in-process event-loop load shedder did **not** help (it engaged on 38 of ~44,000 requests, because the queue sits in the kernel accept/read path *ahead of any middleware*); it was removed. What protects the platform is scale-out (the HPA) and **limits at the ingress, which I did not inspect** — check its connection limits and queue timeouts before promising anything about a traffic spike.

**Do not resume Flux until the gate is green.** `npx tsx scripts/fluxResumePreflight.ts` (read-only) lists what would break: unpushed commits, hand-shipped `qa-local*` tags and `imagePullPolicy: Never` in the manifests, images no ImagePolicy will ever update (today: `tb-adapter` — resuming would leave the ledger-bridge pods unable to start), autoscaled Deployments that still set `replicas`, and drift a resume would revert. Fixes for the parts that belong to other repos are in `docs/handoff/`.

**Shipping images.** `scripts/qa-local-ship.sh ship …` verifies the artifact (`--expect` new code, `--absent` removed code) before streaming it, keeps the previous tag on the nodes as a rollback target (before this, none were left), and prints — but does not run — the rollout command. When the link is slow (a Tailscale relay managed 23 KB/s on 2026-09-21), `scripts/qa-local-delta-ship.sh` sends only the changed binary or `dist/` and rebuilds on the host. **Never `kubectl apply` a repo manifest to change one thing** while Flux is suspended: the repo pins registry tags and would revert the running images. Use `kubectl set image` or a targeted JSON patch.

**Tracing.** The four Rust services export OTLP over gRPC and must target the collector's port **4317** (a test reads each service's source to enforce this). They were pointed at the HTTP port 4318 and every export failed silently; the ledger bridge now appears in Jaeger.

## Backups (W39, PLT-1/PLT-2/PLT-8)

### Postgres — live cluster (`k8s-flux/backups/postgres-backup.yaml`)
This is what protects the deployed database. The compose/`k8s/` material further
down is the older single-node dev overlay and is **not** what runs on the cluster.

- **Where the data lives.** Since 2026-09-21 the app's DSN (`whatsapp-postgres-dsn`)
  points at the centralised shared CloudNativePG cluster `pg-oracle` (ns
  `postgres-oracle`, PG 18.6, **one instance, 5Gi local-path PVC, ~45 databases**,
  `enableSuperuserAccess=false`), database `whatsapp_commerce` (~24 MB), login role
  `whatsapp` (connection limit 50) — both declared in
  `k8s-flux/postgres-oracle/whatsapp-commerce-db.yaml` (applied by the platform team;
  the operator creates them, no superuser needed). No CNPG cluster in the environment
  has a `ScheduledBackup`/`Backup`, and WAL archiving is not configured, so before
  this job existed **nothing** backed the data up. **Centralising improved
  manageability, not durability:** it is still one instance on one local-path disk,
  now shared by ~45 databases, so its blast radius is larger than `pg-meridian`'s was.
- **The move (2026-09-21).** From `pg-meridian` (ns `meridian`). A different, older
  `whatsapp_commerce` already existed on `pg-oracle` (133 tables, 234 rows); it was
  dumped to `/backups/legacy-oracle/` (checksummed) and renamed
  `whatsapp_commerce_legacy_20260921` — nothing was deleted. The live data was
  restored behind a write freeze (all six DB clients, including the ledger bridge, scaled
  to 0 for ~95 s) with a single-transaction `pg_restore` and verification of tables,
  keys, indexes, enums, migrations, every table's row count and every sequence position,
  plus a negative control proving the verifier fails on one stray row. **Rollback:** the
  old copy on `pg-meridian` is frozen at the cutover and untouched; the previous DSN is
  kept as `DATABASE_URL_PREV_MERIDIAN` in the same secret. To roll back, copy it into
  `DATABASE_URL` and restart the six clients (server, commerce-engine,
  payment-orchestrator, conversation-orchestrator, webhook-ingestor, ledger-bridge);
  writes since the cutover are not in the old copy. Delete both once the retention
  window has passed.
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
- **Off-host copy (QA-034): supported, not yet configured.** The PVC is a
  local-path volume on the **same host** as the database, so on its own the
  backup protects against logical loss (bad migration, `DELETE`, dropped
  table, corruption noticed within 14 days; RPO ≤ 24 h) but not against losing
  the host/disk. `postgres-backup.yaml` now also uploads (and verifies — size
  check plus a content round-trip for dumps ≤512 MB) to any S3-compatible
  bucket, via an *optional* Secret `postgres-backup-offhost` (`bucket`,
  `access_key`, `secret_key`, `endpoint`, `region`, `prefix`). A **configured**
  upload that fails, or round-trips to different bytes, fails the whole job
  (and so `PostgresBackupRunFailing`) — this is deliberately not a
  best-effort side channel. Tested against S3-compatible stubs on the live
  cluster: a good copy, a same-size corrupted copy (caught), a rejected
  upload (caught), and unconfigured (a logged `WARNING`, job still succeeds).
  **What's missing is a destination** — no bucket has been provisioned yet;
  until `postgres-backup-offhost` exists the job logs that warning every
  night and this gap is real.
  - `barmanObjectStore` WAL archiving on the CNPG cluster is a separate,
    bigger step (native continuous backup + point-in-time recovery instead of
    a nightly logical dump) and is another project's `Cluster` spec — that
    decision belongs to `pg-oracle`'s owner, not to this job.
  - Keycloak's own database (`keycloak-postgresql`) is a shared service owned
    elsewhere and is not backed up by this job.
  - TigerBeetle (`ns whatsapp-tigerbeetle`, see "Multi-node TigerBeetle
    deployment notes") has no independent backup mechanism of its own (0.16.x
    has no snapshot API — see the older-overlay TigerBeetle section below);
    its durability comes from the 3-replica quorum. `ledger_transfers` (the
    journal the bridge writes) lives in Postgres and *is* covered by the dump
    above.
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

- **Versioning story.** *(Updated: the SDK is now adopted — `@temporalio/worker`,
  `workflow`, `activity`, `testing` are devDependencies.)* Workflow definitions in
  `services/temporal-workflows/workflows.ts` are real `@temporalio/workflow` code
  (`proxyActivities`, durable `sleep`/`condition`, signals). Version constants live in the
  sandbox-pure `versions.ts` (`WORKFLOW_VERSIONS`); the pseudocode-era `versionGate()` shim
  is gone — use `patched("<change-id>")` from `@temporalio/workflow` for any change that would
  alter an in-flight execution's command sequence. The worker pins a deterministic **build
  id** (`workerBuildId()`, overridable via `TEMPORAL_WORKER_BUILD_ID`) passed to
  `Worker.create({ buildId })` as a label (SDK worker versioning itself is off; the option is
  deprecated upstream in favor of Worker Deployments).
- **Auto-approve stubs REMOVED.** The old stub activities returned fixed
  values (`waitForKycApproval → "approved"`, `confirmPayment → true`,
  `reserveInventory → true`) — enabling the worker in prod would have
  auto-approved KYC and auto-confirmed payments. *(Updated: activities now live in
  `activities.ts`; a step with no backing internal endpoint throws a non-retryable
  `ActivityNotImplemented` instead — same doctrine. Only InventorySync is backed today.)*
  Previously: activities threw `activity_not_wired` unless REAL handlers were registered via
  `registerActivityHandlers()` (worker.ts wired its API-backed handlers at
  boot). Money/KYC paths never fabricate success.
- Pinned by journeys **J317** (version constants present, build id pinned and
  overridable, workflows are real SDK code) and **J321** (unbacked activities honestly
  fail; no fixed "approved").

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
