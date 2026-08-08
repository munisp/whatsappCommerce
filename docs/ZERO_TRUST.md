# Zero-Trust Isolation Model — whatsapp-commerce

This document summarizes the network-isolation, workload-hardening and
observability model implemented in `k8s/`, **with the code evidence each
decision is based on** (verified at main HEAD `e7d6337`).

## 1. Network isolation

**Baseline:** `k8s/network-policy.yaml` applies *default-deny ingress+egress*
to every pod in the namespace. The previous `allow-platform-internal` policy
(any pod → any pod, any port) was removed — it nullified the default-deny.

**Allows:** `k8s/network-policies.yaml` is strictly least-privilege. A flow is
only possible when the source has an egress allow AND the destination has an
ingress allow. External entry is limited to `ingress-nginx → apisix:9080`
(and optionally `→ api-gateway:8080`); every Service is `ClusterIP` and the
single `Ingress` (`k8s/ingress.yaml`) targets APISIX only. DNS egress goes to
`kube-system:53` only.

### Flow matrix (evidence)

| Source → Destination : port | Evidence |
| --- | --- |
| ingress-nginx → apisix : 9080 | `k8s/ingress.yaml`; APISIX `node_listen: 9080` (`services/middleware/apisix_conf/config.yaml`) |
| apisix → api-gateway : 8080 | only configured route: `/api/* → api-gateway:8080` (`services/middleware/apisix_conf/apisix.yaml`) |
| api-gateway → commerce-engine : 8083 | `COMMERCE_ENGINE_URL` (compose env, `k8s/configmap.yaml`) |
| api-gateway → ml-inference : 8099 | `ML_STACK_URL` (compose env); `api.POST("/ml/predict", proxy.ForwardTo(cfg.Services.MLStack))` in `services/gateway/cmd/main.go` |
| api-gateway → ledger-bridge : 8095 | `LEDGER_BRIDGE_URL` (`k8s/configmap.yaml`) |
| api-gateway → redis/keycloak/permify/temporal/apisix-admin/ai-agent/platform | compose `api-gateway` env (`REDIS_URL`, `KEYCLOAK_URL`, `PERMIFY_URL`, `TEMPORAL_ADDRESS`, `APISIX_ADMIN_URL`, `AI_AGENT_URL`) |
| platform → postgres : 5432 / redis : 6379 | `server/db.ts`, `server/redis.ts`; `DATABASE_URL`/`REDIS_URL` |
| platform → keycloak : 8080 / temporal : 7233 / permify : 3476,3478 | `server/mlops.reconciliation.keycloak.test.ts`, `server/temporal.ts`, `server/permify.ts` |
| platform → kafka(ns) : 9092 | `KAFKA_BROKERS` (`k8s/configmap.yaml`, `server/kafka.ts`) |
| platform → 443 (Meta Graph API, payment providers) | WhatsApp/Paystack integrations (`server/_core/index.ts` webhooks + outbound calls) |
| commerce-engine → postgres/redis/temporal/platform | compose env + `services/commerce-engine/internal/temporal/client.go` (pings `/api/health/temporal`) |
| ledger-bridge → tigerbeetle : 3000 / postgres : 5432 | `rust/ledger-bridge/src/main.rs` (`TIGERBEETLE_ADDRESS`, `DATABASE_URL`) |
| recon-worker → postgres / ledger-bridge : 8095 / platform : 3000 | `rust/recon-worker/src/main.rs` (queries `payment_intents`; calls `/health`, `/balance/:id`, `/ledger/void`; reports to `/api/internal/events`) |
| ml-inference → postgres / platform : 3000 | `services/ml-stack/inference/server.py` (lakehouse persistence; `/recommend` → `/api/trpc/products.list`) |
| ai-agent → redis / commerce-engine : 8083 / 443 (LLM APIs) | compose `ai-agent` env |
| temporal → temporal-db : 5432 | `POSTGRES_SEEDS=temporal-db` (`k8s/temporal-deployment.yaml`, compose) |
| keycloak → keycloak-db : 5432 | `KC_DB_URL` (compose, `k8s/keycloak.yaml`) |
| permify → permify-db : 5432 | `PERMIFY_DATABASE_URI` (`k8s/permify-deployment.yaml`, compose) |
| temporal-worker → temporal/postgres/redis/platform | `services/temporal-workflows/worker.ts` env contract |
| hermes-router → kafka(ns) : 9092 / redis / 443 (Hermes cloud) | `rust/hermes-router/src/main.rs` config |
| monitoring(ns) → apisix : 9091, hermes-router : 8096 | Prometheus scrape (`allow-prometheus-scrape`) |

