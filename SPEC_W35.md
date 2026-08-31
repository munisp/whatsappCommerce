# SPEC_W35 — Full-Mesh OpenTelemetry (Go / Rust / Python / Messaging / Infra Receivers)

Base: main @ 00371bdbd926d4345061ba782584cf59e9a5e605 (post-W34). This spec is BINDING.

## Global invariants (all coders)
- paymentConfirm.ts PINNED (md5 2f77ea4816d1adc5cb35473bd35d1697). Do not touch.
- package.json / package-lock.json / pnpm-lock.yaml: FROZEN except Coder C's sanctioned additions (listed below). Nobody else touches manifests or lockfiles.
- Additive-only schema. No new migrations this wave EXCEPT Coder D's sanctioned 0116 (below).
- Telemetry is FAIL-OPEN everywhere: OTel init errors must never crash a service; log + continue uninstrumented, expose honest status.
- No Go or Rust toolchain exists in this environment. Go/Rust code MUST NOT be "compiled and hoped" — write it carefully against the exact APIs of the pinned dependency versions, keep it minimal and mechanical, and gate with `gofmt`-style manual review + static reading. Honest-status doctrine: if a service cannot be verifiably instrumented, document it; never fake.
- Shared-file edits are banner-delimited and append-only where possible: `// === W35 <topic> ===` … `// === END W35 <topic> ===`.
- New env vars → append to env.example.txt under a `=== W35 ===` banner.
- All env config read through existing env.ts patterns where a Node service is involved; Go/Rust/Python read process env directly with safe defaults (disabled).
- Journeys: new simulation journeys J223+ as assigned below; update simulation.test.ts count to match (merger owns final count).
- Never commit empty files. Verify `wc -c` > 0 before commit.

## Coder A — Go instrumentation (10 services + TigerBeetle client)
Owns: services/commerce-engine, services/conversation-orchestrator, services/crm-adapter, services/erp-adapter, services/event-gateway, services/gateway, services/hermes-bridge, services/notification-service, services/payment-orchestrator, services/visual-inventory/go-orchestrator, go.work (additive), shared/go (new, see below).

