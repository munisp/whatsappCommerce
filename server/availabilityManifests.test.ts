/**
 * QA-034: the single points of failure that were closed on the live cluster, pinned so a "tidy-up" cannot
 * quietly reopen them. Each assertion is either a failure that was observed or a property the design needs:
 *  - TigerBeetle 0.16 accepts ONLY IP addresses in --addresses, and a pod IP changes on restart, so each replica
 *    has its own Service with a static ClusterIP, and the adapter must be given exactly those addresses;
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
const tbDocs = load("k8s-flux/tigerbeetle/tigerbeetle-ha.yaml");
const sts = tbDocs.find((d) => d.kind === "StatefulSet")!;
const tbSvcs = tbDocs.filter((d) => d.kind === "Service" && d.spec.clusterIP && d.spec.clusterIP !== "None");
const tbContainer = sts.spec.template.spec.containers[0];
const tbEnv = (n: string) => tbContainer.env.find((e: Obj) => e.name === n)?.value as string;
const pdbs = load("k8s-flux/availability/pdb.yaml").filter((d) => d.kind === "PodDisruptionBudget");
const server = load("k8s-flux/server-deployment.yaml").find((d) => d.kind === "Deployment")!;
const bridge = load("k8s-flux/ledger-bridge-deployment.yaml").find((d) => d.kind === "Deployment")!;
const adapter = bridge.spec.template.spec.containers.find((c: Obj) => c.name === "tb-adapter");
const adapterEnv = (n: string) => adapter.env.find((e: Obj) => e.name === n)?.value as string;
const toBytes = (q: string) => Number(q.replace(/[A-Za-z]+$/, "")) * ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 } as Record<string, number>)[q.replace(/^[0-9.]+/, "")];

describe("TigerBeetle: a 3-replica cluster (QA-034)", () => {
  it("is 3 replicas that may start together, one per node, and a drain may take only one", () => {
    expect(sts.spec.replicas).toBe(3);
    expect(sts.spec.podManagementPolicy).toBe("Parallel");
    const aa = sts.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0];
    expect(aa.topologyKey).toBe("kubernetes.io/hostname");
    const pdb = tbDocs.find((d) => d.kind === "PodDisruptionBudget")!;
    expect(pdb.spec.maxUnavailable).toBe(1); // two down = no quorum
    expect(pdb.spec.selector.matchLabels).toEqual(sts.spec.selector.matchLabels);
  });

  it("gives EVERY replica its own Service with a STATIC ClusterIP, selecting exactly that pod", () => {
    expect(tbSvcs.map((s) => s.metadata.name).sort()).toEqual(["wa-tb-0", "wa-tb-1", "wa-tb-2"]);
    for (const [i, name] of ["wa-tb-0", "wa-tb-1", "wa-tb-2"].entries()) {
      const svc = tbSvcs.find((s) => s.metadata.name === name)!;
      expect(svc.spec.selector["statefulset.kubernetes.io/pod-name"]).toBe(`${sts.metadata.name}-${i}`);
      expect(svc.spec.clusterIP).toBe(tbEnv(`TB_IP_${i}`)); // the address the peers use IS the Service's IP
      expect(svc.spec.publishNotReadyAddresses).toBe(true);   // peers must reach a replica that is still starting
    }
    expect(new Set(tbSvcs.map((s) => s.spec.clusterIP)).size).toBe(3);
  });

  it("is configured with IP LITERALS only: TigerBeetle rejects a hostname in --addresses", () => {
    for (const i of [0, 1, 2]) expect(tbEnv(`TB_IP_${i}`), `TB_IP_${i}`).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
  });

  it("puts 0.0.0.0 in a replica's OWN slot (it cannot bind a ClusterIP that is not local) and the peers' IPs elsewhere", () => {
    const script = tbContainer.args[0] as string;
    expect(script).toContain('[ "$j" = "$ORD" ] && a="0.0.0.0:3000"');
    expect(script).toMatch(/--replica-count=3/);
    expect(script).toMatch(/--addresses="\$ADDRS"/);
  });

  it("formats to a temp file and renames, so a crash mid-format cannot leave a half-formatted file that 'exists'", () => {
    const script = tbContainer.args[0] as string;
    expect(script).toMatch(/format [^\n]*"\$FILE\.tmp"/);
    expect(script).toMatch(/mv "\$FILE\.tmp" "\$FILE"/);
  });

  it("has a fresh, non-zero cluster id (never the shared cluster's, never 0)", () => {
    expect(tbEnv("CLUSTER_ID")).toMatch(/^[1-9]\d{19,38}$/);
    expect(tbEnv("CLUSTER_ID")).not.toBe("145851240909969808468846706535455565498");
  });

  it("is in ITS OWN namespace, like Postgres — not the app namespace", () => {
    const ns = tbDocs.find((d) => d.kind === "Namespace")!;
    expect(ns.metadata.name).toBe("whatsapp-tigerbeetle");
    for (const d of tbDocs) if (d.kind !== "Namespace") expect(d.metadata.namespace, `${d.kind}/${d.metadata.name}`).toBe("whatsapp-tigerbeetle");
  });

  it("runs locked down, but with seccomp Unconfined explicitly (io_uring)", () => {
    const sc = tbContainer.securityContext;
    expect(sc.seccompProfile).toEqual({ type: "Unconfined" });
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities.drop).toContain("ALL");
  });

  it("has room for the ~1.06 GiB data file and memory for its ~1.5 GiB working set", () => {
    const pvc = sts.spec.volumeClaimTemplates[0].spec.resources.requests.storage as string;
    expect(toBytes(pvc)).toBeGreaterThanOrEqual(2 * 1024 ** 3);
    expect(toBytes(tbContainer.resources.limits.memory)).toBeGreaterThanOrEqual(2 * 1024 ** 3);
  });

  it("is the cluster the tb-adapter sidecar points at: same id, same three addresses", () => {
    expect(adapterEnv("TB_CLUSTER_ID")).toBe(tbEnv("CLUSTER_ID"));
    expect(adapterEnv("TB_ADDRESSES").split(",")).toEqual([0, 1, 2].map((i) => `${tbEnv(`TB_IP_${i}`)}:3000`));
  });
});

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

  it("TigerBeetle is deliberately NOT in the app's Kustomization — it owns a different namespace, applied separately (like postgres-oracle)", () => {
    const k = readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8");
    expect(k).not.toMatch(/tigerbeetle\/tigerbeetle-ha\.yaml/);
  });
});
