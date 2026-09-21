# Production readiness report — whatsappCommerce (world-class-qa, full pass)

Session: 2026-09-20 → 2026-09-21 · Branch `development` (all work committed locally — about 57 commits — **not pushed**) · Environments touched: this laptop, a local docker-compose e2e stack, and the live dev cluster `kind-newwave-dev` (namespace `whatsapp-commerce`, plus the shared `tigerbeetle` and `postgres-oracle` namespaces, which belong to other teams too).

This report was first written after pass 2 and **updated after pass 3** (the ledger, availability, login and service-to-service auth work, QA-033…QA-038). Where a section says "pass 3" it supersedes what pass 2 said.

## 1. Executive summary
The first pass fixed authorization, idempotency, e2e and probe defects (QA-001…QA-013). The second pass — done because the skill's own Definition of Done showed large areas untouched — went much wider and found **more, and worse, things**:

- **Two internet-reachable P0/P1 holes on the live domain**: `/api/finetune/stream` and `/api/finetune/export-yolo` had **no authentication at all** — one spawned a subprocess, the other returned every tenant's product images — and the export additionally **crashed the whole server** (archiver 8 API break → uncaught exception → process shutdown), so *any unauthenticated request could take the platform down*. Fixed, tested, and **deployed live and verified** (unauthenticated calls now return 403/401).
- **Any logged-in user of any tenant could read the platform's raw inbound WhatsApp payloads (customer phone numbers, message text), every tenant's revenue/GMV/COGS rate, and any tenant's order by number — and could wipe every tenant's image annotations** (QA-028, found by triaging *all* the matrix's unguarded rows, not just the three money-flagged ones). Fixed, tested, and **deployed live**.
- A **cross-tenant IDOR** leaking dispute-evidence bearer tokens, **SSRF** on four tenant-configurable integrations (one via an *unauthenticated* procedure that sends a real client secret), and **three ML-ops endpoints that spawn processes for any logged-in user** (one blocks the event loop for up to 60 s).
- Measured **capacity, resilience and deployment behavior** against the real cluster: rolling deploys, rollback and pod loss are genuinely zero-downtime (measured: 0 failures in 4,395 probes across four experiments).

**Pass 3 — the ledger, availability, login and service auth.** Pass 2 ended with "the ledger isn't wired to anything real". That is no longer true, and wiring it up is where the most serious money-path bugs turned up:

- **Testing against a real TigerBeetle found a defect class no earlier pass could have** (QA-031, QA-033, QA-035): the bridge had never talked to a real ledger; four contract errors between server, bridge and TigerBeetle; and no overdraft protection at all. **The worst: the webhook confirmation path — the one a real Paystack/Flutterwave callback takes — marked a payment completed without ever committing the ledger reservation.** The customer's money would have sat "reserved" until TigerBeetle auto-voided it 15 minutes later, while Postgres said "paid". It was found by the real-ledger e2e test, not by reading. Fixed, verified against a real ledger, and live.
- **Availability gaps closed** (QA-027, QA-034, QA-036): `server` and `ledger-bridge` run 2 replicas with PodDisruptionBudgets and a node spread; the server's memory limit now sits above its measured load footprint; the shared TigerBeetle is a 3-replica cluster (killing the elected primary under active writes: zero failed writes). `recon-worker` — which had *no database at all* and had never reconciled anything — now runs and reconciles every 5 minutes.
- **Security gaps closed** (QA-020, QA-026, QA-038): login CSRF and an open redirect on the SPA's primary login; ingress-only NetworkPolicies for three services that trusted the network; and application-level authentication on `ledger-bridge`, `recon-worker` and `commerce-engine`, rolled out callers-first and verified live against the running cluster.
- **Mistakes of mine, caught and corrected in the open** (§9). The two that matter most: I reported fixes as *deployed* when they were only *committed* (QA-037 — twice), and I built the wrong TigerBeetle topology before its owner corrected me (QA-034).

**Decision: still NO-GO for production money-moving traffic — but the reasons have changed.** Score **70/100** (was 63). There are no unresolved P0s. The blockers are no longer "the ledger doesn't work" or "there is one replica"; they are (1) **nothing has been driven through a real browser yet** — the login flow and every page are unexercised by a human (the plan is `.qa/ui-test-plan.md`); (2) **recoverability** — no off-host copy, no point-in-time recovery, no TigerBeetle backup (and the previous TigerBeetle history is gone: the pre-reformat backup failed and the owner directed me to proceed); (3) the **shared TigerBeetle namespace has no network policy and its protocol has no authentication** — anyone who can reach it can read and write every tenant's ledger; (4) an **image supply chain that is hand-shipped `qa-local*` tags with Flux suspended and nothing pushed**. All bounded and fixable (§12). Fine to continue as dev/staging.

## 2. Scope — what was and was not tested
| Area | Status | Evidence |
|---|---|---|
| Repo/architecture/stakeholders/roles | Done | `.qa/architecture.md`, `.qa/user-roles.md` |
| Role × functionality matrix | Done (static, all 915 procedures) **and every flagged row triaged** | `.qa/role-functionality-matrix.md` (71 → 56 flagged after fixes; the rest classified in QA-028). Blind spot: raw Express routes are outside the scanner (that is how QA-014 slipped through) |
| Requirements traceability | Done, reference-based | `.qa/requirements-matrix.md`: 126 ticket IDs → 117 code+test, 8 code only, 1 unreferenced (ORD-24). Proves wiring, not correctness. Pre-W37 waves have no stable IDs, not covered |
| Authorization / tenant isolation | Done | QA-005/006/011/015/017/028; ratchet + 5 targeted suites |
| Authentication | Partial (pass 3: better, still not browser-proven) | The SPA login was rebuilt (QA-020) and tested at the HTTP level: 38 + 9 unit tests, live curl checks (callback with no transaction cookie → 400; open-redirect payload never leaves the origin). **Still not exercised in a real browser with real Keycloak credentials** — group A of `.qa/ui-test-plan.md`. Tenant-portal SSO (`keycloak.exchangeCode`, public, `state` never compared, no PKCE) has the same class of gap and is **unfixed** |
| Service-to-service authentication | **Done + verified live** (pass 3) | QA-026 (network layer) + QA-038 (application layer, shared `INTERNAL_API_KEY`): 8 protected bridge routes → 401 without the key, right key → a real reserve/void through TigerBeetle; rejection log showed only my own probes |
| Input security (SQLi/XSS/SSRF/cmd/path/deser/secrets/mass-assign) | Done by code audit (2 agents) + fixes | QA-014/016/023; no dynamic penetration test |
| **Ledger against a real TigerBeetle** | **Done at test level; live at bridge level** (pass 3) | 29 integration tests + the webhook → DB → ledger e2e against a real TigerBeetle; on the cluster: real reserve/void, real overdraft refusal (409), settle-to-exactly-zero. **Not run:** an authenticated `payment.initiate` → confirm through the live `server` (needs a logged-in tenant; the payment flow isn't startable from the UI either) |
| Functional / negative / edge cases | Partial | Money-path boundaries verified (Zod rejects Infinity/NaN; client amount never authoritative). No exhaustive sweep of 130 routers |
| Unit / integration / e2e | Done | see §4 |
| Data integrity / concurrency / idempotency | Done for money paths | QA-007, QA-010 (real-Postgres concurrency proofs); QA-033/035 (real-ledger idempotency, deterministic commit/void ids) |
| Migrations | Done | full 156-migration journal applies from empty; forward-only by design → rollback N/A |
| Performance (baseline/load/stress/spike/soak) | Done **locally only** | `.qa/perf/summary.md` |
| Multi-replica / failover | Done | CX-01, CX-04; pass 3: 2 replicas of `server` and `ledger-bridge` (QA-034), 3 of TigerBeetle (QA-036, primary kill) |
| Deployment + rollback | Done on the live cluster (pass 2); pass 3 rollouts **not re-measured under load** | CX-03, CX-05 |
| Chaos | Partial | pod loss, dependency outage, node-loss approximation, TigerBeetle primary kill. **Not done:** real node failure, network partition/latency, CPU/memory/disk pressure, DNS — shared cluster + no safe injection path (`.qa/chaos/experiments.md`). The one TigerBeetle primary-kill that was run is recorded in QA-036; TigerBeetle is shared with `lanai` and `vpp`, so further failure injection there needs its owner's say-so |
| Observability | Done, read-only | QA-027 section; live cross-service trace propagation **not demonstrable** without traffic; pass 3 found a Prometheus alert that can never fire (`RustServiceDown`) |
| Disaster recovery | Partial | nightly `pg_dump` + weekly automated restore-verify running on the cluster, drilled end-to-end incl. a corrupted-dump negative control (QA-021). Pass 3 added an optional off-host S3 upload + verify — **no destination is provisioned, so it does nothing yet**. **Still open:** same-host copy only, no PITR, **no TigerBeetle backup** (the 1→3 reformat proved the point: its pre-reformat backup failed and that history is unrecoverable), Keycloak DB owned elsewhere |
| **UI, accessibility, browser compatibility** | **NOT DONE — plan written, awaiting a human** | no browser automation available here. `.qa/ui-test-plan.md` is the prioritised, step-by-step plan (login first; then admin/infra, roles/isolation, resilience tests I drive from the terminal while you watch, SSRF, a 16-page smoke sweep); `.qa/manual-tests.md` is the older list |
| Live load/stress test | **Deliberately not done** | you scoped perf to the local stack |
| Long soak (>10 min) | Not done | 10-minute soak only |

## 3. Defects (full evidence in `.qa/defects.md`)
| ID | Sev | Summary | Status |
|---|---|---|---|
| QA-014 | **P0** | `/api/finetune/stream` + `/export-yolo` unauthenticated (subprocess trigger; cross-tenant data dump; stored XSS in preview) | Fixed, tested, **live** |
| QA-024 | **P1** | export route crashed the whole server (archiver 8 API break; uncaught exception is fatal) | Fixed, 6 unit tests, e2e-proven, **live** |
| QA-028 | **P1** | webhook DLQ raw payloads, all-tenant revenue/COGS, COGS queue, any order by number, cross-tenant image wipe/flag — open to any logged-in user | Fixed, 17 tests (SQL-level tenant assertions), **live** |
| QA-029 | **P1** | `recon-worker` panics on real data (Postgres enum decoded as `String`) and its orphan-repair pass errors every run (invalid enum labels) — never worked; **and I had wrongly closed this as "contention" earlier** | Fixed. **Pass 3: deployed** (`recon-worker:qa-local2`, now with a `DATABASE_URL` — it had none) and reconciling real data every 5 min, 0 discrepancies so far. Its money-repair pass is live and watching for the first time; **no repair has ever fired**, so that path is still unexercised |
| QA-035 | **P1** | the webhook confirmation path never committed the TigerBeetle reservation it created (payment "completed" in Postgres, money left reserved and auto-voided after 15 min). Found by the real-ledger e2e test | **Fixed + live** (`server:qa-local5`+; I first wrongly reported it shipped when the server image was stale — QA-037 CORRECTION). Open: the older `paymentTransactions` confirmation kind has no `ledgerPendingId` column at all — needs an owner decision |
| QA-033 | **P1** | server↔bridge↔TigerBeetle contract broken four ways (opaque ids → 400 swallowed as "already posted"; a 15-min auto-voiding reserve used as a direct posting; settle path never credited escrow; random commit/void ids made retries fail forever as "ledger unavailable") + **no overdraft protection** | **Fixed + live** — account-kind stamp → `debits_must_not_exceed_credits`; deterministic ids; a ledger *refusal* (409) is now distinct from an *outage* (503). 29 integration tests vs a real TigerBeetle; live refusal + settle-to-zero verified |
| QA-031 | **P1** | the bridge's TigerBeetle path had never run against a real ledger (no HTTP adapter existed; flags, amount-0, burned ids, account ids/ledgers all wrong); CI shipped the deprecated bridge shim | **FIXED + wired live** — real adapter sidecar, 21 tests vs real TigerBeetle, live smoke OK |
| QA-015 | P1 | evidence-portal `listTokens`/`revokeToken` cross-tenant IDOR (raw bearer tokens) | Fixed, tested, **live** |
| QA-016 | P1/2 | SSRF guard missing on Keycloak (incl. unauthenticated `exchangeCode`), Twenty, Label Studio ×2 | Fixed, tested, **live** |
| QA-017 | P1 | 3 ML-ops mutations spawn python for any logged-in user (+ blocking `execSync`) | Fixed → admin-only, tested, **live** |
| QA-005/006/007/009/012/013 | P1/2 | (first pass) money-role authz, gift-card idempotency, e2e build, probes | Fixed, deployed |
| QA-018 | P2 | server-initiated OAuth: no PKCE, nonce never verified | Fixed (signed-cookie transaction, replica-safe), 10 tests |
| QA-020 | P2 | SPA login had no PKCE and no working state/nonce binding → **login CSRF**; plus an open redirect found on the way | **FIXED + live (pass 3)** — signed httpOnly `wa_oauth_tx` cookie bound to `state`, PKCE S256, nonce check, same-origin-only `safeReturnTo`; 38 + 9 tests; verified over HTTP. **Not yet run in a real browser** (UI plan, group A) |
| QA-026 | P2 | no NetworkPolicies live; `commerce-engine` trusts `X-Tenant-ID` with no auth of its own | **FIXED for the three services (pass 3)** — ingress-only allowlists, enforcement verified on this cluster (kindnet), probes unaffected; plus QA-038. **Open:** the shared `tigerbeetle` and `postgres-oracle` namespaces have no policy at all |
| QA-038 | P2 | `ledger-bridge`, `recon-worker`, `commerce-engine` did not authenticate callers (the bridge accepts transfers from anyone who can reach it; `recon-worker` had an unauthenticated repair trigger) | **FIXED + verified live (pass 3)** — shared `INTERNAL_API_KEY`, constant-time compare, health endpoints exempt, `commerce-engine` fails closed in production; staged callers-first. My first pass **missed a caller** (`provisionTbAccount`, found by grepping), since covered by a static sweep test |
| QA-027 | P2 | `server`: 1 replica, no HPA/PDB/metrics-server, 512Mi limit < 613–800 MiB under load, 500m CPU | **MOSTLY FIXED (pass 3)** — 2 replicas, `maxUnavailable: 0`, PDB, node spread, 1Gi limit. **Open:** no HPA / metrics-server; the spread is *soft* and both workers sit at 92–97 % allocated CPU, so a rollout has landed both replicas on one node twice (fixed by hand each time) |
| QA-034 / QA-036 | P2 / info | availability follow-ups; **shared TigerBeetle reformatted from 1 to 3 replicas at its owner's explicit direction** (destructive; old history unrecoverable) | Done + verified live: 3/3 healthy one per node, primary kill under writes → 0 failed writes. **I first built a separate dedicated cluster — wrong; it is shared infrastructure (`lanai` and `vpp` use it) — torn down.** `lanai`/`vpp` still list only replica 0 → no failover benefit for them |
| QA-037 | — | deploying the above for real; caught that the shipped `tb-adapter` image predated the overdraft code, and (later) that the `server` image predated QA-033/035 | Fixed; lesson recorded: verify the *artifact*, not the commit |
| QA-021 | P2 | no backup of any kind existed for the live DB (shared CNPG cluster has no `ScheduledBackup`) | **MITIGATED** — nightly dump + weekly restore-verify deployed and drilled; off-host copy code exists but **no destination**; PITR and TigerBeetle backup still open |
| CX-02 → QA-030 | P2 | missing `ledger-bridge` ⇒ ~28 s total app outage (design contradiction) | **FIXED + verified live** — re-run 100 % (was 80.98 %) |
| CX-04 | P2 | node loss strands `ml-stack`/`recon-worker` on a rate-limited registry | **OPEN — and pass 3 widened it:** the app images are now `qa-local*` tags loaded by hand onto the three nodes with `imagePullPolicy: Never`, so a *replaced* node has none of them and can't pull them either |
| QA-019 | info | Keycloak brute-force config not provably active (external IdP) | OPEN (external) |
| QA-022/023/025 | info/P3 | live ledger path reality; small hardening fixes; e2e re-runnability | Done / logged (QA-022 superseded by QA-031) |
| QA-032 | P3 | database consolidated onto `pg-oracle` (requested); adopting a pre-existing role/DB there reset its password (disclosed); a vacuous verifier caught and fixed | **DONE + verified** — old copy frozen for rollback; open: `pg-oracle` is 1 instance/no backups/NodePort, leftovers to delete later |

**Found in pass 3 and not fixed** (all in `.qa/defects.md` under QA-038):
- The shared **TigerBeetle namespace has no NetworkPolicy and TigerBeetle has no authentication in its protocol** — anyone who can reach `tigerbeetle-{0,1,2}.tigerbeetle-headless:3000` can read and write every tenant's ledger (ours, `lanai`'s, `vpp`'s). The biggest remaining exposure; deliberately untouched because it is another team's namespace and a policy mistake there is now a three-team, HA-cluster outage. `postgres-oracle` has the same gap. The known clients are listed in QA-038 (from the Deployments' configuration); an allowlist has been recommended but neither drafted as a manifest nor applied.
- **Tenant-portal SSO** — `keycloak.exchangeCode` is a public procedure that creates a portal session; `state` is accepted but never compared server-side, and there is no PKCE.
- **`payment-orchestrator` (Go)** is a latent caller of the bridge with no code to send the internal key; it can't reach the ledger today because `LEDGER_BRIDGE_URL` is unset.
- **`commerce-engine` isn't wired into anything that works** (gateway's URL unset, `event-processor` never calls it — its router is dead code and its "consumer" is a heartbeat loop — and its SQL uses `tenant_id` where the schema has camelCase columns). The auth I added protects a service that nothing legitimately uses yet.
- The Prometheus **`RustServiceDown`** alert can never fire (no scrape job carries those names; an absent series never equals 0). `ComponentDown` does work, and needs 5 minutes sustained.
- `provisionTbAccount` (admin action) already failed on every call with a 422 (camelCase vs snake_case body) — pre-existing, not fixed; vestigial since the adapter creates accounts on first use.

## 4. Test results (final regression, this tree)
| Suite | Result |
|---|---|
| Main vitest (all of `server/`, `simulation/`, `client`, scripts) | **One full run of this tree: 280 files — 278 passed, 1 skipped, 1 failed; 4,253 tests — 4,216 passed, 36 skipped, 1 failed** (848 s). **The one failure is simulation journey J165 (mandate double-submit).** It failed all three attempts (1 + the file's `retry: 2`), and both concurrent calls returned the early 'duplicate' verdict — i.e. neither reached the payment provider, so the failure is in the *safe* direction (no charge) — but the journey did not pass. Re-running the simulation file **alone**, at low machine load: **426/426 pass, including J165** (787 s). So it does not reproduce in isolation, and **I did not establish the cause**: the journeys share one world and retry in it, so the retries ran against state the first attempt had already changed and the first attempt's own error is not in the log; and I did not run `npm run simulate`, which the test file's own comment names as the authoritative fresh-world, zero-retry gate. It is not in code this session touched (`tradeCredit` and J165 are unchanged since Wave 45). An earlier full run on this tree had 5 *timeout* failures while the machine's load average was 10–18. Read this as: green except one load-sensitive journey I could not explain — not as "0 failed". |
| Go (11 modules) | `go build` + `go vet` + `go test`: **all 9 modules in `go.work` that contain code pass** (commerce-engine incl. its 8 router tests, conversation-orchestrator, event-gateway, gateway, hermes-bridge, notification-service, payment-orchestrator, visual-inventory/go-orchestrator, webhook-ingestor). The other 2 (`crm-adapter`, `erp-adapter`) hold only a `go.mod` — **no Go source at all** — so there is nothing to build or test; the pass-2 version of this row said "11 modules pass", which overstated it |
| Rust workspace | `cargo test --workspace`: **pass — 31 tests**: `ledger-bridge` 18 (was 5), `recon-worker` 9, `event-processor` 4, `hermes-router` 0 |
| TypeScript | `tsc --noEmit` clean |
| Real-TigerBeetle integration (`services/tb-adapter` + bridge contract) and `tests/e2e/ledger-money.test.ts` | 29 integration tests + the webhook → DB → ledger e2e, run against a real TigerBeetle earlier in pass 3 (this is where QA-035 was caught). **Not re-run in this final regression** — they need a real TigerBeetle |
| e2e (pass 2; real docker-compose stack; **Docker Hub was unreachable, so the Go/Rust images were the previous builds; only `platform` was rebuilt from the final tree**) | **65 passed, 4 failed, 4 skipped, 1 todo** at the time. The 4 failures were understood then: (1–2) the two `wallet.requestWithdrawal` tests need a real Paystack sandbox credential; (3) `ledger-bridge /health/ready` — image predated the endpoint; (4) `recon-worker /recon/trigger` — a real crash, QA-029. **Not re-run as a whole since pass 3.** Also: the compose stack runs with `INTERNAL_API_KEY` unset, i.e. it exercises the *un-enforced* mode of QA-038 |
| Live-cluster experiments | CX-01…CX-07 and the pass-3 checks (see §7) |
| Browser / UI / accessibility | **not run** (`.qa/ui-test-plan.md`) |
| Mutation checks | Every pass-3 test that guards a security property was mutation-checked (skip the gate, move a route out of the protected group, drop a caller's header, send the secret to the wrong destination, `optional: true`, wrong Secret name). **This caught real holes in my own tests:** my first Rust tests built a private copy of the router, so moving `/transfer` out of the protected group in the *real* router still passed; the router is now built by one function that `main()` and the tests both call |

## 5. Security findings
See §3 and `.qa/defects.md`. Positives verified rather than assumed: SQL is parameterized everywhere sampled (Drizzle `sql` tag, sqlx, tokio-postgres); no real secrets in the repo; logout genuinely revokes tokens server-side (checked in the DB, fails closed in production); tokens are verified against JWKS, not merely decoded; CSRF has two layers for the cookie path (SameSite=Lax + Origin/Referer middleware); the rate limiter is layered (edge, per-tenant, APISIX) and fails closed. **Pass 3:** login CSRF and the open redirect are closed; the three trusting services now require a caller identity at two layers (network and application). Residual: **the shared TigerBeetle/Postgres namespaces have no network policy**; tenant-portal SSO `exchangeCode`; a `podSelector` trusts labels, so anyone who can create pods in the namespace can label past the network policy (RBAC on the namespace is unaudited) — the shared secret is the second layer for exactly that; one shared secret means a compromise of any holder is a compromise of all; an *empty* secret value would leave the Rust services open (the live value is 44 chars, and a *missing* Secret stops the pod); no dedicated tighter limit on money-moving mutations; refresh-token rotation doesn't exist (sessions simply expire after 12 h — a UX/availability trade-off, not a vulnerability); `OWNER_OPEN_ID` is unset on the live server, so no account becomes admin at login (admin needs `users.role='admin'` set in the DB — safe, but it means the admin UI can't be reached until someone does that on purpose).

## 6. Performance (local docker-compose, single container; not the live cluster)
Saturates at ~1.1–1.3 k RPS for a trivial tRPC call (~3 k for `/health`); 0 errors up to 800 concurrent; **10-min soak: 721,097 requests, 0 errors, p95 52 ms, flat memory (no leak signal)**; recovers instantly from a 400-concurrency spike; the rate limiter engaged exactly as designed under load. Weak spot: **no load shedding — p99 hit 13 s at c=800**. No SLO exists in the repo, so no number was treated as pass/fail (thresholds need stakeholder confirmation). The live limits are now 2 replicas × (1 CPU / 1Gi) for `server` (pass 3; were 1 × 500m / 512Mi) — memory is above what the container used here (613–800 MiB) and the CPU limit is now roughly what it needed (130–170 %), but none of this has been load-tested on the cluster. Full table: `.qa/perf/summary.md`.

## 7. Reliability, chaos, multi-replica, deployment, rollback (live cluster, measured from the cluster host)
| Experiment | Result |
|---|---|
| CX-01 abrupt loss of 1 of 2 server replicas | **PASS** 899/899 |
| CX-02 `ledger-bridge` gone 62 s | **FAIL** 80.98 %; 28.4 s of 503s; readiness coupling → fixed (QA-030), **re-run CX-02b PASS 1,498/1,498 (100 %)** |
| CX-07 rolling deploy of that fix under load | **PASS** 749/749, ~11 s rollout |
| CX-03 rolling deploy under load | **PASS** 1,199/1,199, ~12 s rollout |
| CX-04 node-loss approximation | **PARTIAL** users unaffected (1,298/1,298) but 2 services stuck on image pull |
| CX-05 rollback + roll-forward under load | **PASS** 999/999 (only works while the old local image is on the nodes) |
| CX-06 second rolling deploy (QA-028 fixes, `qa-local3`) | **PASS** 749/749; unauthenticated finetune routes 403/401 and the new admin-only procedures refuse a sessionless caller — verified live |
| TB-01 (pass 3) kill the elected TigerBeetle primary under active writes, 3 replicas | **PASS** zero failed writes, VSR failover instant, killed replica rejoined in ~18 s (QA-036). Also measured: a client that knows **only one** replica address has no fallback if that replica dies — which is why our bridge lists all three and `lanai`/`vpp` (one address each) get no benefit yet |
| NP-01 (pass 3) NetworkPolicy enforcement | **PASS** before/after, live: a pod in an unrelated namespace reached all three services before and was blocked after (as was an unlabelled pod in the same namespace); `server`→bridge, `server`→recon-worker, `event-processor`→commerce-engine and `recon-worker`→bridge kept working; protected pods stayed Ready with 0 restarts. Enforcement by kindnet and probe pass-through were proven in a scratch namespace first (QA-026) |
| AUTH-01 (pass 3) staged internal-auth rollout (callers → callees) | **PASS** no legitimate caller locked out — the bridge's rejection log over 10+ minutes showed exactly my nine probe requests and nothing else |
| Pass-3 rollouts of `server`/`ledger-bridge` (2 replicas each) | completed with `maxUnavailable: 0`, **but not re-measured under load** the way CX-03/06 were, and **both replicas landed on the same node twice** (soft spread; fixed by deleting one pod) — a standing hazard on a cluster with both workers at 92–97 % CPU |
Details, hypotheses and rollback steps: `.qa/chaos/experiments.md`. Not repeated on the pass-3 topology (≥2 replicas, PDBs, service auth, NetworkPolicies): CX-01…CX-05 — the pass-2 version of this report asked for it, and it is still listed under REMAINING TESTS in §12.

## 8. Data integrity, observability, disaster recovery
- **Data integrity:** money-path concurrency invariants proven against real Postgres (10× concurrent buyer-confirm ⇒ one credit; 5× concurrent initiate ⇒ one intent); gift-card adjust made idempotent; the full 156-migration journal applies from empty. **Pass 3:** commit/void are idempotent by deterministic id (a retry is a 200, not a new failing transfer); overdraft protection is real (escrow/merchant/merchant-wallet accounts refuse to go negative — proven live with a real 409 and a settle to exactly zero); the reconciliation safety net (`recon-worker`) finally runs against real data. What it cannot yet claim: the repair pass has never fired, and the ledger's history before 2026-09-21 is gone.
- **Observability:** Prometheus 46/49 targets, 16 alert rules incl. the ledger/escrow/payout ones, Jaeger fed by 8+ services, span-metrics working. Gaps: one permanently-red stale scrape target; probes emit ~26 k spans/service/day; live trace propagation unproven; `ledger-bridge` emits no spans so its span-derived alert may never fire; **`RustServiceDown` can never fire** (pass 3); the ledger alerts need 5 minutes sustained, so a short bridge outage pages nobody.
- **DR:** a real `pg_dump | gzip` → `gunzip | pg_restore` into a separate instance reproduced 267 tables, 46 FKs and the seeded rows exactly; the live nightly dump + weekly restore-verify run and were drilled. Not covered: an off-host destination (code exists, nothing provisioned), TigerBeetle backup (none — and a real loss already happened), PITR, RTO/RPO numbers, a restore rehearsal against *live*.

## 9. Corrections to my own work (what I got wrong and caught)
1. **Deep readiness on `ledger-bridge` + `server`:** I gated both on TigerBeetle/Postgres health. Checking the *live* bridge showed both are down there by design; the change would have drained every server pod and left the bridge permanently unready. Reversed: readiness stays shallow, the state is now *reported* (`degraded`) not gated.
2. **PKCE with an in-memory verifier:** would have hard-failed every login whose callback hit another replica once a challenge is sent. Rebuilt with a signed, replica-safe cookie transaction and a test that uses a second app instance.
3. **`/api/finetune/export-yolo` admin-only:** would have broken the merchant Inventory Hub. Now login-required and tenant-scoped (admin gets the platform set).
4. **A simulation journey (J53)** broke on the SSRF hardening; fixed in the harness, not by weakening the guard.
5. **I closed the recon-worker failure as "test contention" in the first pass — wrong.** It was a real panic; the e2e log showed it and reproducing against the real schema found a second bug behind it (QA-029). I retracted the diagnosis in `defects.md` rather than leave it standing.
6. A zsh scripting slip made my first node-loss injection a no-op (caught from its own output, node restored, redone). A first read of a slow public URL as a "server TLS problem" was wrong — measured from the cluster host it is 0.08 s; it was this laptop's network.
7. **(pass 3) I built a dedicated 3-replica TigerBeetle for this app — wrong.** `tigerbeetle` is shared cluster infrastructure that `lanai` and `vpp` also use; the owner corrected me twice. Torn down, repo/tests/docs reverted; the shared instance was reformatted instead, on their explicit say-so.
8. **(pass 3) I reported QA-033/035 as deployed when the running `server` image had none of the code** (0 occurrences of the new symbols in its bundle). I had applied that exact check to the adapter and not to the server. The gap didn't make anything worse, but the claim was false; corrected in `defects.md` and closed with a new image.
9. **(pass 3) The shipped `tb-adapter` image predated the overdraft code** — my first live overdraft test succeeded (balance went to −100) when it should have been refused. That test is what caught it.
10. **(pass 3) The `otel` allowance in the NetworkPolicies was a mistake.** I attributed flows to a CronJob using a pod-IP map, but completed pods keep a stale `podIP` after the address is reused; the real source was a `server` replica. Removed and re-verified.
11. **(pass 3) I said `event-processor` is "the only live caller of `commerce-engine`" — false.** Its router is dead code; it is not a caller at all.
12. **(pass 3) My first internal-auth pass missed a caller** (`provisionTbAccount`) and my first Rust tests were vacuous (a private copy of the router). Both found afterwards — one by grepping every consumer of the URL, one by mutating — and fixed with tests that can actually fail. A third "smoke check" test I wrote asserted a config field was non-empty and was replaced.
13. **(pass 3) A bisect of some test timeouts concluded "my change caused it".** The machine's load average was 10–18; an interleaved comparison showed no regression. Retracted.
14. **(pass 3) Danger avoided, not incurred:** `kubectl apply` of the repo's manifests would have reverted the hand-shipped images (the bridge manifest pins a `tb-adapter` tag I had already removed from the nodes) and taken the ledger down. I used targeted JSON patches instead and wrote the hazard into the project notes.

## 10. Remaining risks (ranked)
1. **The UI and the login have never been driven by a human.** Everything about login is verified at the HTTP level only; every page in the SPAs is unexercised. This is the next stage (`.qa/ui-test-plan.md`), and group A (login) is the one thing that cannot be verified from a terminal.
2. **The shared TigerBeetle and Postgres namespaces are open to any pod, and TigerBeetle has no authentication in its protocol** — full read/write on every tenant's ledger. Not this project's namespace to change unilaterally; needs the owner (an allowlist naming our bridge pods, `lanai-portal`, `vpp-orchestrator`, `vpp-server`, the stunnel and the replicas themselves, verified before/after).
3. **Recoverability:** no off-host backup destination provisioned, no PITR, no TigerBeetle backup. A real ledger history was already lost in the reformat because its backup failed.
4. **Image supply chain:** ~57 local commits unpushed; the cluster runs hand-shipped `qa-local*` tags with `imagePullPolicy: Never`; no rollback tags left on the nodes (a rollback means rebuilding and re-shipping); a replaced node has no images; Flux is suspended and **resuming it before CI builds matching images would revert every live patch to stale registry tags** and re-hit the registry's 429; the cluster host is ~97 % full.
5. **Availability margins are thin:** no HPA/metrics-server; soft topology spread on two workers at 92–97 % allocated CPU (both replicas co-located twice); the ledger alerts need 5 minutes sustained; TigerBeetle replicas: one is on the control-plane node.
6. **Live money path only partly exercised:** bridge-level real reserve/void/overdraft is verified on the cluster; an authenticated `payment.initiate` → confirm through the live `server` is not (the `paymentTransactions` kind has no ledger link at all — owner decision).
7. **Unfixed findings:** tenant-portal SSO `exchangeCode`; `payment-orchestrator` as a latent bridge caller; `commerce-engine` is unwired (and would fail against the schema); `RustServiceDown` can never fire; `lanai`/`vpp` list a single TigerBeetle address.
8. **Simulation J165 (mandate double-submit) failed in the one full-suite run and passes alone** — cause not established; it fails safe (no provider charge) but it is a concurrency journey on a money path, so it deserves a fresh-world `npm run simulate` and a look at what leaves a pending-repayment marker behind before anyone calls the suite green.
9. Unexercised: UI/accessibility/browser compatibility, real node failure, network faults, live load, >10-minute soak.

## 11. Readiness score (skill rubric)
| Category | Weight | Score | Why |
|---|---:|---:|---|
| Functional correctness | 20 | 16 | very broad automated coverage; the money path is now proven against a real ledger and real bugs (QA-033/035) were found and fixed there; **UI untested**, no exhaustive edge sweep |
| Security | 15 | 11 | many real holes closed and deployed, two-layer service auth, login CSRF closed; TigerBeetle/Postgres namespaces open, tenant-portal SSO gap, no dynamic pentest, login not browser-proven |
| Reliability | 15 | 12 | zero-downtime deploy/rollback/pod-loss proven (pass 2); 2 replicas + PDBs; 3-replica TigerBeetle with a proven primary kill; but pass-3 rollouts not re-measured, soft spread, thin CPU headroom, node-loss image risk |
| Test coverage/quality | 10 | 8 | strong suite + ratchets, real-ledger integration tests, security tests mutation-checked (which caught holes in my own first tests); raw Express routes outside the authz scanner; no UI tests; **one simulation journey (J165) failed in the full run and I could not explain it** |
| Performance | 10 | 6 | measured baseline/stress/soak locally; no SLOs, no live perf, no load shedding |
| Scalability | 10 | 4 | 2 replicas, PDBs, memory limit fixed; still no HPA/metrics-server, single process saturates ~1.1 k rps |
| Data integrity | 5 | 4 | invariants + migrations + restore rehearsal + real overdraft protection + the reconciler finally running; but its repair pass has never fired and the ledger's pre-reformat history is gone |
| Observability | 5 | 3 | good stack; noise, stale target, unproven propagation, an alert that can never fire, 5-minute alert delays |
| Deployment safety | 5 | 2 | proven zero-downtime + rollback, but the mechanism is hand-shipped local images, no rollback tags on the nodes, Flux suspended, nothing pushed — a step *backwards* from pass 2's "fragile" (3) as the cluster drifted further from the repo |
| Disaster recovery | 3 | 2 | live nightly dump + weekly restore-verify, drilled; same-host only, no destination provisioned, no PITR, no TigerBeetle backup |
| Documentation | 2 | 2 | `.qa/` evidence trail, UI test plan, runbook-style chaos log, `docs/RESILIENCE.md` updated |
| **Total** | **100** | **70** | descriptive, not a substitute for judgment; no critical blocker overrides it upward |

## 12. Rollout decision
```
CAN THIS PLATFORM BE ROLLED OUT TOMORROW?

ANSWER: NO-GO  (for production traffic that moves real money)
        Fine to continue as dev/staging. No unresolved P0.
        (Same answer as pass 2; the reasons are different — see BLOCKERS.)

CONFIDENCE: high on the specific findings (each has reproduction/measurement); moderate on the overall
            verdict, because the UI and the interactive login were not observable from here and a real
            authenticated payment through the live server has not been run.

EVIDENCE: §3–§8 and .qa/{defects.md, chaos/experiments.md, perf/summary.md, role-functionality-matrix.md,
          requirements-matrix.md, manual-tests.md, ui-test-plan.md}.

BLOCKERS (each flips the answer if closed):
  1. UI + login driven by a human: run .qa/ui-test-plan.md (group A first — real Keycloak login end to end),
     fix what it finds, then have someone with real users' expectations look at the money screens.
  2. Recoverability: provision an OFF-HOST backup destination (the code is ready; it needs a bucket and
     credentials), PITR via WAL archiving on the shared CNPG cluster, and a TigerBeetle backup that has been
     restored at least once (the last attempt failed and that history is gone).
  3. Shared-infrastructure exposure: the owner of the `tigerbeetle` (and `postgres-oracle`) namespace applies an
     ingress allowlist, verified before/after as QA-026 was. Until then anyone who can reach a pod can move any
     tenant's money.
  4. Image supply chain: push the commits, let CI build real image tags, verify them, THEN resume Flux — never
     the other way round (resuming now reverts every live patch to stale tags and hits the 429 again).
  5. A real authenticated payment through the live `server` (initiate → confirm/webhook → escrow → settle),
     watching the ledger and the reconciler — and an owner decision on the `paymentTransactions` kind.
CLOSED SINCE PASS 2: ledger wired and overdraft-protected (QA-031/033/035); server + bridge >= 2 replicas with PDBs
     (QA-027/034); TigerBeetle 3 replicas (QA-036); login CSRF + open redirect (QA-020); NetworkPolicies + service
     auth (QA-026/038); recon-worker deployed and reconciling (QA-029).
HIGH-RISK ISSUES: the open TigerBeetle namespace; image supply chain (locally shipped images, suspended Flux,
                 rate-limited registry, no rollback tags); recoverability.
REMAINING TESTS: UI + accessibility (.qa/ui-test-plan.md), real node failure / network faults on a non-shared cluster,
                 live load test, >10-min soak, dynamic security test (authenticated + unauthenticated fuzzing),
                 CX-01..05 re-run with 2 replicas and under load, a rollout under load of the pass-3 topology.
REQUIRED REGRESSION: full vitest + e2e + go + cargo + simulation after the above (the e2e suite has not been re-run
                 as a whole since pass 3; `npm run simulate` has not been run at all on this tree — see risk 8 / J165).
OPERATIONAL REQUIREMENTS: push the commits and let CI build real image tags BEFORE resuming Flux; tell the owners of
                 `lanai` and `vpp` to list all three TigerBeetle addresses; alert on the stale Prometheus target;
                 fix or delete the `RustServiceDown` rule; filter /health* spans; confirm Keycloak brute-force
                 settings on the shared IdP; after every rollout of server/ledger-bridge check that the two pods
                 are on different nodes.
ROLLBACK PLAN: `kubectl rollout undo` is NOT available today — the previous `qa-local*` tags were removed from the
                 nodes after each deploy, so a rollback means rebuilding and re-shipping the previous image. After
                 CI-built tags exist, rollback needs no local images at all. Emergency off-switch for the service
                 auth (QA-038): remove the INTERNAL_API_KEY env entry from the callee (`kubectl patch`).
RECOVERY PLAN: Postgres restore procedure rehearsed and the weekly restore-verify runs on the cluster (same host);
                 not rehearsed against live; TigerBeetle has none.
```