1. New module `shared/go/otelx/` (module path follows existing go.work module naming — inspect go.work first and mirror it): a tiny fail-open helper package exposing:
   - `Init(ctx, serviceName) (shutdown func(context.Context) error, enabled bool)` — reads `OTEL_ENABLED` (default false), `OTEL_EXPORTER_OTLP_ENDPOINT` (default http://otel-collector:4318), `OTEL_SERVICE_NAME` fallback to arg. Uses go.opentelemetry.io/otel SDK, stdouttrace noop when disabled. Batch OTLP/HTTP trace exporter + periodic OTLP metric reader. Resource: service.name, service.namespace=whatsappcommerce, deployment.environment from env.
   - `Middleware(serviceName) func(http.Handler) http.Handler` — otelhttp-style handler wrapper implemented against go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.62.0; extracts inbound W3C traceparent (otelhttp does this via propagators — set global propagator to tracecontext+baggage).
   - `TenantAttr(ctx) attribute.KeyValue` — reads tenant id from header `x-tenant-id`, returns attribute `tenant.id` ONLY if present; never invent.
   - `Err(err)` records error on span; `Status()` returns enabled flag for health endpoints.
2. In EACH of the 10 services' main.go: call otelx.Init early, defer shutdown, wrap the root HTTP handler with otelx.Middleware, add otel_enabled to existing health/status output. MECHANICAL, same 6-line pattern per service. If a service's main.go structure makes this unsafe, skip that service and document in code comment + report — do NOT refactor.
3. TigerBeetle client spans: in the Go ledger-bridge client call sites (find where TB client is invoked), wrap each op in a span `tigerbeetle.<op>` with attributes db.system=tigerbeetle, tb.operation, tenant.id when known. Fail-open.
4. go.work: add shared/go/otelx via `use` (additive). Each service go.mod gets require lines for otel deps at EXACT versions: go.opentelemetry.io/otel v1.38.0, go.opentelemetry.io/otel/sdk v1.38.0, go.opentelemetry.io/otel/metric v1.38.0, go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.38.0, go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp v1.38.0, go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.62.0. Update go.work.sum/go.mod sums only if you can compute them without network; otherwise leave sums untouched and document that `go mod tidy` must be run at build time (Dockerfile builds already run go mod download — verify each service Dockerfile does; if yes, no sum changes needed, state this in report).
Report: per-service status table (instrumented / skipped+why), file list, exact go.mod diffs.

## Coder B — Rust instrumentation (4 crates)
Owns: rust/event-processor, rust/hermes-router, rust/ledger-bridge, rust/recon-worker, services/fluvio-consumer.
1. Per crate, add to Cargo.toml (exact pins): tracing = "0.1", tracing-subscriber = { version = "0.3", features = ["env-filter"] }, opentelemetry = "0.30", opentelemetry-otlp = "0.30", tracing-opentelemetry = "0.31", opentelemetry_sdk = "0.30". Check existing Cargo.toml editions/deps first to avoid dup keys; merge features, don't duplicate.
2. Shared pattern per main.rs (banner `// === W35 otel ===`): init function reading OTEL_ENABLED (default false) + OTEL_EXPORTER_OTLP_ENDPOINT (default http://otel-collector:4318); when disabled, plain tracing_subscriber fmt layer only (existing behavior preserved); when enabled, add OpenTelemetryLayer with OTLP tonic exporter, service.name resource. Fail-open: exporter build failure → log + fmt-only. Keep it under 60 lines per crate.
3. fluvio-consumer: extract W3C `traceparent` from message headers/record metadata when present (opentelemetry::global::get_text_map_propagator style manual extraction is fine), start consumer span `fluvio.consume` per record with messaging.system=fluvio, messaging.destination=<topic>. hermes-router: extract traceparent from inbound HTTP headers, span per route. recon-worker + event-processor: span per batch/job with component attribute.
4. rust/ledger-bridge: wrap TigerBeetle ops in spans `tigerbeetle.<op>` same semantics as Coder A.
5. Since cargo cannot run: keep code minimal; NO new workspace members; pin exact versions as above. Document in report that `cargo build` at image build time resolves sums (verify each crate's Dockerfile runs cargo build/fetch; state findings).
Report: per-crate status table + file list.

## Coder C — Node + Python gaps
Owns: server/kafka.ts, services/temporal-workflows/**, services/mojaloop/fspiop_adapter.ts, services/ml-stack/**, package.json + both lockfiles (SANCTIONED only for the deps below), simulation journeys J223–J226.
Sanctioned manifest additions (EXACT pins): @opentelemetry/instrumentation-kafkajs 0.18.0, @opentelemetry/instrumentation-ioredis 0.57.0, @opentelemetry/instrumentation-pg 0.60.0 (verify compat with installed sdk-node 0.221.0; if peer range excludes, drop that entry and document — never force). Update BOTH lockfiles via npm install --package-lock-only and pnpm equivalent, offline flags as needed; if a lockfile cannot be regenerated offline, leave it and document honestly.
1. server/kafka.ts: register kafkajs instrumentation in telemetry.ts's instrumentations list (banner edit, guarded by OTEL_ENABLED) AND add manual producer/consumer spans `kafka.produce` / `kafka.consume` with messaging.system=kafka, messaging.destination, tenant.id from message payload/header when present; inject/extract traceparent in Kafka message headers (W3C) so Rust fluvio-consumer (Coder B) can continue traces. Coordinate header key name: `traceparent` (lowercase string) — BINDING for A/B/C.
2. Temporal: services/temporal-workflows/worker.ts — add OpenTelemetry interceptors. If @temporalio/interceptors-opentelemetry cannot be added without lockfile churn, implement MANUAL interceptors (WorkflowInboundCallsInterceptor/WorkerInterceptors minimal) that start spans `temporal.workflow.<name>` / `temporal.activity.<name>` and propagate traceparent via workflow headers (existing headers API). Fail-open. Document approach chosen.
3. Mojaloop adapter: spans `mojaloop.prepare|fulfil|quote` around each FSPIOP call with peer.service=mojaloop, reuse W34 injectTraceHeaders.
4. Python ml-stack: services/ml-stack/lakehouse/pipeline.py, pipeline/lakehouse.py, inference/server.py, monitoring/drift_detector.py, monitoring/ab_testing.py — mirror W34 python pattern: lazy `from opentelemetry import trace`, fail-open init reading OTEL_ENABLED/OTEL_EXPORTER_OTLP_ENDPOINT, spans `lakehouse.pipeline.run`, `ml.inference`, `ml.drift.check`, `ml.ab.evaluate`; traceparent extraction from inbound headers on inference server. py_compile all touched files. requirements: add opentelemetry-sdk==1.37.0, opentelemetry-exporter-otlp-proto-http==1.37.0 to the ml-stack requirements file ONLY if one exists there; else document.
5. Journeys (append-only, lazy-import pattern like W34):
   - J223 kafka traceparent header injection/extraction round-trip (unit-level via exported helpers, mock producer).
   - J224 temporal interceptor fail-open + span naming (mock workflow context).
   - J225 mojaloop spans + trace headers (mock fetch).
   - J226 ml-stack python telemetry module imports + fail-open (exec via python3 if available in sim env; if not, static-source assertions like W34 python journeys did — mirror that pattern).
Report: dependency diff summary, per-item status, journey results.

## Coder D — Infra receivers, dashboards, alerts + mig 0116
Owns: deploy/otel/**, k8s/otel-stack.yaml, k8s/monitoring/**, env.example.txt banner, drizzle migration 0116 (SANCTIONED, additive), server/routers/infra.ts (banner append), J227–J230.
1. Collector (deploy/otel/collector-config.yaml, banner-preserving edits): add receivers — prometheus scrape jobs for keycloak (/metrics on management port 9000), apisix (prometheus plugin endpoint), permify, opensearch (prometheus-exporter), temporal (SDK metrics endpoint if Coder C exposes one — coordinate via OTEL_TEMPORAL_METRICS_PORT, else skip+document); add opensearch logs receiver ONLY if trivially supported by contrib distro already used (check image tag in k8s/otel-stack.yaml; if not contrib, document skip). Add spanmetrics/connectors untouched. Keep W34 tail-sampling intact.
2. APISIX: k8s manifests — enable otel + prometheus plugins in apisix config (banner block), tracing to otel-collector:4318. If APISIX config lives elsewhere, find it; if absent, add config/apisix/standalone yaml — additive.
3. Dapr: services/dapr/config.yaml — enable tracing: otlp endpoint otel-collector:4317 (grpc) or 4318 (http) matching collector receivers; sampling 1.0 in dev overlay comment. Additive banner edits.
4. OpenAppSec: document + add collector filelog receiver snippet (commented-active per distro support) forwarding openappsec logs as OTel logs; honest comment if unsupported by the pinned collector image.
5. Keycloak: k8s/keycloak manifests — ensure --metrics-enabled=true env (KC_METRICS_ENABLED=true) + service monitor/scrape annotation; additive banner.
6. Grafana: 2 new dashboards (Go Services RED, Rust Services RED) + extend Tenant 360 with kafka/temporal panels; alert-rules.yml: add rules for go/rust service down (up==0 5m), kafka consumer lag exporter absent → honest comment, temporal workflow failures rate, tigerbeetle op error rate. Wire new alert severities into alertmanager.yml routes (reuse W34 WA bridge).
7. infra.ts infraHealth probes: add probes for otel-collector, jaeger, prometheus, grafana, alertmanager (HTTP, timeout-guarded, honest down status), banner `=== W35 otel-stack probes ===`; extend 15-component list honestly.
8. Mig 0116 `telemetry_component_status` (tenant_id nullable, component text, status text, checked_at, payload jsonb) — additive, hand-written SQL + journal entry (follow 0115 pattern, prevId chain).
9. Journeys J227 collector-config yaml parses + required receivers present (js-yaml already in deps — verify, else static string assertions); J228 alert rules yaml valid + new rule names present; J229 mig 0116 applies in PGlite + table queryable; J230 infra probes return honest down when stack absent (mock fetch fail).
Report: per-component wiring table (scraped/traced/logs/skipped+why), migration + journey results.

## Merger (reuse warm coder)
- Order: A → B → C → D. Resolve seams: kafka `traceparent` header contract, temporal metrics port env, telemetry.ts banner conflicts (append, don't overwrite), env.example.txt merges (keep ALL sides), infra.ts probe list merge, simulation.test.ts journey count = 230 after J223–J230 (verify actual count of journey files, set count accordingly, never blindly).
- Full gate: tsc 0 (NODE_OPTIONS=--max-old-space-size=6144), vitest full run 0 failures, simulation journeys N/N, authz scanner green, paymentConfirm pin md5 intact, lockfile diff = only Coder C sanctioned entries, env.example.txt no conflict markers, no empty files (git show HEAD:<f> | wc -c for all new files).
- PGlite sim must pass with OTEL_ENABLED unset (default disabled) — fail-open proof.
- Report to /mnt/agents/output/w35/REPORT.md + merged tree to /mnt/agents/output/w35/merged-tree.
