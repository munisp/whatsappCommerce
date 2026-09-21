# Local performance / load results (skill §27–28)

**Where:** the local e2e docker-compose stack only (one `platform` container, Postgres, Redis) on a Mac running Docker Desktop (7.75 GiB VM) — chosen by you so the shared live cluster was never loaded. **Driver:** the repo's own `scripts/perf/load.mjs` (Node built-ins), so numbers are comparable in method to `docs/PERF.md`, but **not in absolute terms** (that baseline was 2 vCPU native Linux; this is a Mac VM). The platform container ran with no CPU/memory limit.
**Thresholds:** the repo defines no latency/throughput SLO for the API (the only latency alert is payout p95 > 30 s). Anything below marked *(assumed)* is my assumption and needs stakeholder confirmation — I did not treat any number as a pass/fail gate.

| Phase | Requests | RPS | Status counts | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---|---:|---:|---:|---:|
| BASELINE /health c=20 15s | 47971 | 3197 | 200:47971 | 5.21 | 10.61 | 14.91 | 95.08 |
| BASELINE auth.me c=20 15s | 16703 | 1112.3 | 200:16703 | 17.03 | 25.59 | 35.5 | 109.67 |
| LOAD /health c=100 20s | 59317 | 2959.3 | 200:59317 | 31.78 | 43.29 | 79.27 | 1195.07 |
| LOAD auth.me c=100 20s | 22876 | 1140 | 200:22876 | 86.38 | 99.31 | 134.56 | 675.79 |
| AUTHED product.list c=20 30s (limiter expected to engage) | 59888 | 1995.7 | 200:400 429:59488 | 8.6 | 12.45 | 19.59 | 228.49 |
| STRESS auth.me c=200 20s | 22723 | 1129.7 | 200:22723 | 174 | 199.56 | 265.43 | 2903.17 |
| STRESS auth.me c=400 20s | 25081 | 1241.8 | 200:25081 | 303.06 | 372.13 | 418.33 | 9050.87 |
| STRESS auth.me c=800 20s | 26789 | 1293.3 | 200:26789 | 365.27 | 489.66 | 13343.03 | 20668.07 |
| SPIKE-1 calm c=10 10s | 9023 | 901.1 | 200:9023 | 10.61 | 14.96 | 17.34 | 75.59 |
| SPIKE-2 spike c=400 10s | 13082 | 1285.4 | 200:13082 | 248.73 | 318.04 | 2820.37 | 8619.37 |
| SPIKE-3 recovery c=10 10s | 8938 | 893.4 | 200:8938 | 10.43 | 15.26 | 21.51 | 72.52 |
| SOAK auth.me c=50 600s | 721097 | 1201.8 | 200:721097 | 40.64 | 52.34 | 70.37 | 207.66 |

## Reading the numbers
- **Saturation:** `auth.me` (a trivial tRPC call) plateaus at ~1.1–1.3k RPS from concurrency 20 upward; latency then grows linearly with concurrency (Little's law) — a single Node event loop at ~130–170 % CPU. `/health` plateaus ~3k RPS. No errors at any concurrency up to 800.
- **Tail under overload:** at c=800 p99 reached **13.3 s** (p95 490 ms), and at the 400-concurrency spike p99 hit 2.8 s. There is no load shedding / backpressure — excess requests just queue. With a single replica that is the failure mode to expect on a burst.
- **Recovery:** after the 400-concurrency spike, latency returned to baseline immediately (p95 15 ms vs 15 ms before) — no lingering degradation.
- **Rate limiter under load (verified, not assumed):** authenticated `product.list` at c=20 for 30 s → 400 × 200 then 59,488 × 429. The per-tenant limit (200/min, fixed window: two windows fell inside the 30 s) engaged and the rejection path stayed cheap (~2,000 RPS, p95 12 ms) — it does not itself become a DoS surface.
- **Soak (600 s, c=50, `auth.me`):** 721,097 requests, **0 errors**, ~1,202 RPS, p50 40.6 / p95 52.3 / p99 70.4 / max 207.7 ms. Container memory sampled every 30 s stayed in a flat 613–680 MiB band with periodic GC spikes to ~800 MiB and no upward trend (t=0: 613 MiB, t=540 s: 630 MiB) → **no leak signal over 10 minutes** (longer soaks not attempted). CPU steady at ~131–137 %.

## What this means for the live deployment (derived, not measured there)
The live `server` Deployment is **1 replica, CPU limit 500m, memory limit 512Mi**, no HPA, no PDB, and the cluster has no metrics-server (so an HPA could not work). Compared with what the container needed under load here:
- **CPU:** 130–170 % of a core vs a 500m limit → under sustained load the pod would be CFS-throttled to roughly a third of the throughput measured above.
- **Memory:** 613–800 MiB under load (312 MiB just idle at baseline) vs a **512 Mi limit** → under comparable sustained load the pod would be **OOM-killed** (idle is already ~60 % of the limit). Live traffic is currently tiny, so this is a capacity-planning risk, not a present incident.
