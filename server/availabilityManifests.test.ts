/**
 * QA-034: the single points of failure that were closed on the live cluster, pinned so a "tidy-up" cannot
 * quietly reopen them.
 *
 * TigerBeetle itself is NOT here: it is a cluster-wide SHARED instance (ns `tigerbeetle`), also used by
 * `lanai` and `vpp` — not ours to reformat into a multi-replica cluster unilaterally, since TigerBeetle's
 * replica count is fixed at format time for every replica (including replica 0), so growing it destroys
 * whatever is already on it for every tenant, not just us. See docs/RESILIENCE.md "Multi-node TigerBeetle
 * deployment notes". This file only pins the parts that ARE ours to decide:
 *  - the server's old 512Mi limit was below the 613-800 MiB it measured under load;
 *  - a PodDisruptionBudget whose selector matches nothing protects nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";

type Obj = Record<string, any>;
const ROOT = join(__dirname, "..");
const load = (p: string) => (loadAll(readFileSync(join(ROOT, p), "utf8")) as Obj[]).filter(Boolean);
const pdbs = load("k8s-flux/availability/pdb.yaml").filter((d) => d.kind === "PodDisruptionBudget");
const server = load("k8s-flux/server-deployment.yaml").find((d) => d.kind === "Deployment")!;
const bridge = load("k8s-flux/ledger-bridge-deployment.yaml").find((d) => d.kind === "Deployment")!;
const hpa = load("k8s-flux/server-hpa.yaml").find((d) => d.kind === "HorizontalPodAutoscaler")!;
const adapter = bridge.spec.template.spec.containers.find((c: Obj) => c.name === "tb-adapter");
const adapterEnv = (n: string) => adapter.env.find((e: Obj) => e.name === n)?.value as string;
const toBytes = (q: string) => Number(q.replace(/[A-Za-z]+$/, "")) * ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 } as Record<string, number>)[q.replace(/^[0-9.]+/, "")];

describe("stateless single points of failure (QA-034)", () => {
  it("server: a floor of 2+ replicas (owned by the HPA — see the HPA tests below), zero-unavailable rollouts, spread over nodes", () => {
    expect(hpa.spec.minReplicas).toBeGreaterThanOrEqual(2);
    expect(server.spec.strategy.rollingUpdate.maxUnavailable).toBe(0);
    expect(server.spec.template.spec.topologySpreadConstraints[0].topologyKey).toBe("kubernetes.io/hostname");
  });

  it("server: a memory limit above the 800 MiB it was measured using under load (512Mi would OOM it when busiest), and a request that reflects reality", () => {
    const r = server.spec.template.spec.containers[0].resources;
    expect(toBytes(r.limits.memory)).toBeGreaterThanOrEqual(1024 ** 3);
    expect(toBytes(r.requests.memory)).toBeGreaterThanOrEqual(256 * 1024 ** 2);
    expect(toBytes(r.requests.memory)).toBeLessThanOrEqual(toBytes(r.limits.memory));
  });

  it("bridge: 2+ replicas spread over nodes", () => {
    expect(bridge.spec.replicas).toBeGreaterThanOrEqual(2);
    expect(bridge.spec.template.spec.topologySpreadConstraints[0].topologyKey).toBe("kubernetes.io/hostname");
  });

  it.each([["server", server], ["ledger-bridge", bridge]] as const)("%s has a PodDisruptionBudget whose selector matches its pods", (name, dep) => {
    const pdb = pdbs.find((p) => p.metadata.name === name)!;
    expect(pdb, `no PDB for ${name}`).toBeDefined();
    expect(pdb.spec.minAvailable).toBe(1);
    const podLabels = dep.spec.template.metadata.labels as Record<string, string>;
    for (const [k, v] of Object.entries(pdb.spec.selector.matchLabels as Record<string, string>)) expect(podLabels[k], `${k}`).toBe(v);
  });

  it("the stateless pieces (PDBs) are part of the app's Kustomization, so a Flux resume keeps them", () => {
    const k = readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8");
    expect(k).toMatch(/availability\/pdb\.yaml/);
  });

  it("the bridge sidecar points at the SHARED TigerBeetle (now 3 replicas, reformatted 2026-09-21), by hostname, not a dedicated cluster", () => {
    expect(adapterEnv("TB_CLUSTER_ID")).toBe("145851240909969808468846706535455565498");
    expect(adapterEnv("TB_ADDRESSES")).toBe(
      "tigerbeetle-0.tigerbeetle-headless.tigerbeetle.svc.cluster.local:3000,"
      + "tigerbeetle-1.tigerbeetle-headless.tigerbeetle.svc.cluster.local:3000,"
      + "tigerbeetle-2.tigerbeetle-headless.tigerbeetle.svc.cluster.local:3000",
    );
  });

  it("knows all THREE replica addresses, not just replica 0 — a client with only one address has no fallback if that specific replica goes down (verified live: primary-kill under load = zero failed writes, with all three known; a single-address client loses connectivity entirely if ITS ONE known replica is the one that goes down)", () => {
    expect(adapterEnv("TB_ADDRESSES").split(",")).toHaveLength(3);
  });
});

// QA-041: the HorizontalPodAutoscaler. The two ways this goes wrong are quiet: an HPA that points at nothing (it looks
// fine, scales nothing), and a Deployment that still carries `replicas:` (Flux re-applies it and drags the count back
// down in the middle of a burst).
describe("server autoscaling (QA-041)", () => {
  it("targets the server Deployment by its real name", () => {
    expect(hpa.spec.scaleTargetRef).toMatchObject({ apiVersion: "apps/v1", kind: "Deployment", name: server.metadata.name });
    expect(hpa.metadata.namespace).toBe(server.metadata.namespace);
  });

  it("the Deployment does NOT set replicas — the HPA owns it, so Flux cannot fight the autoscaler on every reconcile", () => {
    expect(server.spec.replicas, "remove `replicas:` from server-deployment.yaml; the floor is the HPA's minReplicas").toBeUndefined();
  });

  it("scales between a floor that keeps the PDB meaningful and a ceiling that leaves room to scale", () => {
    expect(hpa.spec.minReplicas).toBeGreaterThanOrEqual(2); // a PDB with minAvailable 1 protects nothing at 1 pod
    expect(hpa.spec.maxReplicas).toBeGreaterThan(hpa.spec.minReplicas);
  });

  it("targets an absolute per-pod CPU average, not a Utilization % of a deliberately small request", () => {
    const cpu = (hpa.spec.metrics as Obj[]).find((m) => m.resource?.name === "cpu")!;
    expect(cpu.resource.target.type, "Utilization is relative to the 200m REQUEST: 70% would be 140m and the HPA would pin at max").toBe("AverageValue");
    const target = Number(String(cpu.resource.target.averageValue).replace(/m$/, ""));
    const limit = Number(String(server.spec.template.spec.containers[0].resources.limits.cpu).replace(/m$/, "")) * (String(server.spec.template.spec.containers[0].resources.limits.cpu).endsWith("m") ? 1 : 1000);
    expect(target).toBeLessThan(limit); // scale out BEFORE the pod is throttled at its limit
    expect(target).toBeGreaterThan(0.3 * limit); // ...but not so early that idle noise scales it
  });

  it("does not flap: scale-down is slower than scale-up", () => {
    const b = hpa.spec.behavior;
    expect(b.scaleDown.stabilizationWindowSeconds).toBeGreaterThan(b.scaleUp.stabilizationWindowSeconds);
  });

  it("is part of the app's Kustomization, so a Flux resume keeps it", () => {
    expect(readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8")).toMatch(/server-hpa\.yaml/);
  });
});

// QA-042: terminating a ledger-bridge pod must not fail payments. Measured before the fix: deleting ONE of two healthy
// replicas gave 150 failed reserves in exactly 30 s (the grace period) — the bridge ignored SIGTERM (fixed in Rust, pinned in
// rust/ledger-bridge's tests) while its Node sidecar exited at once. The manifest half of the fix is the ordering.
describe("ledger-bridge termination ordering (QA-042)", () => {
  const main = bridge.spec.template.spec.containers.find((c: Obj) => c.name === "ledger-bridge");
  const sleepOf = (c: Obj) => {
    const cmd = c.lifecycle?.preStop?.exec?.command as string[] | undefined;
    expect(cmd?.[0], `${c.name} needs a preStop sleep`).toBe("sleep");
    return Number(cmd![1]);
  };

  it("both containers have a preStop sleep", () => {
    expect(sleepOf(main)).toBeGreaterThan(0);
    expect(sleepOf(adapter)).toBeGreaterThan(0);
  });

  it("the ADAPTER outlives the bridge: it must still be there while the bridge drains", () => {
    expect(sleepOf(adapter)).toBeGreaterThan(sleepOf(main));
  });

  it("the bridge keeps serving long enough for the Service to stop sending it new connections (>= 3 s)", () => {
    expect(sleepOf(main)).toBeGreaterThanOrEqual(3);
  });

  it("everything fits inside terminationGracePeriodSeconds with room for the shutdown itself (else SIGKILL cuts the drain)", () => {
    const grace = bridge.spec.template.spec.terminationGracePeriodSeconds as number;
    expect(sleepOf(adapter) + 8).toBeLessThanOrEqual(grace);
  });
});
