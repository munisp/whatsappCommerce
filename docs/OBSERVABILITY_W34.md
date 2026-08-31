# W34 Observability — OpenTelemetry stack + OSS alerting

Wave 34 adds platform-wide observability. This document covers the infra
(Coder B: `deploy/otel/`, compose, k8s, dashboards, alerts, WA bridge). Node
instrumentation/propagation/metrics endpoint are Coder A (`w34/otel-core`);
python sidecars + tenant cardinality are Coder C (`w34/otel-sidecars`).

## Architecture

```
platform (OTEL_ENABLED=true)            sidecars
   | OTLP HTTP :4318 / gRPC :4317           |
   v                                        v
+---------------- otel-collector ---------------------------+
|  memory_limiter -> batch -> tail_sampling                 |
|    (100% errors, 100% >2s, 10% baseline OK)               |
|  traces -> Jaeger (otlp)                                  |
|  spans  -> spanmetrics connector -> RED metrics           |
|  metrics+spanmetrics -> Prometheus exporter :9464         |
+-----------------------------------------------------------+
   ^ /api/metrics (METRICS_TOKEN bearer)        ^ :9464
   |                                            |
Prometheus (:9090) ----alert rules----> Alertmanager (:9093)
   |                                      |-- email (SMTP)
   |                                      +-- webhook -> alertmanager-wa-bridge (:9099)
   v                                                       | (fail-open)
Grafana (:3001, provisioned)                    platform internal send -> ops WhatsApp
```

Telemetry is **fail-open everywhere**: collector down / bridge down / Grafana
down never breaks platform requests. The platform's `/api/metrics` honestly
503s when `OTEL_ENABLED` is unset; the WA bridge honestly 404s `/alerts` when
`ALERTMANAGER_WA_BRIDGE_ENABLED` is not exactly `true`.

## How to run / open

Compose:

```bash
docker compose up -d otel-collector jaeger prometheus grafana alertmanager alertmanager-wa-bridge
```

- Jaeger UI: <http://localhost:16686> (service `whatsapp-commerce-platform`)
- Grafana: <http://localhost:3001> (admin / `GRAFANA_ADMIN_PASSWORD`), folder
  **W34 Observability** with 4 provisioned dashboards (below)
- Prometheus: <http://localhost:9090> (Targets + Alerts pages)
- Alertmanager: <http://localhost:9093>
- WA bridge health: <http://localhost:9099/health> (reports enabled flag +
  delivered/dropped counters)

Kubernetes: `kubectl apply -k k8s/` — `k8s/otel-stack.yaml` deploys all five
components + the WA bridge (Deployments + Services + ConfigMaps, HTTP
readiness probes). Note: the k8s Alertmanager ConfigMap keeps `${...}`
placeholders — render it from your secrets manager before apply (compose
renders it with sed at container start).

## Dashboards (provisioned, committed JSON)

- **Platform RED** — rate / error ratio / p50+p95 per route, tRPC calls +
  errors per procedure, collector spanmetrics RED.
- **Infra components** — `infra_component_up` ×15 stat board + timeline +
  probe latency p95.
- **Money rails** — escrow settlements by outcome, payout latency p50/p95,
  cron failures + runs by result.
- **Tenant explorer** — per-tenant RED with a `$tenant` template variable
  (allowlisted tenants only; everything else collapses to `tenant_class="other"`).

Palette: muted slate/sage/amber/dusty-red (low saturation), dark style.

## Alert catalog (`deploy/otel/alert-rules.yml`)

| Alert | Severity | Condition |
|---|---|---|
| ReadinessFlapping | critical | `/health/ready` 5xx rate > 0.1/s for 5m |
| Elevated5xx | critical | global 5xx ratio > 5% for 5m |
| CronFailure | warning | any `cron_runs_total{result="error"}` increase in 15m |
| EscrowSettleFailure | critical | any `escrow_settlements_total{outcome="error"}` increase in 15m |
| PayoutLatencyHigh | warning | payout p95 > 30s for 10m |
| TenantErrorSpike | warning | per-tenant tRPC error rate > 3σ above its own 1h baseline (allowlist-only) |
| ComponentDown | critical | `infra_component_up == 0` for 5m |

Routing (Alertmanager): critical → email **and** webhook (WhatsApp bridge);
warning → email only. Inhibition: critical suppresses same-name warning;
`ComponentDown` suppresses `Elevated5xx` noise.

Honest contract: rules reference the binding metric names from
`/api/metrics` (see Merger notes in SPEC_W34). If a metric is absent, the
rule is **inactive** (visible on Prometheus /alerts), never a fake firing.

## Cardinality guidance

- `tenant_class` is bounded by `OTEL_TENANT_METRIC_ALLOWLIST` (+ `"other"`).
  Never put raw tenant ids on metrics outside the allowlist; traces carry
  `tenant.id` baggage for per-tenant drill-down instead.
- `infra_component_up` is fixed at 15 series (platform probe set).
- spanmetrics adds `service.name`, `span.name`, `status.code`, `tenant.id`
  (defaulted to `other`) — do not add high-cardinality dimensions.

## WhatsApp ops bridge (`deploy/otel/alertmanager-wa-bridge.mjs`)

