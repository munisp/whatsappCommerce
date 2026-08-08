# Runbook — Rollback & GitOps (whatsapp-commerce)

Scope: the `whatsapp-commerce` Kubernetes namespace (`k8s/`). For the alert
rules shipped in `k8s/monitoring/prometheus-rules.yaml`, see
[Alert response](#alert-response).

---

## 1. Application rollback — `kubectl rollout undo`

All workloads are `apps/v1` Deployments, so Kubernetes keeps revision history
and can roll back declaratively:

```bash
# 1. Identify the broken rollout
kubectl -n whatsapp-commerce rollout history deploy/<name>

# 2. Roll back to the previous revision
kubectl -n whatsapp-commerce rollout undo deploy/<name>

# 3. Roll back to a specific revision (from the history output)
kubectl -n whatsapp-commerce rollout undo deploy/<name> --to-revision=<N>

# 4. Watch the rollback converge
kubectl -n whatsapp-commerce rollout status deploy/<name> --timeout=180s
```

Deployment names: `apisix`, `api-gateway`, `platform`, `commerce-engine`,
`ai-agent`, `ml-inference`, `ledger-bridge`, `tigerbeetle`, `recon-worker`,
`temporal`, `temporal-worker`, `permify`, `permify-db`, `keycloak`,
`keycloak-db`, `postgres`, `redis`, `hermes-router`.

Caveats:

* **Stateful single replicas** (`postgres`, `redis`, `tigerbeetle`, `*-db`)
  use `strategy: Recreate` — a rollback briefly takes the dependency offline.
  Roll back dependents only after the data store is Ready again.
* **`tigerbeetle`** has an init container that formats the data file. Rolling
  back to a *different TigerBeetle version* can fail if the on-disk format
  changed; check the TigerBeetle release notes first. The init container
  skips `format` when `/data/0_0.tigerbeetle` already exists.
* **`HPA`** (`api-gateway-hpa`, `ai-agent-hpa`) will keep scaling during a
  rollback — that is expected and safe.
* Rollback restores the *pod spec*, not data. See §2 for the database policy.

## 2. Database migration rollback policy (drizzle) — FORWARD-FIX ONLY

Schema migrations are managed by **drizzle-kit** (`drizzle.config.ts`,
`drizzle/` migration folder, applied with `drizzle-kit migrate` against
`DATABASE_URL`).

**Policy: drizzle does not generate down-migrations, and this platform does
not attempt them.** Rolling `deploy/platform` back does **not** roll the
schema back, and a down-migration on a live financial schema
(`payment_intents`, escrow, wallet ledger tables) risks silent data loss.
Instead:

1. **Expand-migrate-contract.** Ship schema changes as additive
   (expand) → deploy code that tolerates both shapes → remove the old shape
   in a later release (contract). This keeps every intermediate state
   roll-forward *and* roll-back safe.
2. **Bad migration shipped?** Roll the code back (`rollout undo`) — additive
   schema stays harmless — then ship a **new forward migration** that repairs
   the damage. Never hand-edit applied migrations in `drizzle/`.
3. **Destructive change unavoidable** (column drop/type change): take a
   logical backup first —
   `kubectl -n whatsapp-commerce exec deploy/postgres -- pg_dump -U wc_user whatsapp_commerce > backup-$(date +%F).sql`
   — and rehearse the restore in staging. Restore is the only true "down".
4. Pre-deploy gate: generate migrations in CI (`drizzle-kit generate`),
   review the SQL, and apply with `drizzle-kit migrate` as a Job *before*
   flipping the Deployment image.

`permify` (PERMIFY_DATABASE_AUTO_MIGRATE=true) and `temporal`
(auto-setup) self-migrate on boot; rolling them back to an older version than
the schema was written by is **not supported** — restore their databases
(`permify-db`, `temporal-db`) alongside if you must downgrade.

## 3. GitOps / image-tag policy

* **No `:latest` anywhere.** Every image in `k8s/` is pinned
  (`whatsapp-commerce/*:v1.0.0`, `permify/permify:v1.2.4`,
  `temporalio/auto-setup:1.24.2`, `quay.io/keycloak/keycloak:24.0`,
  `apache/apisix:3.9.1`, `postgres:16-alpine`, `redis:7-alpine`,
  `ghcr.io/tigerbeetle/tigerbeetle:0.16.40`). The previous manifests used
  `:latest` for first-party and some third-party images; that made rollbacks
  non-deterministic (the tag can silently re-point). This was fixed in the
  `fix/verify-infra` branch.
* Releases: CI builds and pushes an immutable tag (`v1.x.y` or the commit
  SHA), then a GitOps PR bumps the tag in `k8s/`. Rollback = revert that PR
  **or** `rollout undo` (§1) — both converge to the same previous spec.
* Verify what is actually running before/after a rollback:

```bash
kubectl -n whatsapp-commerce get deploy -o \
  jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.template.spec.containers[*].image}{"\n"}{end}'
```

## 4. Config/secret rollback

`ConfigMap`/`Secret` changes are *not* covered by `rollout undo`. Version
them in git with the manifests (this repo) and re-apply the previous commit:

```bash
git revert <sha> -- k8s/configmap.yaml && kubectl apply -f k8s/configmap.yaml
kubectl -n whatsapp-commerce rollout restart deploy/<affected>
```

## Alert response

Quick mapping for the alerts in `k8s/monitoring/prometheus-rules.yaml`:

| Alert | First actions |
| --- | --- |
| `FraudCaseEventDLQGrowing` | `kubectl -n whatsapp-commerce exec deploy/hermes-router -- ls /tmp/hermes-dlq`; check `GET /health` circuit-breaker states; verify hermes-agent/hermes-skills reachability. Fraud (`fraud.alert`) events use this path — treat as fraud-pipeline degradation. |
| `EventDeliveryFailureRateHigh` | Same checks as above; confirm Kafka (`kafka` namespace) is healthy. |
| `EdgeHTTP5xxRateHigh` | `kubectl -n whatsapp-commerce logs deploy/apisix --tail=200`; then `api-gateway` and `platform` logs; check `DeploymentUnavailable`. |
| `EdgeP95LatencyHigh` | Check `postgres`/`redis` saturation and `ml-inference` CPU (it is the heaviest downstream). |
| `PodRestartingFrequently` / `PodCrashLoopBackOff` | `kubectl -n whatsapp-commerce describe pod <pod>`; verify `platform-secrets` keys exist (`POSTGRES_PASSWORD`, `PERMIFY_DB_PASSWORD`, `TEMPORAL_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `INTERNAL_API_KEY`). If a bad rollout, `rollout undo` (§1). |
| `DeploymentUnavailable` | Readiness probe failing — probe paths are code-verified in the manifests; check the dependency the readiness gate covers (e.g. `platform` readiness = Postgres). |
| `ScrapeTargetDown` | Pod down or NetworkPolicy blocking `monitoring` namespace — `allow-prometheus-scrape` in `k8s/network-policies.yaml` must permit :9091/:8096. |
