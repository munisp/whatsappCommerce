<!-- === W54 CILIUM === -->
# Kubernetes + Cilium/eBPF production path

Additive artifacts for moving the whatsapp-commerce platform from
docker-compose to Kubernetes with **Cilium as CNI**. Nothing here changes
existing compose behavior; earlier-wave manifests in `k8s/*.yaml` remain as-is
— the compose-faithful core stack is under `k8s/base/`, Cilium policy under
`k8s/cilium/`.

## Why Cilium for this platform

| Platform need | Cilium/eBPF answer |
|---|---|
| **Money rails isolation** (payment-orchestrator, ledger-bridge, TigerBeetle escrow) | `CiliumNetworkPolicy` default-deny + per-workload allow-lists enforced in the kernel; a compromised sidecar literally cannot open a socket to :8084 (`k8s/cilium/network-policies.yaml` §5) |
| **Webhook ingress control** (Meta/Telegram/Paystack/Flutterwave/Shopify/Shipbubble hit Express) | eBPF-accelerated L7 policy: internet (`fromEntities: world`) may reach **only** `/api/webhooks/*` + `/integrations/*` on server :3000 — verified against `server/_core/index.ts` route registrations (`/api/wa`, `/api/tg` do **not** exist) |
| **Sidecar mesh without a sidecar** (14+ Go/Rust/Python services) | No Envoy/Istio sidecars: policy, mTLS-less encryption and observability all in eBPF; pod latency and memory overhead unchanged |
| **Performance** (100k msg/day rails, Kafka/Redis fan-out) | No iptables conntrack chains; eBPF hash-map service lookup is O(1) and per-flow cost is flat at high service counts |
| **Encryption in transit** (PLAINTEXT kafka listeners, HTTP sidecars) | WireGuard **transparent encryption** encrypts all node-to-node pod traffic with zero app changes |
| **Observability** | Hubble flows → OTLP export → existing deploy/otel collector → Loki/Tempo/Grafana; `dns`, `drop`, `httpV2` metrics feed the existing Prometheus/Grafana stack |
| **DDoS / abuse** | eBPF XDP drop programs, L3/L4 policy at the earliest hook, Hubble drop visibility per-verdict |

## Layout

```
k8s/
  base/            # compose-faithful core stack (namespace, postgres, redis x2,
                   # kafka+zookeeper, temporal+db, fluvio ExternalName, server,
                   # python/go/rust sidecars, ExternalSecrets)
  cilium/          # network-policies.yaml, hubble.yaml, bgp-lb.yaml
  validate.md      # static + runtime validation playbook
```

## Install (bare-metal / kubeadm assumed)

```bash
# 1. Cilium as CNI with kube-proxy replacement (eBPF dataplane)
helm repo add cilium https://helm.cilium.io/
helm upgrade --install cilium cilium/cilium --version 1.16.x -n kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<API_SERVER_IP> --set k8sServicePort=6443 \
  --set hubble.enabled=true --set hubble.relay.enabled=true --set hubble.ui.enabled=true \
  --set encryption.enabled=true --set encryption.type=wireguard \
  --set l2announcements.enabled=true --set externalIPs.enabled=true
# (see k8s/cilium/hubble.yaml for the full metrics/flow-export values)

# 2. Verify dataplane
cilium status --wait
cilium connectivity test          # expected outcomes: k8s/validate.md §runtime

# 3. Stack
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -f k8s/base/                       # core + sidecars
kubectl apply -f k8s/cilium/bgp-lb.yaml          # L2 LB pool (bare metal)
kubectl apply -f k8s/cilium/network-policies.yaml  # AFTER audit pass (below)
```

**Policy rollout (do not skip):** apply policies annotated
`io.cilium.network-policy-mode=audit`, watch
`hubble observe -n whatsapp-commerce --verdict AUDIT -f` for a full traffic
cycle (≥24h incl. scheduler ticks), then remove the annotation to enforce.
Details in `k8s/cilium/network-policies.yaml` header and `hubble.yaml`.

## Secrets

No secrets are committed. `k8s/base/externalsecret.yaml` uses the
ExternalSecrets pattern (ClusterSecretStore → Vault/AWS SM/GCP SM);
SealedSecrets is a documented alternative. Map every key listed there before
`kubectl apply`.

## Migration path: compose → k8s

1. **Images** — build/push each compose context (repo-root `Dockerfile`,
   `services/*/Dockerfile`, `rust/*/Dockerfile`, `ai-agent/Dockerfile`) and
   replace `REPLACE_WITH_REGISTRY/*` tags in `k8s/base/`.
2. **Data** — postgres: `pg_dump` compose volume → restore into the new PV
   (or run both, replicate, cut over). Kafka: topics are pre-provisioned
   (auto-create OFF, PLT-24); recreate via the existing topic tooling.
   Redis: cache instance is disposable; **redis-durable is not** — it holds
   idempotency keys/approvals (PERF-SC-16); drain in-flight work before cut.
3. **DNS cutover** — compose names (`platform`, `postgres`, ...) are preserved
   as Service names, plus a `platform` alias Service for `server`, so app
   config needs no changes.
4. **Webhooks** — point Meta/Telegram/PSP dashboards at the new LB IP/host
   (`k8s/cilium/bgp-lb.yaml`); verification tokens come from ExternalSecrets.
5. **Fluvio** — compose deliberately has no Fluvio container; either
   `fluvio cluster start` in-cluster or keep InfinyOn Cloud via the
   ExternalName Service (`k8s/base/fluvio.yaml`).
6. **Decommission** — keep compose up (ports remapped) until
   `cilium connectivity test` + a journey smoke pass on k8s, then scale
   compose to zero.

## Honest limits

- Runtime verification needs a cluster — none exists in this sandbox. What
  IS validated here: YAML syntax, required-field schema sanity, Cilium field
  names. See `k8s/validate.md`.
- `REPLACE_WITH_*` markers are intentional configuration points, not stubs.
<!-- === END W54 CILIUM === -->
