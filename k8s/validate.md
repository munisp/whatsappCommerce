<!-- === W54 CILIUM === -->
# Validation playbook

## Static validation (runs in this sandbox / CI, no cluster)

```bash
# 1. YAML syntax + schema sanity (committed script, python stdlib + pyyaml)
python3 k8s/validate_yaml.py
```

Checks performed by `k8s/validate_yaml.py`:
- every file under `k8s/base/` and `k8s/cilium/` parses as multi-doc YAML;
- every document has `apiVersion`, `kind`, `metadata.name`;
- core-v1/apps-v1 kinds used are in the known set (Deployment, StatefulSet,
  Service, PVC, Namespace, ConfigMap, ExternalSecret, CiliumNetworkPolicy,
  CiliumClusterwideNetworkPolicy, CiliumL2AnnouncementPolicy,
  CiliumLoadBalancerIPPool);
- every `CiliumNetworkPolicy` spec uses only known field names
  (`endpointSelector`, `ingress`, `egress`, `description`) and rule-level
  fields (`fromEndpoints`, `toEndpoints`, `fromEntities`, `toEntities`,
  `toPorts`, `toFQDNs`, `toCIDR`), with `rules.http` entries carrying
  `method`/`path`;
- Deployments carry resource requests+limits and a non-root securityContext.

```bash
# 2. If kubeconform / cilium CLI are available (not installed here — offline):
kubeconform -strict -skip CiliumNetworkPolicy,CiliumClusterwideNetworkPolicy,ExternalSecret k8s/base/*.yaml
cilium network policy validate k8s/cilium/network-policies.yaml   # dry-run parse
kubectl apply --dry-run=server -f k8s/                            # needs a cluster
```

## Runtime verification (requires a cluster — NONE in this sandbox)

Honest statement: nothing below was executed during authoring; expected
outcomes are documented for the first cluster run.

1. `cilium status --wait` → all controllers healthy, `KubeProxyReplacement: True`,
   `Encryption: Wireguard` showing keys per node.
2. `cilium connectivity test` → all ~30 scenarios PASS **before** applying the
   zero-trust policies (the test namespace is unaffected by namespace-scoped
   policies). Key scenarios: pod-to-pod, pod-to-service, DNS, egress-to-world.
3. After `kubectl apply -f k8s/cilium/network-policies.yaml` **in audit mode**:
   `hubble observe -n whatsapp-commerce --verdict AUDIT -f` should show a
   short burst (missed edges) then silence once policies cover the real
   traffic graph; any persistent AUDIT line = a policy gap to fix.
4. After enforce mode: `cilium connectivity test` still passes; platform
   smoke (journey J178 scheduler cadence, webhook round-trip with a mock Meta
   payload) succeeds; `hubble observe --verdict DROPPED` shows only noise
   (scanners), never platform flows.
5. WireGuard: `cilium encrypt status` → all nodes listed, no errors;
   `tcpdump -i cilium_wg0` on a node shows UDP 51871 between nodes.
6. Negative test: `kubectl exec deploy/kyc-verifier -- curl -m2
   http://payment-orchestrator:8084/health` → **connection timeout** (policy
   denied), and the flow appears in Hubble as `DROPPED (policy denied)`.

## Known limitations

- L7 `rules.http` requires the traffic to be plaintext HTTP at the pod; if
  TLS is terminated inside the server pod, path policy won't match — keep TLS
  termination at ingress/LB.
- `toFQDNs` policies require the DNS proxy (allow-dns policy includes the
  `rules.dns` stanza — already present).
- ExternalName (`fluvio-sc`, Ollama) egress can't be endpoint-labeled; the
  fluvio policy is port-scoped only — tighten with `toCIDR` once cloud egress
  IPs are known.
<!-- === END W54 CILIUM === -->
