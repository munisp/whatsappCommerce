# Production readiness report — whatsappCommerce (world-class-qa, full pass)

Session: 2026-09-20 → 2026-09-22 · Branch `development` (all work committed locally — about 78 commits — **not pushed**) · Environments touched: this laptop, a local docker-compose e2e stack, and the live dev cluster `kind-newwave-dev` (namespace `whatsapp-commerce`, plus the shared `tigerbeetle` and `postgres-oracle` namespaces, which belong to other teams too).

This report was first written after pass 2, **updated after pass 3** (QA-033…038: the ledger, availability, login, service auth) and **again after pass 4** (QA-039…042: "fix everything except the UI test, and get to at least 90"), and **once more for the UI fixes** (QA-043: the 403s, the missing sidebars, registration details). Where a section says "pass 3" or "pass 4" it supersedes what an earlier pass said.

## 1. Executive summary
**Pass 4 result: 70 → 82 out of 100, still NO-GO for real money traffic. I did not reach 90, and I would rather say so than move the rubric.** The remaining ~9 points are not things more engineering by me can earn; §11 lists exactly what they need (your UI results, a push + CI + Flux resume, a backup destination, the owner's go-ahead on the TigerBeetle namespace, and two other repos).

What pass 4 found and fixed — most of it by *measuring on the live cluster instead of reasoning*:
- **The ledger bridge was down for 30 seconds on every pod termination (QA-042, P1, money path).** Nobody had measured the bridge under money traffic — the pass-2 experiments measured `server`. A probe that drives real `reserve → void` pairs through bridge → adapter → TigerBeetle showed **79.9 %** availability across a rollout and **72.6 %** from deleting *one of two healthy replicas* (150 failed reserves in exactly 30.0 s). Cause: the bridge handled SIGINT but not SIGTERM, which is what Kubernetes sends; as PID 1 it ignored it and lived on for the whole grace period, while its Node sidecar exited within 3 s — so a live bridge with a dead adapter answered `503` to every client whose keep-alive connection was pinned to it. **Fixed and re-measured live: rollout, graceful delete and abrupt delete (`--grace-period=0 --force`) all 100.000 %.**
- **Rollouts co-located both replicas on one node** (twice in a row) — a single-node-loss outage that looked healthy. My first explanation (a CPU request that didn't fit) was **wrong**; the real cause is a spread constraint whose selector spans revisions. Fixed (`matchLabelKeys`), 3 of 3 rollouts of each service now spread; public availability through five measured `server` rollouts and one abrupt pod loss was 100 % (1,099/1,099 · 1,098/1,098 · 1,898/1,898 · 599/599).
- **Rust services' traces never reached Jaeger** — gRPC exporter pointed at the HTTP port; every export failed silently. Fixed; the ledger bridge appears in Jaeger for the first time.
- **Security:** tenant-portal SSO login CSRF (per-tab state + PKCE, verified in the browser code path and by 8/8 mutations; **not** browser-run); the bridge and recon-worker now **fail closed** on an unset/empty internal key; recon-worker's inbound key no longer shares a variable with the platform key; a button that could only create permanent junk in the shared ledger was removed.
- **Capacity:** `metrics-server` + an HPA for `server`, **demonstrated live: 2 → 4 replicas within ~30 s of ~240 rps**, all Ready, spread across both workers. It also corrected a belief: the workers are ~98 % *requested* but ~10 % *used*.
- **Safe resumption:** a read-only Flux-resume gate that reports **4 blockers today** (64 → 78 unpushed commits; and the `tb-adapter` sidecar is pinned to a deleted tag with `imagePullPolicy: Never` and has no ImagePolicy — resuming Flux would leave the ledger-bridge pods unable to start); a ship script that verifies the artifact and keeps the rollback tag; a delta-ship for a slow link; handoffs for the pieces that live in other repos.
- **The UI problems you reported are fixed and live (QA-043) — by rendering, not yet by a human.** One root cause: the client chose a business *for* the user instead of asking who they are. `TenantContext` defaulted to the demo tenant `tenant-001`, and **`ui/tenant-portal` never mounted the provider**, so **24 of its pages** (Products, Orders, Conversations, Payments, Invoices, …) sent `tenant-001` on every query and the server rightly answered **403** for every real merchant — and for every newly registered user, who has no business at all. Twelve more pages hard-coded `"default"`/`"demo-tenant-1"`/`"demo-tenant-id"`. Now: the tenant is derived from the signed-in user on every render; a new user gets a **"Welcome — set up your business" screen inside the sidebar** instead of a wall of 403s; the sidebar shows their **real name, email and "No business yet" / business name / "Platform admin"** (it showed "User", or the identity provider's raw UUID); a login that carried no name/email no longer **erases** the stored ones; **Escrow and Revenue** (admin-only) are hidden from merchants; **`/wholesale`, `/group-deals`, the 404 page and the account menu's Settings** (which went to a route that exists in no app) keep the sidebar. Verified by 59 new tests that render the real layout for a new user, a merchant and an admin, and by the live bundles of all three apps; **not** walked in a real browser (`.qa/ui-test-plan.md`, group F).
- **Corrections of my own work, in the open (§9):** my "13 s tail, no load shedding" finding was mostly a measurement artifact; I then built a load shedder and **removed it** because it did not help; my CPU-request theory for the co-location was wrong; and a `git stash` slip briefly applied one of your own old stashes to my working tree (restored path-by-path; all four stashes intact).

**Decision: NO-GO for production traffic that moves real money.** The blockers are no longer "the ledger doesn't work" or "one replica"; they are (1) **nothing has been driven through a real browser** (the login and every page); (2) **recoverability** — no off-host copy, no PITR, no TigerBeetle backup; (3) the **shared TigerBeetle namespace has no network policy and its protocol has no authentication** (a policy is drafted and validated, not applied — it needs the owner); (4) an **image supply chain of hand-shipped `qa-local*` tags with Flux suspended and 78 commits unpushed**. Fine to continue as dev/staging.

## 2. Scope — what was and was not tested
| Area | Status | Evidence |
|---|---|---|
| Repo/architecture/stakeholders/roles | Done | `.qa/architecture.md`, `.qa/user-roles.md` |
| Role × functionality matrix | Done (static, all 915 procedures) **and every flagged row triaged** | `.qa/role-functionality-matrix.md`. Blind spot: raw Express routes are outside the scanner (that is how QA-014 slipped through) |
| Requirements traceability | Done, reference-based | `.qa/requirements-matrix.md`. Proves wiring, not correctness |
| Authorization / tenant isolation | Done | QA-005/006/011/015/017/028; ratchet + 5 targeted suites |
| Authentication | Partial (better; still not browser-proven) | Login CSRF/open redirect fixed (QA-020) and HTTP-verified live; tenant-portal SSO fixed in code (QA-039, 21 + 15 tests, 8/8 mutations). **Neither has been run in a real browser with real Keycloak credentials** — `.qa/ui-test-plan.md`, group A. The SSO flow additionally cannot be *started* from the signed-out screen (a protected procedure behind a signed-out button) — a product decision, unverified in a browser |
| Service-to-service authentication | **Done + verified live; now fail-closed** | QA-026 (network) + QA-038 (application) + QA-039 (`REQUIRE_INTERNAL_API_KEY`; an empty Secret refuses to start instead of opening the service) |
| Input security | Done by code audit + fixes | QA-014/016/023; **no dynamic penetration test** |
| **Ledger against a real TigerBeetle** | Done at test level; **live at bridge level, now with chaos** | 29 integration tests + webhook→DB→ledger e2e (earlier in pass 3); live: real reserve/void/overdraft refusal; pass 4: real reserve→void pairs at 5/s through rollouts and pod loss. **Not run:** an authenticated `payment.initiate` → confirm through the live `server`; TigerBeetle-side faults (shared infra) |
| Functional / negative / edge | Partial | Money-path boundaries verified. No exhaustive sweep of 130 routers |
| Unit / integration / e2e | Done | §4 |
| Data integrity / concurrency / idempotency | Done for money paths | QA-007/010/033/035. The reconciler's repair pass **has still never fired**; a stranded-marker liveness gap (QA-039 item 5) is documented, not fixed |
| Migrations | Done | full 156-migration journal applies from empty |
| Performance | Local, **measured properly in pass 4** | driver inside the network, ABBA order; **open-loop overload characterised** (queue grows without bound at 2× capacity; an in-process shedder did not help and was removed). No SLOs; no ingress measurement; no live load test |
| Multi-replica / failover | **Done with measurements** | `server` 2–4 (HPA), bridge 2, TigerBeetle 3; rollouts, graceful and abrupt pod loss measured at 100 % (QA-042). **Not done:** node loss |
| Deployment + rollback | Done on the live cluster; **rollback tags now retained** | five measured zero-downtime `server` rollouts, six measured bridge phases; `kubectl rollout undo` works while the previous `qa-local*` image is on the nodes |
| Chaos | Partial | pod loss (server, bridge), rollouts under money/public traffic, dependency outage (pass 2), TigerBeetle primary kill (pass 3). **Not done:** node failure, network partition/latency, resource pressure, TigerBeetle-side faults (shared; owner's say-so) |
| Observability | Partial, improved | Rust services now traced (verified); alert rules written and **validated against the live Prometheus, but not live** (they belong to `AfroNG/monitoring_dashboard`); `RustServiceDown`/`GoServiceDown` still inert |
| Disaster recovery | Partial, unchanged | nightly `pg_dump` + weekly restore-verify (same host); optional off-host upload written, **no destination**; no PITR; **no TigerBeetle backup** |
| **UI, accessibility, browser compatibility** | **NOT DONE — plan written, awaiting a human** | `.qa/ui-test-plan.md` (updated for the current build) |
| Live load/stress test | Deliberately not done (shared cluster) | the HPA scale-up was demonstrated with ~240 rps, not as a stress test |
| Long soak (>10 min) | Not done | 10-minute soak only (local) |

## 3. Defects (full evidence in `.qa/defects.md`)
| ID | Sev | Summary | Status |
|---|---|---|---|
| QA-043 | **P1** | the client picked the demo tenant `tenant-001` for every user: 24 tenant-portal pages (no provider mounted) + 12 hard-coded pages → **403 for every real merchant and every newly registered user**; new users had no business and no way in; sidebar showed "User"/a raw UUID; admin-only links offered to merchants; `/wholesale`, `/group-deals`, 404 and Settings had no sidebar; a later login could null a user's name/email | **Fixed + live** (`server:qa-local9`, all three bundles verified on the public URL); 59 client + 12 server tests, 25 mutations killed; **not browser-walked** |
| QA-042 | **P1** | the ledger bridge ignored SIGTERM → a 30 s `503` window on every pod termination (measured 72.6 % / 79.9 %) | **Fixed + live; re-measured 100 %** (rollout, graceful delete, abrupt delete). Also fixed in recon-worker and event-processor |
| QA-042 | P2 | rollouts co-located both replicas (twice) — spread constraint spanned revisions; **my first explanation was wrong** | **Fixed + live** (`matchLabelKeys`), 6 of 6 subsequent rollouts spread |
| QA-042 | P3 | Rust services' OTLP export used gRPC against the HTTP port; every span export failed silently | **Fixed + live**; ledger bridge now in Jaeger |
| QA-039 | P2 | tenant-portal SSO login CSRF (state never checked, no PKCE) | **Fixed** (browser nonce + PKCE, server forwards the verifier); not browser-run; the flow is unreachable from the signed-out screen (finding) |
| QA-039 | P2 | bridge/recon-worker served everything unauthenticated when the key was unset **or empty**; recon-worker's inbound key shared a variable with the platform key | **Fixed + live** (fail-closed; separated) |
| QA-039 | P3 | *Provision Float Account* never worked and "fixing" it would litter the shared ledger with permanent, unconstrained accounts | **Disabled on purpose** |
| QA-039 | test | simulation J165 failed under load and retries made it permanent (harness leaked state between journeys) | **Fixed** + regression test. **Product finding open:** a crash between claiming the `crp:` marker and persisting the charge strands the marker for up to 7 days (fails safe) |
| QA-041 | P2 | no metrics API, no autoscaling (QA-027's open half) | **Fixed + live**: metrics-server + HPA; scale-up demonstrated 2 → 4 in ~30 s |
| QA-041 | P2 | resuming Flux would take the ledger down; no gate said so | **Gate written**; 4 blockers today (needs push + CI + an ImagePolicy for `tb-adapter` in another repo) |
| QA-040 | — | overload behaviour; correction of my "13 s tail" claim; an event-loop shedder built and **removed** because it did not help | Measured, documented, no code shipped. **Open:** nothing bounds an open-loop overload of one process; the ingress was not inspected |
| QA-014 | **P0** | `/api/finetune/*` unauthenticated | Fixed, tested, live |
| QA-024 | P1 | export route crashed the whole server | Fixed, live |
| QA-028 | P1 | platform-wide data exposed to any logged-in user | Fixed, 17 tests, live |
| QA-029 | P1 | `recon-worker` panicked on real data; repair pass never ran | Fixed and **live**; reconciling every 5 min, 0 discrepancies; the repair path **has never fired** |
| QA-035 / 033 / 031 | P1 | webhook confirmation never committed the ledger reservation; four contract errors; no overdraft protection; bridge never ran against a real ledger | Fixed, verified vs a real ledger, live |
| QA-015 / 016 / 017 / 005–013 | P1/2 | IDOR, SSRF, ML-ops spawn, money-role authz, idempotency, probes | Fixed, tested, live |
| QA-018 / 020 | P2 | server-initiated OAuth PKCE; SPA login CSRF + open redirect | Fixed; HTTP-verified live; **not browser-run** |
| QA-026 / 038 | P2 | NetworkPolicies + internal-key auth on bridge/recon-worker/commerce-engine | Fixed + live. **Open:** the `tigerbeetle` and `postgres-oracle` namespaces have no policy |
| QA-027 | P2 | server single replica / no HPA / no metrics / low memory limit | **Fixed** (2 → 4 replicas, HPA, metrics-server, 1Gi) |
| QA-034 / 036 | P2 | availability follow-ups; shared TigerBeetle reformatted to 3 replicas (owner-authorised, destructive) | Done + verified live |
| QA-021 | P2 | no backup of the live DB | **MITIGATED** (same-host); off-host code written, **no destination**; PITR and TigerBeetle backup open |
| CX-04 | P2 | node loss strands services on a rate-limited registry | **OPEN — and wider:** replaced nodes have none of the hand-shipped images |
| QA-019 | info | Keycloak brute-force config not provable (external IdP) | OPEN (external) |
| QA-030 / 032 / 022 / 023 / 025 / 037 | — | ledger-outage coupling fixed; DB on `pg-oracle`; smaller items | Done / logged |

**Found and not fixed** (in `.qa/defects.md`): the shared TigerBeetle namespace has no NetworkPolicy and NodePort **32001 exposes plaintext TigerBeetle outside the cluster** (policy drafted and dry-run-validated in `docs/handoff/`, not applied); `commerce-engine` is unwired (gateway URL unset, SQL vs schema mismatch); `paymentTransactions`-kind confirmations have no ledger link; `payment-orchestrator`'s bridge contract is pre-QA-033 (the key is now sent, the body is stale); the live Prometheus rules are in another repo and the fast ledger/co-location/backup alerts are handed off, not live; a stranded `crp:` marker can block an account's mandate repayments for up to 7 days.

## 4. Test results (final regression, this tree)
| Suite | Result |
|---|---|
| Main vitest (all of `server/`, `simulation/`, `client`, scripts) | **291 files passed, 1 skipped; 4,415 tests passed, 36 skipped, 0 failed** — run with `--testTimeout=30000` (before the UI fixes: 286 files, 4,344 tests, 0 failed). **With the default 5 s timeout on this laptop the same suite has nine timeouts** whenever the machine is busy (measured: load average >100 during the run, foreground apps at 100 % CPU); I re-ran each of them in isolation with a longer timeout and they all pass — they are the first test of a file that dynamically imports the whole router graph. Treat the default-timeout result as flaky on a loaded machine, not as "green" |
| Simulation, fresh world, **0 retries** (`npm run simulate`, the suite's own "authoritative gate") | **425/425 journeys PASS** — a fresh world, zero retries, ~13 minutes (the same gate that a first full-suite run had failed on J165 under load; the harness fix held) |
| Go (`go.work`, 11 modules) | `go build` + `go vet` + `go test`: the **9 modules that contain Go source pass**; `crm-adapter` and `erp-adapter` contain only a `go.mod` |
| Rust workspace | `cargo test --workspace`: pass — `ledger-bridge` 24, `recon-worker` 17, `event-processor` 6, `hermes-router` 0. Includes a test that sends a **real SIGTERM** to the test process (a missing handler kills the test binary) |
| TypeScript | `tsc --noEmit` clean |
| Mutation checks | Every new test that guards a property was mutation-checked — SSO 8/8, fail-closed + key split 9/9, SIGTERM 6/6 (the wrong-signal mutant is killed *by the signal*), manifests 10/10, preflight 9/9, ship scripts 10/10, OTLP 3/3, HPA 5/5. **Two survivors were real gaps and were closed** (a percentile test that could not tell the tail from the median — in code that was then removed — and a "never delete a tag from the nodes" property a dry-run text check could not see). A test that cannot fail is not a test |
| e2e (compose stack) | **Not re-run as a whole since pass 3**; the compose stack runs with the internal key unset (the un-enforced mode) |
| Real-TigerBeetle integration tests | Run in pass 3; not re-run in this regression (they need a real TigerBeetle) |
| Live-cluster experiments | CX-01…07 (pass 2), TB-01/NP-01/AUTH-01 (pass 3), **CX-08…CX-14 (pass 4, §7)** |
| Browser / UI / accessibility | **not run** (`.qa/ui-test-plan.md`) |

## 5. Security findings
See §3 and `.qa/defects.md`. Positives verified rather than assumed: SQL parameterised everywhere sampled; no real secrets in the repo; logout revokes tokens server-side; tokens verified against JWKS; CSRF has two layers; the rate limiter is layered and fails closed. **Pass 4:** service auth now fails closed; SSO login-CSRF closed in code; the unusable-junk provisioning path is gone. Residual: **the shared TigerBeetle/Postgres namespaces have no network policy** (the largest exposure; drafted, not applied); NodePort 32001; a `podSelector` trusts labels so anyone who can create pods in the namespace can label past a NetworkPolicy (RBAC unaudited); one shared secret means a compromise of any holder is a compromise of all; no dynamic pentest; tenant-portal SSO unreachable from the signed-out screen; `OWNER_OPEN_ID` is unset, so no account is admin until the database says so.

## 6. Performance
**Correction first:** the local numbers in `.qa/perf/summary.md` were taken with a driver on the laptop reaching the container through Docker Desktop's port proxy; their worst-case latencies equalled the test duration. Re-measured with the driver **inside the network** (ABBA order, nothing else running): closed-loop `auth.me` at c=800 gives **p99 ≈ 0.85–0.95 s, max ≈ 1.0–1.15 s** at ~1,250–1,330 rps — the old "no load shedding, p99 13 s" weak spot was mostly an artifact. **What is real:** in an open loop at 2× capacity (2,600 rps offered) the queue grows without bound (served p50 7–10 s, p99 ≈ 56 s), and that queue sits in the kernel accept/read path *ahead of any middleware* — a shedder I built did not change it (38 of ~44,000 requests refused) and was removed. Ledger path: reserve→void p50 ≈ 9 ms, p99 ≈ 14–22 ms (in-cluster, through the adapter to a 3-replica TigerBeetle). Still missing: SLOs (none exist in the repo; nothing was treated as pass/fail), any measurement of the ingress, a live load test. The HPA scales `server` 2 → 4 (demonstrated at ~240 rps); it cannot help a single connection flood.

## 7. Reliability, chaos, multi-replica, deployment, rollback (live cluster)
| Experiment | Result |
|---|---|
| CX-01 abrupt loss of 1 of 2 server replicas (pass 2) | **PASS** 899/899 |
| CX-02b `ledger-bridge` gone 62 s (pass 2, after the QA-030 fix) | **PASS** 1,498/1,498 |
| CX-03 / CX-05 / CX-06 / CX-07 server rollouts, rollback, roll-forward (pass 2) | **PASS** 1,199 / 999 / 749 / 749, all 100 % |
| CX-04 node-loss approximation (pass 2) | **PARTIAL** users unaffected, 2 services stuck on image pull |
| TB-01 kill the elected TigerBeetle primary under writes (pass 3, QA-036) | **PASS** zero failed writes; a one-address client has no fallback |
| NP-01 / AUTH-01 NetworkPolicy enforcement; staged internal-auth rollout (pass 3) | **PASS** |
| **CX-08** bridge rollout under 5 reserve→void/s, before the fix | **FAIL 79.9 %** — 150 × `503` in one 30.0 s window |
| **CX-09** graceful delete of ONE of two healthy bridge pods, before the fix | **FAIL 72.6 %** — same 30 s window, 150 failures |
| **CX-10** bridge rollout to the fixed image (old pods terminate) | 70.4 % — the old bug, one last time |
| **CX-11** bridge `rollout restart` (new pods terminate) | **PASS 100.000 %** (798/798) |
| **CX-12** graceful delete of a bridge pod, after the fix | **PASS 100.000 %** (698/698) |
| **CX-13** ABRUPT delete (`--grace-period=0 --force`) of a bridge pod | **PASS 100.000 %** (698/698) |
| **CX-14** `server` rollouts under 10 req/s public traffic (×5, three consecutive) and abrupt loss of a `server` pod | **PASS 100 %** — 1,099/1,099 · 1,098/1,098 · 1,898/1,898 · 599/599; both replicas spread after each once `matchLabelKeys` was applied (before: 2 of 2 co-located) |
| HPA scale-up (temporary 20 m target, ~240 rps) | **PASS** 2 → 4 replicas in ~30 s, all Ready, spread 2/2; target restored from the repo manifest; **scaled back down to 2 by itself** after its 10-minute stabilization window (verified) |
Details, hypotheses and rollback steps: `.qa/chaos/experiments.md`; probes: `.qa/chaos/probe.mjs` (public) and `.qa/chaos/ledger-probe.mjs` (money path, run inside a `server` pod). **Not repeated:** loss of a whole node; network faults; TigerBeetle-side faults.

## 8. Data integrity, observability, disaster recovery
- **Data integrity:** money-path concurrency invariants proven against real Postgres; commit/void idempotent by deterministic id; real overdraft protection; the reconciler runs against real data (its repair path has never fired); the simulation harness no longer leaks mandate-repayment state between journeys. **Open:** a stranded-marker liveness gap; the ledger's pre-2026-09-21 history is gone.
- **Observability:** Prometheus, Jaeger, Loki, kube-state-metrics; **Rust services now traced** (the ledger bridge appears in Jaeger with `tigerbeetle.*` spans); `docs/handoff/monitoring-alerts-whatsapp-commerce.yaml` — eight rules, every expression executed against the live Prometheus and flipped to prove it can fire — is **not live** (another repo). `RustServiceDown` is inert. `PostgresBackupRunFailing` cannot be proven on our CronJobs until their first scheduled run.
- **DR:** unchanged — nightly dump + weekly restore-verify on the same host; optional off-host upload written, **no destination**; no PITR; **no TigerBeetle backup** (the 1→3 reformat proved the point).

## 9. Corrections to my own work (what I got wrong and caught)
1. **Deep readiness on `ledger-bridge` + `server`** — would have drained every pod; reversed (readiness stays shallow).
2. **PKCE with an in-memory verifier** — would have failed logins across replicas; rebuilt as a signed cookie transaction.
3. **`/api/finetune/export-yolo` admin-only** — would have broken the merchant Inventory Hub; now tenant-scoped.
4. A simulation journey broke on the SSRF hardening — fixed in the harness, not by weakening the guard.
5. I closed the recon-worker failure as "test contention" — wrong; it was a real panic (QA-029).
6. A zsh slip made my first node-loss injection a no-op; a slow public URL was this laptop's network, not the server.
7. I built a dedicated TigerBeetle for this app — wrong: it is shared (`lanai`, `vpp`); the owner corrected me twice.
8. I reported QA-033/035 as deployed when the running `server` image had none of the code (verify the *artifact*, not the commit).
9. The shipped `tb-adapter` image predated the overdraft code — caught by my first live overdraft test.
10. The `otel` NetworkPolicy allowance was a mislabel from a stale pod IP; removed. 11. I said `event-processor` was the only live caller of `commerce-engine` — it is not a caller at all.
12. My first internal-auth pass missed a caller and my first Rust tests were vacuous (a private copy of the router) — found by grepping and by mutating.
13. **(pass 4) I called the "13 s tail" a server weakness — it was mostly the load driver's path.** Re-measured inside the network.
14. **(pass 4) I built an event-loop load shedder, and its first A/B looked like a 12× win. It was luck** — one run, one ordering. ABBA, then an in-network driver, then an open-loop test showed it did nothing at the layer where the queue is; I **removed** it. Also: a run of mine overlapped my own mutation-test loops on the same CPU and looked like a 50 % penalty; it is kept in `.qa/perf/loadshed/` labelled contaminated and excluded.
15. **(pass 4) My explanation for replica co-location (a CPU request that "didn't fit") was wrong.** I lowered the request, rolled again, and both replicas landed together *again* on the other node — which is what showed the real cause (a selector spanning revisions).
16. **(pass 4) I briefly concluded a backup alert was a placebo** (`PostgresBackupRunFailing`) — the metric family exists; our CronJobs simply have not been scheduled yet. I proved the join on another team's CronJob instead.
17. **(pass 4) A `git stash push -- <untracked path>` failed and the `stash pop` I chained after it applied one of YOUR old stashes** (74 conflicted files). I restored only the unmerged paths, confirmed all four stashes intact by SHA, and recorded the lesson. A blanket `git reset --hard` was (rightly) refused by the safety classifier.
18. **(pass 4)** the consolidated `qa-local-delta-ship.sh` was untested end to end when I wrote it. **Its first real run (shipping `qa-local9`) exposed a bug in it:** a multi-word `--expect` value was flattened by `ssh` and verified on the host as separate words. Nothing shipped unverified (the laptop-side check verified the whole phrase), it is fixed, and a stubbed-flow test now fails on the old behaviour. The Rust path of that script has still not been run for real.
19. **(QA-043) I called `/revenue` and `/escrow` returning 403 for merchants "a known UX wart".** It was a wart *I* had made (QA-028 locked them to admins) and never fixed for the people looking at the sidebar. They are now hidden from non-admins.
20. **(QA-043) My first search for hard-coded tenant ids found 11 pages; the guard test I then wrote found 3 more calls** (a query in Broadcast Campaigns and three in the KYC page) that used a different literal form. A guard test written *before* you believe the grep is done finds what the grep missed.
21. **(QA-043) I had filed all of this under "UI: not done — tooling gap" and treated it as someone else's next step.** It was findable without a browser: rendering the real components with `react-dom/server` and reading the code paths a *newly registered* user takes found the root cause in an afternoon. I should have built that harness in pass 1.

## 10. Remaining risks (ranked)
1. **The UI and the login have never been driven by a human** (the plan is `.qa/ui-test-plan.md`; group A is the part a terminal cannot prove, and the new group F walks the registration → set-up → merchant journey). The QA-043 fixes are verified by rendering the real components, not in a browser against real Keycloak.
2. **The shared TigerBeetle and Postgres namespaces are open to any pod, and TigerBeetle has no authentication** — full read/write on every tenant's ledger; NodePort 32001 exposes it outside the cluster. A validated policy is drafted; applying it needs the owner.
3. **Recoverability:** no off-host backup destination, no PITR, no TigerBeetle backup.
4. **Image supply chain:** 78 commits unpushed; hand-shipped `qa-local*` tags with `imagePullPolicy: Never`; **resuming Flux now would leave the ledger-bridge pods unable to start** (`tb-adapter`); a replaced node has none of the images; the cluster host is at 98 % disk; the link to it is intermittently a 23 KB/s relay.
5. **No admission control for overload:** one process has none, and I did not inspect the ingress.
6. **Node loss and TigerBeetle-side faults were not exercised**; alerts for this platform's own availability are handed off, not live.
7. **Live money path only partly exercised:** bridge-level reserve/void/overdraft verified; an authenticated `payment.initiate` → confirm through the live `server` is not; the reconciler's repair pass has never fired.
8. **Unfixed findings:** stranded `crp:` marker liveness; `commerce-engine` unwired; `paymentTransactions` has no ledger link (an owner decision); `payment-orchestrator`'s stale bridge contract; `lanai`/`vpp` list a single TigerBeetle address.
9. Unexercised: UI/accessibility/browser compatibility, network faults, a live load test, a soak beyond 10 minutes (local).

## 11. Readiness score (skill rubric)
| Category | Weight | Pass 3 | **Pass 4** | Why |
|---|---:|---:|---:|---|
| Functional correctness | 20 | 16 | **18** | a money-path availability defect fixed with live before/after; **and the user-blocking UI defects** (403 on every merchant/new-user page, no way in for a registered user, wrong details, missing sidebars) fixed and live; **still not walked in a real browser** |
| Security | 15 | 11 | **13** | SSO CSRF, fail-closed auth, junk-provisioning path removed; **TigerBeetle/Postgres namespaces open** (drafted, not applied), no dynamic pentest, login not browser-run |
| Reliability | 15 | 12 | **14** | bridge/server rollouts, graceful and abrupt pod loss measured at 100 %; spread fixed; HPA demonstrated; **no node-loss or TigerBeetle-side faults** |
| Test coverage/quality | 10 | 8 | **9** | 4,415 tests green, every guard mutation-checked (real gaps closed), a test that sends a real SIGTERM, **and now UI rendering tests** (the real layout for a new user / merchant / admin); **no browser test**, e2e not re-run as a whole, default-timeout flakiness on a loaded machine |
| Performance | 10 | 6 | **7** | measured properly and a wrong claim corrected; open-loop overload characterised; **no SLOs, no ingress measurement, no live load test, no in-process protection** |
| Scalability | 10 | 4 | **6** | metrics-server + HPA, scale-up demonstrated 2 → 4; max 4, bridge fixed at 2, single-process ceiling, connection floods unaddressed |
| Data integrity | 5 | 4 | **4** | harness isolation fixed; reconciler repair pass **still never fired**, stranded-marker gap open, TigerBeetle history lost |
| Observability | 5 | 3 | **4** | Rust services traced (verified), rules validated against live Prometheus — **but not live**, inert alerts remain |
| Deployment safety | 5 | 2 | **3** | artifact-verifying ship script, retained rollback tags, resume gate, measured rollouts; **still hand-shipped images, Flux suspended, 78 commits unpushed, tb-adapter has no ImagePolicy** |
| Disaster recovery | 3 | 2 | **2** | unchanged: same-host dump, no destination, no PITR, no TigerBeetle backup |
| Documentation | 2 | 2 | **2** | `.qa/` evidence trail, `docs/RESILIENCE.md`, `docs/handoff/`, UI plan |
| **Total** | **100** | **70** | **82** | descriptive, not a substitute for judgment |

**What it would take to reach 90 — and why I could not get there alone.** Each item is something only you (or another repo's owner) can do or authorise:
| Needs | Points it would earn | Why it is not mine to do |
|---|---:|---|
| **Your UI test run** (`.qa/ui-test-plan.md`, login first, then group F) | Functional +2, Security +1, Test +1 | needs a human and a real Keycloak login |
| **Push → CI builds real images → an ImagePolicy for `tb-adapter` → Flux resumed and verified** | Deployment +2, Reliability +1 | `git push` and a Flux resume are outward-facing; the ImagePolicy lives in another repo; the gate (`scripts/fluxResumePreflight.ts`) is ready |
| **A backup destination** (a bucket + credentials) and a **TigerBeetle backup** you have restored once | DR +1, Data integrity +1 | the code is written; it needs credentials I must not invent |
| **The owner's go-ahead to apply the TigerBeetle-namespace policy** (and a decision on NodePort 32001) | Security +1 | a mistake is a three-team outage; it is another team's namespace |
| **Merge the alert rules into `monitoring_dashboard`** | Observability +1 | another repo; I did not touch it |
| **SLOs you sign off + an ingress measurement** | Performance +1, Scalability +1 | thresholds are stakeholder decisions; I did not inspect the ingress |
If all of these land the total is about **95**; the first four rows alone (UI run, push/CI/Flux, backup destination, TigerBeetle policy) are worth about +10, i.e. **~92**. Without them, ~82 is what the evidence supports.

## 12. Rollout decision
```
CAN THIS PLATFORM BE ROLLED OUT TOMORROW?

ANSWER: NO-GO  (for production traffic that moves real money)
        Fine to continue as dev/staging. No unresolved P0.

CONFIDENCE: high on the specific findings (each was measured on the live cluster or reproduced); moderate on the overall
            verdict, because the UI, the interactive login and an authenticated payment through the live server were not observed.

EVIDENCE: §3–§8 and .qa/{defects.md, chaos/experiments.md, perf/summary.md, perf/loadshed/, ui-test-plan.md},
          docs/RESILIENCE.md, docs/handoff/.

BLOCKERS (each flips the answer if closed):
  1. UI + login driven by a human: run .qa/ui-test-plan.md (group A first), fix what it finds.
  2. Recoverability: an OFF-HOST backup destination, PITR on the shared CNPG cluster, and a TigerBeetle backup restored once.
  3. Shared-infrastructure exposure: the owner applies an ingress allowlist to the `tigerbeetle` (and `postgres-oracle`)
     namespace — drafted and validated in docs/handoff/ — and decides what to do about NodePort 32001.
  4. Image supply chain: push, let CI build real tags, add the tb-adapter ImagePolicy (docs/handoff/), then run
     `npx tsx scripts/fluxResumePreflight.ts` until it says SAFE — only THEN resume Flux.
  5. A real authenticated payment through the live `server` (initiate → confirm/webhook → escrow → settle), watching the
     ledger and the reconciler (and an owner decision on the `paymentTransactions` kind).
CLOSED IN PASS 4: bridge SIGTERM outage; replica co-location; Rust tracing; SSO login CSRF; fail-closed service auth;
     autoscaling (HPA demonstrated); a safe-resume gate; rollback tags retained.
HIGH-RISK ISSUES: the open TigerBeetle namespace; image supply chain (locally shipped images, suspended Flux, 78 unpushed
     commits, a resume that would break the ledger); recoverability; unbounded overload at the ingress.
REMAINING TESTS: UI + accessibility; loss of a whole node; network faults; TigerBeetle-side faults (owner's say-so); a live
     load test; an authenticated payment; the reconciler's repair path with a real orphaned reservation.
REQUIRED REGRESSION after the above: full vitest with a realistic timeout + `npm run simulate` + go + cargo + the e2e
     stack, and the chaos probes (.qa/chaos/) after ANY change to the bridge, the adapter or a rollout setting.
OPERATIONAL REQUIREMENTS: after every rollout run `scripts/qa-local-ship.sh check-spread <deployment>`; use the money-path
     probe for anything touching the bridge; tell the `lanai` and `vpp` owners to list all three TigerBeetle addresses;
     never `kubectl apply` a repo manifest while Flux is suspended (it reverts the running images).
ROLLBACK PLAN: `kubectl rollout undo` WORKS for server/bridge/recon-worker while the previous qa-local* image is on the
     nodes (they are kept now: server qa-local7/3, bridge and recon-worker qa-local2/3). Emergency off-switch for the service
     auth: remove the INTERNAL_API_KEY env entry from the callee — but note REQUIRE_INTERNAL_API_KEY=true will refuse to start
     without it, so remove that too.
RECOVERY PLAN: Postgres restore rehearsed and the weekly restore-verify runs on the cluster (same host); not rehearsed
     against live; TigerBeetle has none.
```
