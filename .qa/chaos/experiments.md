# Chaos experiments (skill §26) — live dev cluster `kind-newwave-dev`, namespace `whatsapp-commerce`

Ground rules I held myself to: time-boxed, every injection has an explicit rollback that I run even if the observation fails, everything is scoped to **this namespace's workloads**, and probing runs **from the cluster host** (this laptop's network path adds a ~6.5 s TLS handshake to the public URL, which would swamp sub-second failure windows — the host reaches the same URL in 0.08 s). Availability is measured by `.qa/chaos/probe.mjs` (every request recorded; failure *windows* reported in seconds).

Deliberately **not** done, with reasons:
- **Node failure / drain / network partition / latency injection / CPU-memory pressure at node level** — the kind nodes are shared with many other projects' pods (421 pods cluster-wide), there are no NetworkPolicies to inject with, and `kubectl exec`/privileged tooling was blocked by the tool sandbox. I approximated node loss for *our* workloads only (CX-04).
- **DNS failure, disk pressure, expired-credential experiments** — no safe, namespace-scoped way to inject them here.

Results are filled in below as each experiment completes.
