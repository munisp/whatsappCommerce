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
const adapter = bridge.spec.template.spec.containers.find((c: Obj) => c.name === "tb-adapter");
const adapterEnv = (n: string) => adapter.env.find((e: Obj) => e.name === n)?.value as string;
const toBytes = (q: string) => Number(q.replace(/[A-Za-z]+$/, "")) * ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 } as Record<string, number>)[q.replace(/^[0-9.]+/, "")];

describe("stateless single points of failure (QA-034)", () => {
  it("server: 2+ replicas, zero-unavailable rollouts, spread over nodes", () => {
    expect(server.spec.replicas).toBeGreaterThanOrEqual(2);
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