**Most-restricted workloads:** `tigerbeetle` (ingress only from
`ledger-bridge`, *no* egress — not even DNS) and the three databases
`temporal-db` / `keycloak-db` / `permify-db` (ingress only from their owning
service, no egress beyond DNS).

## 2. Workload hardening (securityContext)

Every Deployment now sets, at both pod and container level:
`runAsNonRoot`, `readOnlyRootFilesystem` (with `emptyDir` mounts for `/tmp`
and other writable paths), `allowPrivilegeEscalation: false`,
`capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, and CPU/memory
requests+limits. Notes/exceptions:

| Workload | Note |
| --- | --- |
| First-party images (`whatsapp-commerce/*`) | run as uid 10001. **Action for image builds:** ensure Dockerfiles `USER 10001` (or any non-root uid) — currently the manifests enforce it pod-side. |
| postgres / redis | official uid/gid (70 / 999); extra `emptyDir` for `/var/run/postgresql`, `/data`, `/tmp`; `PGDATA` subdir set. |
| keycloak | uid 1000; `emptyDir` for `/opt/keycloak/data` + `/tmp`. |
| temporal (`auto-setup`) | upstream image runs as the non-root `temporal` user — verify on first deploy (`kubectl exec ... id`). |
| permify | pinned `v1.2.4` (was `:latest`); verify non-root user on first deploy. |
| **apisix** | **EXCEPTION:** the official `apache/apisix` image runs the OpenResty master as root, so `runAsNonRoot` is *not* set. All other controls applied; data-plane ports are unprivileged (>1024) and capabilities are dropped. Revisit with the `apache/apisix:debian`-based non-root variants. |
| tigerbeetle | static binary, uid 10001; `Recreate` strategy; init container formats the data file (idempotent-guarded) — mirrors compose `tigerbeetle-init`. |

**Images pinned** (no `:latest`): see `docs/RUNBOOK_ROLLBACK.md` §3.

## 3. Health checks (all probe paths cross-checked against source)

| Service | Probe | Evidence |
| --- | --- | --- |
| api-gateway | readiness `GET /ready:8080`, liveness `GET /health:8080` | `services/gateway/cmd/main.go:144` (`/health`), `:159` (`/ready`). **Fixed:** the old manifest probed `/healthz`, which the gateway does not serve — the probes were broken. |
| platform | readiness `GET /api/health/postgres:3000`, liveness `GET /api/health:3000` | `server/_core/index.ts:2069` (postgres), `:2082` (redis), `:2093` (tigerbeetle); `/api/health` asserted 200 in `tests/integration/full_suite.test.ts` |
| commerce-engine | `GET /health:8083` | `services/commerce-engine/cmd/main.go:33` |
| ml-inference (ml-stack) | `GET /health:8099` | `services/ml-stack/inference/server.py:320` |
| ledger-bridge | `GET /health:8095` | `rust/ledger-bridge/src/main.rs` route table (~L747) |
| recon-worker | `GET /health:8096` | `rust/recon-worker/src/main.rs:307` |
| ai-agent | `GET /health:8090` | `ai-agent/api/main.py` (`@app.get("/health")`) |
| hermes-router | `GET /health:8096` | `rust/hermes-router/src/main.rs` route table |
| temporal | tcpSocket :7233 | gRPC frontend; no HTTP health on 7233 |
| **temporal-worker** | **none — honest gap** | `services/temporal-workflows/worker.ts` exposes **no HTTP endpoint** (pure gRPC poller). No probe is invented; liveness relies on process exit + restart. Consider adding a tiny `/healthz` listener. |
| tigerbeetle | tcpSocket :3000 | binary protocol, no HTTP; deep health via ledger-bridge `/health` (`tigerbeetle.healthy`) and platform `/api/health/tigerbeetle` |
| permify | `GET /healthz:3476` | compose healthcheck curls `:3476/healthz` |
| keycloak | readiness `GET /health/ready:8080`, liveness `GET /health/live:8080` | `KC_HEALTH_ENABLED=true` (compose) |
| postgres / *-db | `pg_isready` exec | compose healthchecks |
| redis | `redis-cli ping` exec | compose healthcheck |
| apisix | readiness `GET /apisix/prometheus/metrics:9091`, liveness tcpSocket :9080 | prometheus plugin export (`plugin_attr` in apisix config) |

## 4. Observability — honest metrics inventory

Scrapeable **Prometheus-text** endpoints that exist in code today:

* **apisix** — `:9091 /apisix/prometheus/metrics` (prometheus plugin).
* **hermes-router** — `:8096 /metrics` exporting
  `hermes_router_events_routed_total`, `hermes_router_events_failed_total`,
  `hermes_router_events_dlq_total` (`rust/hermes-router/src/main.rs`
  `handle_metrics`). Deployed in `k8s/hermes-router.yaml` so the DLQ alerts
  have a real target.

**Not scrapeable / missing (documented, not invented):**

* `event-processor` — `:8091 /metrics` returns **JSON** (`processed_total`,
  `error_total`), not Prometheus text.
* `hermes-skills` — has `/metrics` (`ai-agent/hermes_skills/app.py`) but is not
  deployed in k8s.
* api-gateway, commerce-engine, platform, ml-inference, ledger-bridge,
  recon-worker, ai-agent — **no `/metrics` endpoint exists in code**.
* Webhook DLQ depth — the DLQ is the Postgres table `wa_webhook_events`
  (status `dead`/`failed`; `server/routers/webhookDlq.ts`,
  `server/_core/index.ts` DLQ insert). Needs an exporter before a
  `webhook_failures_total`-style alert can exist.
* `ledger_pending_transfers_old` — recon-worker detects/repairs orphans but
  reports only via JSON `/health` + `/api/internal/events`.

Alert rules shipped (`k8s/monitoring/prometheus-rules.yaml`) therefore cover:
fraud/event DLQ growth (`increase(hermes_router_events_dlq_total[15m]) > 0`,
adapted from the insurance platform's `sar_dead_letter_queue`), delivery
failure rate (adapted `consumer_errors_total`), edge HTTP 5xx ratio, edge p95
latency, scrape-target-down, pod restarts, CrashLoopBackOff, and unavailable
deployments. The gaps above are listed as ACTION comments in the same file.

Grafana (`k8s/monitoring/grafana-dashboards.yaml`) ships a platform-overview
dashboard: request rate, p95 latency, DLQ/delivery, pod restarts (real data),
plus escrow settlement rate / wallet withdrawal failures / ML predict latency
panels explicitly marked *pending instrumentation*.

## 5. Validation

* `kubectl` was not available in the authoring environment; every YAML under
  `k8s/` was parsed with `yaml.safe_load_all` and a scripted cross-check
  verified probe paths/ports, securityContext coverage, image pinning, and
  every NetworkPolicy label selector against the deployment manifests and the
  code evidence above. All checks pass.
* With a cluster: `kubectl apply --dry-run=server -f k8s/` (or
  `kubectl kustomize k8s/`) then `kubectl apply -f k8s/ && kubectl apply -f k8s/monitoring/`.
* `k8s/monitoring/` requires Prometheus Operator CRDs (`ServiceMonitor`,
  `PrometheusRule`) and a Prometheus whose `serviceMonitorSelector` matches
  `release: prometheus`.
