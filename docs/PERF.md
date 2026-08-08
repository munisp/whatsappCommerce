# PERF.md — Performance Verification & Scaling Notes

All measurements below were produced on the machine that ran this verification.
Absolute numbers are environment-dependent; re-run the scripts to get yours.

**Environment**: 2 vCPU (Intel Xeon Platinum), 4 GB RAM, x86_64 Linux,
Node v20.20.2, Go 1.23.4, Python 3.12.12 (torch 2.8.0 CPU inference), Rust stable.

---

## 1. Four-language sweep

| Stack | Command | Result |
|---|---|---|
| TypeScript (platform) | `npx tsc --noEmit` | clean, 0 errors |
| TypeScript (tests) | `npx vitest run` | **402 passed, 7 skipped** (13 files, ~10s) |
| Go (all 10 modules) | `go test ./...` per module (`GOPROXY=https://goproxy.cn,direct`) | all packages compile & pass; only `gateway/internal/middleware` ships tests (benchmarks below); other packages report `[no test files]` |
| Rust (workspace) | `cargo test --workspace` in `rust/` | see §1a |
| Python (ml-stack) | `python3 -m py_compile $(find services/ml-stack -name '*.py')` | all 19 files compile; **no pytest tests exist** in ml-stack — compile-check is the sweep |

### 1a. Rust workspace

`rust/` contains a 4-member workspace (`event-processor`, `hermes-router`,
`ledger-bridge`, `recon-worker`). `cargo test --workspace` compiles all members
clean (3 pre-existing `unused import`/`never read` warnings) and runs 4 test
binaries — **all 4 pass with 0 tests each**: the Rust services ship no unit
tests today, so a clean full-workspace compile is the sweep result.

## 2. Local load test (TS platform)

Setup:

```bash
node scripts/perf/mini-redis.mjs --port 6390 &      # RESP shim for the limiter
NODE_ENV=test PORT=3000 JWT_SECRET=<32+ bytes> REDIS_URL=redis://127.0.0.1:6390 \
  npx tsx server/_core/index.ts &
node scripts/perf/load.mjs --url http://127.0.0.1:3000/health --concurrency 100 --duration 10
```

`auth.me` sweeps used `--random-tenant` so the 200 req/min/tenant limiter stays
engaged but does not skew the latency measurement.

### GET /health (liveness, no DB)

| Concurrency | RPS | mean | p50 | p95 | p99 | errors |
|---|---|---|---|---|---|---|
| 50  | 4338 | 11.5 ms | 9.2 ms | 21.5 ms | 43.9 ms | 0 |
| 100 | 4648 | 21.5 ms | 18.6 ms | 37.4 ms | 60.2 ms | 0 |
| 200 | 4524 | 43.9 ms | 39.6 ms | 73.7 ms | 105.9 ms | 0 |

### GET /api/trpc/auth.me (tRPC + Redis-backed limiter in path)

| Concurrency | RPS | mean | p50 | p95 | p99 | errors |
|---|---|---|---|---|---|---|
| 50  | 1780 | 27.9 ms | 22.9 ms | 60.8 ms | 84.1 ms | 0 |
| 100 | 2101 | 47.3 ms | 42.8 ms | 76.2 ms | 115.7 ms | 0 |
| 200 | 2129 | 93.3 ms | 84.4 ms | 148.5 ms | 177.8 ms | 0 |

Throughput saturates ~4.6k RPS on `/health` and ~2.1k RPS on `auth.me` on 2
vCPUs; latency grows ~linearly with concurrency past the saturation point —
classic queueing, no errors.

### Rate limiter verification (200 req/min/tenant)

250 requests in a single minute window, one tenant:

```
statuses: 200:200 429:50
```

The limiter trips **exactly** at 200 req/min/tenant: first 200 requests pass,
the next 50 are rejected with `429` (`retryAfter: 60`). Verified against
`scripts/perf/mini-redis.mjs` (INCR/EXPIRE semantics match the production
`server/redis.ts: redisIncrEx` path).

## 3. ML inference bench (real torch CPU weights)

`services/ml-stack/models/weights/` ships trained checkpoints
(`fraud_gnn_lstm.pt`, `credit_tabnet.pt`). The bench runs 100 predictions
through `inference/predict.py` (same entry the TS backend calls); both models
report `source: "model"` (real weights, not the heuristic fallback):

```
n=100  mean=24.8ms  min=18.9ms  p50=20.6ms  p95=38.5ms  max=44.8ms   (warm)
```

(first cold run: mean 33.5 ms, max 901 ms — torch thread-pool warmup.)

