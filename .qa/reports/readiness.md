# Production readiness report — whatsappCommerce (world-class-qa, full pass)

Session: 2026-09-20 → 2026-09-21 · Branch `development` (all work committed locally, **not pushed**) · Environments touched: this laptop, a local docker-compose e2e stack, and the live dev cluster `kind-newwave-dev` (namespace `whatsapp-commerce`).

## 1. Executive summary
The first pass fixed authorization, idempotency, e2e and probe defects (QA-001…QA-013). This second pass — done because the skill's own Definition of Done showed large areas untouched — went much wider and found **more, and worse, things**:

- **Two internet-reachable P0/P1 holes on the live domain**: `/api/finetune/stream` and `/api/finetune/export-yolo` had **no authentication at all** — one spawned a subprocess, the other returned every tenant's product images — and the export additionally **crashed the whole server** (archiver 8 API break → uncaught exception → process shutdown), so *any unauthenticated request could take the platform down*. Fixed, tested, and **deployed live and verified** (unauthenticated calls now return 403/401).
- **Any logged-in user of any tenant could read the platform's raw inbound WhatsApp payloads (customer phone numbers, message text), every tenant's revenue/GMV/COGS rate, and any tenant's order by number — and could wipe every tenant's image annotations** (QA-028, found by triaging *all* the matrix's unguarded rows, not just the three money-flagged ones). Fixed, tested, and **deployed live** (`server:qa-local3`, zero-failure rollout).
- A **cross-tenant IDOR** leaking dispute-evidence bearer tokens, **SSRF** on four tenant-configurable integrations (one via an *unauthenticated* procedure that sends a real client secret), and **three ML-ops endpoints that spawn processes for any logged-in user** (one blocks the event loop for up to 60 s).
- Measured **capacity, resilience and deployment behavior** against the real cluster: rolling deploys, rollback and pod loss are genuinely zero-downtime (measured: 0 failures in 4,395 probes across four experiments); but a missing `ledger-bridge` causes a ~28 s **total** outage, a node loss strands services on a rate-limited registry, and the `server` runs 1 replica with limits below what load needs.
- I also **corrected my own mistakes in the open** (see §9): two of my fixes would have regressed real behavior and were reworked before shipping.

**Decision: NO-GO for production money-moving traffic tomorrow.** Score 62/100. There are no unresolved P0s, but several availability, security and recoverability gaps remain that are all bounded and fixable (§12). It is fine to continue as a dev/staging environment.

## 2. Scope — what was and was not tested
| Area | Status | Evidence |
|---|---|---|
| Repo/architecture/stakeholders/roles | Done | `.qa/architecture.md`, `.qa/user-roles.md` |
| Role × functionality matrix | Done (static, all 915 procedures) **and every flagged row triaged** | `.qa/role-functionality-matrix.md` (71 → 56 flagged after fixes; the rest classified in QA-028). Blind spot: raw Express routes are outside the scanner (that is how QA-014 slipped through) |
| Requirements traceability | Done, reference-based | `.qa/requirements-matrix.md`: 126 ticket IDs → 117 code+test, 8 code only, 1 unreferenced (ORD-24). Proves wiring, not correctness. Pre-W37 waves have no stable IDs, not covered |
| Authorization / tenant isolation | Done | QA-005/006/011/015/017; ratchet + 5 targeted suites |
| Authentication | Partial | Audited by code + live tests of the server-initiated flow (10 tests). **Not** exercised against a real browser/Keycloak; SPA login flaw documented (QA-020) |
| Input security (SQLi/XSS/SSRF/cmd/path/deser/secrets/mass-assign) | Done by code audit (2 agents) + fixes | QA-014/016/023; no dynamic penetration test |
| Functional / negative / edge cases | Partial | Money-path boundaries verified (Zod rejects Infinity/NaN; client amount never authoritative). No exhaustive sweep of 130 routers |
| Unit / integration / e2e | Done | see §4 |
| Data integrity / concurrency / idempotency | Done for money paths | QA-007, QA-010 (real-Postgres concurrency proofs) |
| Migrations | Done | full 156-migration journal applies from empty; forward-only by design → rollback N/A |
| Performance (baseline/load/stress/spike/soak) | Done **locally only** | `.qa/perf/summary.md` |
| Multi-replica / failover | Done | CX-01, CX-04 |
| Deployment + rollback | Done on the live cluster | CX-03, CX-05 |
| Chaos | Partial | pod loss, dependency outage, node-loss approximation. **Not done:** real node failure, network partition/latency, CPU/memory/disk pressure, DNS — shared cluster + no safe injection path (`.qa/chaos/experiments.md`) |
| Observability | Done, read-only | QA-027 section; live cross-service trace propagation **not demonstrable** without traffic |
| Disaster recovery | Done on the live cluster (logical backups only) | nightly `pg_dump` + weekly automated restore-verify running on the cluster, drilled end-to-end incl. a corrupted-dump negative control (QA-021). **Still open:** copy is on the same host as the DB (no off-host), no PITR, TigerBeetle/Keycloak DB owned elsewhere and not backed up |
| **UI, accessibility, browser compatibility** | **NOT DONE — tooling gap** | no browser automation available; exact manual tests in `.qa/manual-tests.md` |
| Live load/stress test | **Deliberately not done** | you scoped perf to the local stack |
| Long soak (>10 min) | Not done | 10-minute soak only |

## 3. Defects (full evidence in `.qa/defects.md`)
| ID | Sev | Summary | Status |
|---|---|---|---|
| QA-014 | **P0** | `/api/finetune/stream` + `/export-yolo` unauthenticated (subprocess trigger; cross-tenant data dump; stored XSS in preview) | Fixed, tested, **live** |
| QA-024 | **P1** | export route crashed the whole server (archiver 8 API break; uncaught exception is fatal) | Fixed, 6 unit tests, e2e-proven, **live** |
| QA-028 | **P1** | webhook DLQ raw payloads, all-tenant revenue/COGS, COGS queue, any order by number, cross-tenant image wipe/flag — open to any logged-in user | Fixed, 17 tests (SQL-level tenant assertions), **live** |
| QA-029 | **P1** | `recon-worker` panics on real data (Postgres enum decoded as `String`) and its orphan-repair pass errors every run (invalid enum labels) — never worked; **and I had wrongly closed this as "contention" earlier** | Fixed + verified locally against the crashing data; regression test; **committed, deliberately NOT deployed** (first-ever execution of a money-repair path needs human review) |
| QA-015 | P1 | evidence-portal `listTokens`/`revokeToken` cross-tenant IDOR (raw bearer tokens) | Fixed, tested, **live** |
| QA-016 | P1/2 | SSRF guard missing on Keycloak (incl. unauthenticated `exchangeCode`), Twenty, Label Studio ×2 | Fixed, tested, **live** |
| QA-017 | P1 | 3 ML-ops mutations spawn python for any logged-in user (+ blocking `execSync`) | Fixed → admin-only, tested, **live** |
| QA-005/006/007/009/012/013 | P1/2 | (first pass) money-role authz, gift-card idempotency, e2e build, probes | Fixed, deployed |
| QA-018 | P2 | server-initiated OAuth: no PKCE, nonce never verified | Fixed (signed-cookie transaction, replica-safe), 10 tests |
| QA-020 | P2 | **SPA login has no PKCE and no working state/nonce binding → login CSRF** | **OPEN — documented, deliberately not changed** (needs browser testing) |
| QA-026 | P2 | no NetworkPolicies live; `commerce-engine` trusts `X-Tenant-ID` with no auth of its own | **OPEN** |
| QA-027 | P2 | `server`: 1 replica, no HPA/PDB/metrics-server, 512Mi limit < 613–800 MiB under load, 500m CPU | **OPEN** |
| QA-021 | P2 | no backup of any kind existed for the live DB (shared CNPG cluster has no `ScheduledBackup`) | **MITIGATED** — nightly dump + weekly restore-verify deployed and drilled; off-host copy / PITR / TigerBeetle still open |
| CX-02 | P2 | missing `ledger-bridge` ⇒ ~28 s total app outage (design contradiction) | **OPEN — owner decision** |
| CX-04 | P2 | node loss strands `ml-stack`/`recon-worker` on a rate-limited registry | **OPEN** |
| QA-019 | info | Keycloak brute-force config not provably active (external IdP) | OPEN (external) |
| QA-022/023/025 | info/P3 | live ledger path reality; small hardening fixes; e2e re-runnability | Done / logged |

## 4. Test results (final regression, this tree)
| Suite | Result |
|---|---|
| Main vitest (all of `server/`, `simulation/`, `client`, scripts) | **267 files, ≈3,994 passed / 7 skipped / 0 failed.** Honest composition: the definitive full run had 266 files green and **47 failures in the simulation file, caused by my own harness change** (a fake `KEYCLOAK_URL` that broke the JWKS lookup cron auth uses); I fixed it, re-ran the simulation suite (**426/426**, 181 journeys) and later added one 3-test file (`reconWorkerSchema`), also green. I did not re-run the other 266 files a second time because nothing they consume changed. |
| Go (11 modules) | `go build` + `go vet` + `go test`: all pass (commerce-engine and payment-orchestrator now have 24 tests between them) |
| Rust workspace | `cargo test --workspace`: pass (`ledger-bridge` 5 tests, incl. the `/health` vs `/health/ready` contract) |
| TypeScript | `tsc --noEmit` clean |
| e2e (real docker-compose stack; **Docker Hub was unreachable, so the Go/Rust images are the previous builds; only `platform` was rebuilt from the final tree**) | **65 passed, 4 failed, 4 skipped, 1 todo.** The 4 failures, all understood: (1–2) the two `wallet.requestWithdrawal` tests need a real Paystack sandbox credential (known, unchanged); (3) `ledger-bridge /health/ready` — the running image predates the endpoint (would pass on a rebuild); (4) `recon-worker /recon/trigger` — **a real crash, QA-029**, fixed in source and verified by running the fixed binary against the same database, but not re-provable in this docker e2e without an image rebuild. The admin YOLO export now returns a ZIP and the platform logged **0 `uncaughtException`**. |
| Live-cluster experiments | CX-01…CX-06 (see §7) |
| Browser / UI / accessibility | **not run** (`.qa/manual-tests.md`) |

## 5. Security findings
See §3 and `.qa/defects.md`. Positives verified rather than assumed: SQL is parameterized everywhere sampled (Drizzle `sql` tag, sqlx, tokio-postgres); no real secrets in the repo; logout genuinely revokes tokens server-side (checked in the DB, fails closed in production); tokens are verified against JWKS, not merely decoded; CSRF has two layers for the cookie path (SameSite=Lax + Origin/Referer middleware); the rate limiter is layered (edge, per-tenant, APISIX) and fails closed. Residual: QA-020, QA-026, no dedicated tighter limit on money-moving mutations, refresh-token rotation doesn't exist (sessions simply expire after 12 h — a UX/availability trade-off, not a vulnerability).

## 6. Performance (local docker-compose, single container; not the live cluster)
Saturates at ~1.1–1.3 k RPS for a trivial tRPC call (~3 k for `/health`); 0 errors up to 800 concurrent; **10-min soak: 721,097 requests, 0 errors, p95 52 ms, flat memory (no leak signal)**; recovers instantly from a 400-concurrency spike; the rate limiter engaged exactly as designed under load. Weak spot: **no load shedding — p99 hit 13 s at c=800**. No SLO exists in the repo, so no number was treated as pass/fail (thresholds need stakeholder confirmation). The live limits (500m / 512Mi, 1 replica) are well below what the container used here. Full table: `.qa/perf/summary.md`.

## 7. Reliability, chaos, multi-replica, deployment, rollback (live cluster, measured from the cluster host)
| Experiment | Result |
|---|---|
| CX-01 abrupt loss of 1 of 2 server replicas | **PASS** 899/899 |
| CX-02 `ledger-bridge` gone 62 s | **FAIL** 80.98 %; 28.4 s of 503s; readiness coupling |
| CX-03 rolling deploy under load | **PASS** 1,199/1,199, ~12 s rollout |
| CX-04 node-loss approximation | **PARTIAL** users unaffected (1,298/1,298) but 2 services stuck on image pull |
| CX-05 rollback + roll-forward under load | **PASS** 999/999 (only works while the old local image is on the nodes) |
| CX-06 second rolling deploy (QA-028 fixes, `qa-local3`) | **PASS** 749/749; unauthenticated finetune routes 403/401 and the new admin-only procedures refuse a sessionless caller — verified live |
Details, hypotheses and rollback steps: `.qa/chaos/experiments.md`.

## 8. Data integrity, observability, disaster recovery
- **Data integrity:** money-path concurrency invariants proven against real Postgres (10× concurrent buyer-confirm ⇒ one credit; 5× concurrent initiate ⇒ one intent); gift-card adjust made idempotent; the full 156-migration journal applies from empty.
- **Observability:** Prometheus 46/49 targets, 16 alert rules incl. the ledger/escrow/payout ones, Jaeger fed by 8+ services, span-metrics working. Gaps: one permanently-red stale scrape target; probes now emit ~26 k spans/service/day; live trace propagation unproven; `ledger-bridge` emits no spans so its span-derived alert may never fire.
- **DR:** a real `pg_dump | gzip` → `gunzip | pg_restore` into a separate instance reproduced 267 tables, 46 FKs and the seeded rows exactly. Not covered: live backup existence, TigerBeetle, PITR, RTO/RPO numbers.

## 9. Corrections to my own work (what I got wrong and caught)
1. **Deep readiness on `ledger-bridge` + `server`:** I gated both on TigerBeetle/Postgres health. Checking the *live* bridge showed both are down there by design; the change would have drained every server pod and left the bridge permanently unready. Reversed: readiness stays shallow, the state is now *reported* (`degraded`) not gated.
2. **PKCE with an in-memory verifier:** would have hard-failed every login whose callback hit another replica once a challenge is sent. Rebuilt with a signed, replica-safe cookie transaction and a test that uses a second app instance.
3. **`/api/finetune/export-yolo` admin-only:** would have broken the merchant Inventory Hub. Now login-required and tenant-scoped (admin gets the platform set).
4. **A simulation journey (J53)** broke on the SSRF hardening; fixed in the harness, not by weakening the guard.
5. **I closed the recon-worker failure as "test contention" in the first pass — wrong.** It was a real panic; the e2e log showed it and reproducing against the real schema found a second bug behind it (QA-029). I retracted the diagnosis in `defects.md` rather than leave it standing.
6. A zsh scripting slip made my first node-loss injection a no-op (caught from its own output, node restored, redone). A first read of a slow public URL as a "server TLS problem" was wrong — measured from the cluster host it is 0.08 s; it was this laptop's network.

## 10. Remaining risks (ranked)
1. **QA-029 (recon-worker) is fixed in source but NOT deployed** — deliberately: it makes a never-before-run ledger-repair path execute, which needs human review, and the Rust image can't be rebuilt while Docker Hub is unreachable from here. Until it ships, the live recon-worker has the panic. (QA-028 and the earlier fixes ARE live on `server:qa-local3`.)
2. Live money movement isn't functional in this environment (TigerBeetle/Postgres not wired to the bridge); nothing in this pass verified the production ledger path end to end.
3. Availability: single `server` replica, no PDB/HPA, memory limit below load, ledger-bridge coupling (28 s outages), no anti-affinity guarantee.
4. QA-020 login CSRF; QA-026 unauthenticated `commerce-engine` behind a non-existent NetworkPolicy.
5. Recoverability unproven on the live database.
6. Image supply: locally shipped `:qa-local*` tags with `Never`, Flux suspended, unpushed commits, 96 %-full cluster host, rate-limited registry.
7. Unexercised: UI/accessibility, real node failure, network faults, live load.

## 11. Readiness score (skill rubric)
| Category | Weight | Score | Why |
|---|---:|---:|---|
| Functional correctness | 20 | 15 | very broad automated coverage, real defects found+fixed; UI untested, no exhaustive edge sweep |
| Security | 15 | 9 | many real holes closed and deployed; QA-020/026 open; no dynamic pentest |
| Reliability | 15 | 9 | zero-downtime deploy/rollback/pod-loss proven; bridge coupling, single replica, node-loss image risk |
| Test coverage/quality | 10 | 7 | strong suite + ratchets; raw Express routes outside the authz scanner; no UI tests |
| Performance | 10 | 6 | measured baseline/stress/soak locally; no SLOs, no live perf, no load shedding |
| Scalability | 10 | 3 | no HPA/PDB/metrics-server, limits below load, single process saturates ~1.1 k rps |
| Data integrity | 5 | 3 | invariants + migrations + restore rehearsal are solid, but the reconciliation safety net (recon-worker) had never worked on real data — found late |
| Observability | 5 | 3 | good stack; noise, stale target, unproven propagation |
| Deployment safety | 5 | 3 | proven zero-downtime + rollback; fragile local-image mechanism, Flux suspended |
| Disaster recovery | 3 | 2 | live nightly dump + weekly restore-verify, drilled; same-host only, no PITR, no off-host copy, TigerBeetle uncovered |
| Documentation | 2 | 2 | `.qa/` evidence trail, manual tests, runbook-style chaos log |
| **Total** | **100** | **62** | descriptive, not a substitute for judgment; no critical blocker overrides it upward |

## 12. Rollout decision
```
CAN THIS PLATFORM BE ROLLED OUT TOMORROW?

ANSWER: NO-GO  (for production traffic that moves real money)
        Fine to continue as dev/staging. No unresolved P0.

CONFIDENCE: high on the specific findings (each has reproduction/measurement); moderate on the overall
            verdict, because the production ledger path and the UI were not observable from here.

EVIDENCE: §3–§8 and .qa/{defects.md, chaos/experiments.md, perf/summary.md, role-functionality-matrix.md,
          requirements-matrix.md, manual-tests.md}.

BLOCKERS (each flips the answer if closed):
  1. (partly closed) Live Postgres now has a nightly dump + weekly automated restore-verify (QA-021). Still required: an OFF-HOST copy
     (the PVC is on the same host as the DB), PITR via WAL archiving on the shared CNPG cluster, and a TigerBeetle backup once the ledger is wired.
  2. Deploy TigerBeetle and wire ledger-bridge to it + Postgres; run the money e2e (funds-flow) against that stack.
  3. Availability: >=2 `server` replicas + PDB + anti-affinity; raise memory limit above the measured load
     footprint; add metrics-server + HPA; run >=2 ledger-bridge replicas (or make an unreachable bridge
     non-gating — owner decision) so a bridge restart is not an outage (CX-02).
  4. Close QA-020 (real PKCE + state/nonce binding on the SPA login) and test it in real browsers.
  5. NetworkPolicies deployed via Flux + auth inside commerce-engine (QA-026).
HIGH-RISK ISSUES: QA-020, QA-026, image supply chain (locally shipped images, suspended Flux, rate-limited registry).
REMAINING TESTS: UI + accessibility (.qa/manual-tests.md), real node failure / network faults on a non-shared cluster,
                 live load test, >10-min soak, dynamic security test (authenticated + unauthenticated fuzzing).
REQUIRED REGRESSION: full vitest + e2e + go + cargo + simulation after the above; re-run CX-01..05 with >=2 replicas.
OPERATIONAL REQUIREMENTS: push the commits and let CI build real image tags BEFORE resuming Flux; alert on the
                 stale Prometheus target; filter /health* spans; confirm Keycloak brute-force settings on the shared IdP.
ROLLBACK PLAN: `kubectl rollout undo deploy/<svc>` works today (proven, 999/999) while the previous image tag is
                 on the nodes; after CI-built tags exist, rollback needs no local images at all.
RECOVERY PLAN: restore procedure rehearsed locally (§8); not yet rehearsed against live.
```
