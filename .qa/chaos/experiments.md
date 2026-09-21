# Chaos experiments (skill §26) — live dev cluster `kind-newwave-dev`, namespace `whatsapp-commerce`

Ground rules I held myself to: time-boxed, every injection has an explicit rollback that I run even if the observation fails, everything is scoped to **this namespace's workloads**, and probing runs **from the cluster host** (this laptop's network path adds a ~6.5 s TLS handshake to the public URL, which would swamp sub-second failure windows — the host reaches the same URL in 0.08 s). Availability is measured by `.qa/chaos/probe.mjs` (every request recorded; failure *windows* reported in seconds).

Deliberately **not** done, with reasons:
- **Node failure / drain / network partition / latency injection / CPU-memory pressure at node level** — the kind nodes are shared with many other projects' pods (421 pods cluster-wide), there are no NetworkPolicies to inject with, and `kubectl exec`/privileged tooling was blocked by the tool sandbox. I approximated node loss for *our* workloads only (CX-04).
- **DNS failure, disk pressure, expired-credential experiments** — no safe, namespace-scoped way to inject them here.


All availability numbers are HTTP GET `https://wa-app.newfire.app/health` (public ingress → APISIX → `server`) at 10 req/s **from the cluster host**, every request recorded (`.qa/chaos/probe.mjs`). Baseline before any injection: 199/199 OK, p50 26 ms.

---
## CX-01 — abrupt loss of one of two `server` replicas
**HYPOTHESIS:** with 2 replicas and working probes, killing one pod is invisible to users. **TARGET:** `deploy/server`, scaled 1→2 (scheduler spread them across both workers). **INJECTION:** `kubectl delete pod --grace-period=0 --force` (an abrupt crash — no graceful drain). **OBSERVE:** 90 s. **SUCCESS:** ≥99.9 % availability, replacement Ready. **ROLLBACK:** scale back to 1.
**RESULT: PASS.** 899/899 requests OK, 0 failures, p99 163 ms, max 362 ms. Replacement pod Ready in ~15 s.

## CX-02 — full outage of a dependency: `ledger-bridge` → 0 replicas for ~62 s
**HYPOTHESIS:** the platform's documented design (docs/RESILIENCE.md) is graceful degradation on ledger trouble, so users keep being served. **TARGET:** `deploy/ledger-bridge` (1 replica). **INJECTION:** `scale --replicas=0`, restore after ~62 s (unconditional). **SUCCESS:** ≥99 % availability. 
**RESULT: FAIL — hypothesis refuted.** 1,213/1,498 OK (**80.98 %**); one contiguous **28.4 s window of 503s** (285 requests). Server pods went 2/2→1/2 (readiness failing) ≈30 s after the injection, the Service had **0 endpoints**, and it recovered ~5 s after the bridge returned. Cause: `checkTigerBeetle()` fails readiness when the bridge is *unreachable* (pre-existing behavior, pinned by a unit test that calls it a hard dependency), while the same document says ledger trouble degrades gracefully. **The two designs disagree, and with a single bridge replica every bridge restart is a ~30 s full outage.** (When the bridge is *up* but TigerBeetle/Postgres are down — the live cluster's actual state — readiness stays green and payments fail honestly; that half of the design holds.) **Owner decision needed:** treat an unreachable bridge as `degraded` too, or run ≥2 bridge replicas.

## CX-03 — rolling deploy N → N+1 under traffic
**HYPOTHESIS:** with readiness probes a rolling deploy is zero-downtime. **INJECTION:** `kubectl set image` to a locally-built `qa-local2`, `rollout status`. **RESULT: PASS.** Rollout took ~12 s; **1,199/1,199 OK, 0 failures**, p99 145 ms, max 440 ms. New pod verified: `/api/finetune/stream` 403 and `/api/finetune/export-yolo` 401 with no credentials; readiness now shows `tigerbeetle.degraded`.

## CX-04 — node loss, approximated for this namespace only
**HYPOTHESIS:** losing a node's worth of our pods self-heals within ~1 min and users don't notice. **INJECTION:** cordon `newwave-dev-worker2`, force-delete the 6 pods of ours on it (`event-processor`, `gateway`, `ml-stack`, `recon-worker`, one `server` replica, `webhook-ingestor`), then uncordon. (A real node failure or drain was **not** done: the kind nodes are shared with many other projects' pods.)
**RESULT: PARTIAL.** User-facing: **1,298/1,298 OK, 0 failures** (the surviving `server` replica took the traffic). Cluster: 4 of 6 pods rescheduled in ~10 s; **`ml-stack` and `recon-worker` went `ImagePullBackOff` and stayed there** — their images aren't cached on the other worker and the DigitalOcean registry is rate-limited (429) — until I deleted them so they rescheduled onto the node that has the images. Confirmed beforehand by inspecting each node's image cache. **A real node loss would leave those services down until the registry lets the pull through.** (Also: a first attempt of this experiment silently deleted nothing — my zsh script didn't word-split a multi-line variable; caught from the `force-deleted: 0` line, node restored, redone.)

## CX-05 — rollback under traffic
**HYPOTHESIS:** `kubectl rollout undo` returns to the previous version with no user impact, and rolling forward again is equally clean. **INJECTION:** undo to `qa-local`, verify the old code is really serving, roll forward to `qa-local2`. **RESULT: PASS.** **999/999 OK, 0 failures.** The old version was confirmed live (its `/health/ready` still showed the masked `tigerbeetle ok:true`, no `degraded` field) for ~20 s. **Caveat:** rollback works here only because the previous image is still on the nodes — it is a locally shipped tag with `imagePullPolicy: Never`, so `qa-local` cannot be re-pulled if a node's copy is lost. Database compatibility was not exercised (no migrations were involved).

## CX-06 — second rolling deploy (`qa-local3`, the QA-028 cross-tenant fixes)
Same procedure as CX-03. **PASS: 749/749 OK, 0 failures**, p99 215 ms. Afterwards, live: `/health` 200; `/api/finetune/stream` 403; `/api/finetune/export-yolo` 401; `revenue.tenantBreakdown` and `webhookDlq.listEvents` with no session → 403. The oldest server image tag (`qa-local`) was then removed from the three nodes (host disk is 96 % full); `qa-local2` was kept as the rollback target. Final state: 15/15 deployments ready, nodes schedulable, Flux still suspended, `server` on `qa-local3`, 1 replica.