This **corrects an earlier ~3 ms claim**: end-to-end prediction latency on
commodity CPU is ~20–25 ms mean / ~39 ms p95 on 2 vCPUs. Prior measurement on
a beefier box: ~13.5 ms mean e2e, ~10.6 ms server-side forward pass.

## 4. V8 heap experiment (`--max-old-space-size`)

Workload: ~80 MB live set + continuous garbage churn, GC events/pauses parsed
from `--trace-gc`:

| Cap | GC events | major GC | total GC pause | major pause | workload wall time |
|---|---|---|---|---|---|
| 256 MB  | 168 | 13 | 421 ms | 297 ms | 2342 ms |
| 2048 MB | 158 | 1  | 124 ms | 19 ms  | 1675 ms |

The 2 GB cap collapses **major** (Mark-Compact) collections 13→1 and major-GC
pause 297→19 ms, cutting total GC pause ~3.4× and wall time ~29%. This is why
`NODE_OPTIONS=--max-old-space-size=2048` is applied to the platform
(Dockerfile, docker-compose, k8s, `npm start`). A prior run on a
heavier workload saw 617 events/2936 ms → 56 events/499 ms; the direction and
magnitude reproduce here.

## 5. Go gateway — JWT validation benchmark

`services/gateway/internal/middleware/keycloak_bench_test.go` (2048-bit RSA
key generated once outside the loop; keygen inside a benchmark would measure
keygen, not validation):

```
BenchmarkKeycloakJWTValidate-2   27518   43527 ns/op   4544 B/op   62 allocs/op
BenchmarkKeycloakMiddleware-2    21583   79728 ns/op  14601 B/op  144 allocs/op
```

RS256 signature verification dominates (~44 µs/op); the full gin middleware
path (header parsing, JWKS cache hit, claims injection) adds ~36 µs. A prior
run measured ~85 µs/op for the middleware path — same order, RS256-dominated.

## 6. Auth-hardening regression latency

`scripts/perf/auth-bench.mts` (2000 iterations, `jose`):

| Bench | mean | p50 | p95 |
|---|---|---|---|
| HS256 session-JWT verify (`sdk.verifySession` path) | 0.139 ms | 0.094 ms | 0.171 ms |
| RS256 Keycloak-style verify (2048-bit) | 0.119 ms | 0.089 ms | 0.134 ms |
| Permify permission check | skipped — `PERMIFY_URL` not set locally | | |

So the JWT hardening added to the platform request path is **sub-millisecond**
(prior: +0.37 ms mean). The Permify fine-grained check is only incurred when
Permify is enabled; prior measurement: **+1.65 ms** per checked request over
the network. Budget ~2 ms/request total for the auth-hardening layer.

## 7. 100k-user scaling path

Targets ~100k concurrent users ≈ 10–20k RPS at the API edge.

1. **APISIX edge**: run ≥3 APISIX replicas behind the load balancer; APISIX is
   stateless — scale horizontally, terminate TLS there.
2. **TS platform (Node)**: `k8s/platform-deployment.yaml` ships an HPA,
   **minReplicas 2 → maxReplicas 20**, 70% CPU / 80% memory targets. Measured
   single-process throughput is ~2.1k RPS on the tRPC path per 2-vCPU pod, so
   10–20k RPS needs ~6–12 pods; 20 pod headroom covers burst + deploys. Node
   clustering is *not* required if pods are the unit of scale; if used, one
   worker per core with a shared-nothing Redis limiter (already the case).
3. **Postgres pool math**: `PG_POOL_MAX` (default 10) × 20 replicas = 200
   max connections. Keep Postgres `max_connections` ≥ 300 and use PgBouncer
   (transaction pooling) beyond ~20 replicas. Formula:
   `PG_POOL_MAX × replicas ≤ max_connections × 0.7`.
4. **Redis**: single primary handles the 200 req/min limiter and session cache
   at this scale (INCR/EXPIRE are O(1)); add a replica for failover, cluster
   only past ~50k RPS of limiter traffic.
5. **ML inference**: CPU-bound torch — set `UVICORN_WORKERS` = container CPU
   limit (now env-configurable in `services/ml-stack/Dockerfile`) and scale
   the `ml-inference` Deployment; ~25 ms/prediction means one 2-core worker
   serves ~80 predictions/s, so ~4 workers per node and N nodes = target RPS /
   80.
6. **Go gateway + Rust services**: stateless; scale by HPA on CPU like the
   platform.

## Notes

- `.github/workflows/` **does not exist** in this repo — no CI workflow to add
  NODE_OPTIONS to; documented here instead.
- `scripts/perf/load.mjs`, `scripts/perf/mini-redis.mjs`,
  `scripts/perf/auth-bench.mts` are self-contained (Node built-ins / existing
  deps only) — no new runtime dependencies introduced.