Stdlib-only Node service (no new deps — wave lockfile freeze). Receives
Alertmanager webhook → formats a plain-text alert digest → POSTs to the
platform's internal send pipeline (`PLATFORM_API_URL` +
`/api/internal/wa-ops-alert`, `X-Internal-Token` auth) addressed to
`OPS_ALERT_WHATSAPP`. Fail-open: any delivery failure is logged + counted in
`/health.dropped`; Alertmanager always gets 200 for parsed webhooks so a
broken WhatsApp path cannot cause a retry storm (email still fires).

> Merger note (RESOLVED at merge): the platform-side receiver route
> `POST /api/internal/wa-ops-alert` now exists (server/_core/index.ts,
> `=== W34 wa-ops-alert ===` banner — X-Internal-Token gated, fail-closed,
> zod-validated, 30/min fail-closed rate limit, honest 503 when WhatsApp env
> credentials are unset; journey J222).

<!--
=== W34 otel-sidecars (Coder C) ===
This file is created on branch w34/otel-sidecars containing ONLY the Coder C
sections below (sidecar coverage matrix, cardinality guard, Tenant 360).
Coder B (w34/otel-stack) owns the main architecture/alert-catalog body of
this document — merger: keep BOTH banner blocks, B's body first, then this
`=== W34 otel-sidecars ===` section verbatim.
-->

## === W34 otel-sidecars (Coder C): sidecar trace coverage ===

### Python sidecars — instrumented (fail-open, OTEL_ENABLED default false)

| Service | Framework | Instrumentation | Span source |
|---|---|---|---|
| `services/kyc-verifier` | FastAPI (uvicorn) | `opentelemetry-instrumentation-fastapi==0.59b0` + `opentelemetry-sdk==1.38.0` + `opentelemetry-exporter-otlp-proto-http==1.38.0` (exact pins in its `requirements.txt`) | Auto server spans per request; inbound W3C `traceparent` extracted by the FastAPI instrumentor so platform→sidecar calls continue the trace. |
| `ai-agent` | FastAPI (uvicorn) | same pinned trio | Auto server spans **plus honest manual spans** `ai.agent.handle` (attrs `tenant.id`, `ai.operation`) wrapping `/intent`, `/recommend`, `/handoff-summary`. |

Both modules (`app/telemetry.py` / `api/telemetry.py`):

- are **import-safe without the OTel packages installed** (lazy imports) and
  fail open: `OTEL_ENABLED=true` with a missing package or bad endpoint logs
  the error into `telemetry_status().last_error` and requests proceed;
- echo the inbound trace id as an `x-trace-id` response header (pure stdlib
  `traceparent` parse — works with OTel on or off) so callers can verify
  trace continuation (J220);
- report honest telemetry status in `/health` (W30 pattern):
  `{enabled, active, exporter, endpoint, last_error}`.

### Go services — NOT instrumented this wave (honest)

`services/hermes-bridge`, `services/event-gateway` (and the other `go.work`
members) have buildable `main.go`s, but the Go toolchain is **not available
in CI** and their `go.mod`/`go.sum` do not include the OTel SDK. Adding
`go.opentelemetry.io/otel` would require network module resolution + a Go
toolchain we cannot verify here — per doctrine (fail honestly > fake
instrumentation) they emit **no traces** in W34. Their calls are still
visible as CLIENT spans on the platform side (A's outbound propagation).

### Rust services — NOT instrumented this wave (honest)

`rust/ledger-bridge`, `rust/recon-worker`, `rust/hermes-router`,
`rust/event-processor`, `services/ledger-bridge`,
`services/message-processor`, `services/fluvio-consumer` have buildable
mains but no `cargo`/rustc toolchain in CI and no `opentelemetry` crates in
their `Cargo.lock`s. Same honest outcome: no Rust-side spans in W34.

### Tenant cardinality guard (`server/services/telemetryCardinality.ts`)

`tenantMetricClass(tenantId)` maps a tenant to its Prometheus label value:
tenants in the allowlist keep their `tenantId`; everyone else collapses to
`"other"`. The allowlist is the union of:

1. the `OTEL_TENANT_METRIC_ALLOWLIST` CSV env var (Coder A's config surface),
2. the persisted `telemetry_tenant_allowlist` table (migration 0115),
   managed via the admin-only `telemetry.setTenantAllowlist` tRPC mutation
   (audited: `telemetry.allowlist.set` audit row with the admin actor).

This bounds `/api/metrics` label cardinality to `allowlist + 1 ("other")`
regardless of tenant count (J221).

### "Tenant 360" Grafana dashboard

`deploy/otel/grafana/dashboards/tenant-360.json` (provisioned by B's Grafana
compose/k8s provisioning). Per-tenant view driven by a `$tenant` template
variable: RED panels (rate / error ratio / p95 duration from
`http_requests_total` / `http_request_duration_ms` filtered on
`tenant_class="$tenant"`), a Jaeger traces link filtered by `tenant.id`, and
an **honest** alert-history panel (queried live from the Alertmanager API —
the panel is omitted when the Alertmanager datasource is not configured;
there is no fake/static alert data).

## === END W34 otel-sidecars ===
