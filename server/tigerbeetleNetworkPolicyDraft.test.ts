/**
 * QA-041: the drafted (NOT applied) TigerBeetle-namespace allowlist in docs/handoff/. It is not deployed, so nothing else
 * would ever notice it rotting or being edited into something that allows everyone. Same shape rules as the applied
 * policies (server/networkPolicyManifests.test.ts): no `{}`, no ipBlock, namespace-scoped clients always pod-scoped too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";

const raw = readFileSync(join(__dirname, "..", "docs/handoff/tigerbeetle-namespace-networkpolicy.yaml"), "utf8");
const policy = (loadAll(raw) as any[]).find((d) => d?.kind === "NetworkPolicy");
const froms = policy.spec.ingress.flatMap((r: any) => r.from) as any[];
const named = (f: any) => `${f.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] ?? "(same ns)"}/${Object.values(f.podSelector?.matchLabels ?? {})[0]}`;

describe("drafted TigerBeetle ingress allowlist", () => {
  it("is honest that it is a draft, and says what evidence and decision it rests on", () => {
    expect(raw).toMatch(/DRAFT — NOT APPLIED/);
    expect(raw).toMatch(/ROLLBACK/);
    expect(raw).toMatch(/NodePort 32001/);
  });

  it("selects the replicas — a selector matching nothing protects nothing", () => {
    expect(policy.spec.podSelector.matchLabels).toEqual({ app: "tigerbeetle" });
    expect(policy.metadata.namespace).toBe("tigerbeetle");
  });

  it("is ingress-only (an Egress type with no rules would cut replicas off from each other and from DNS)", () => {
    expect(policy.spec.policyTypes).toEqual(["Ingress"]);
    expect(policy.spec.egress).toBeUndefined();
  });

  it("allows only TCP 3000", () => {
    for (const rule of policy.spec.ingress) expect(rule.ports).toEqual([{ protocol: "TCP", port: 3000 }]);
  });

  it("never allows everyone: no `{}`, no ipBlock, every client is pod-scoped, and a cross-namespace client is namespace-scoped too", () => {
    for (const f of froms) {
      expect(f, "an empty `from` entry allows everything").not.toEqual({});
      expect(f.ipBlock).toBeUndefined();
      expect(f.podSelector?.matchLabels, `${JSON.stringify(f)} must name a specific app`).toBeTruthy();
      if (f.namespaceSelector) expect(f.namespaceSelector.matchLabels?.["kubernetes.io/metadata.name"], "one named namespace").toBeTruthy();
    }
  });

  it("allows exactly the clients the evidence supports (replicas, the TLS proxy, our bridge, and the configured lanai/vpp consumers)", () => {
    expect(froms.map(named).sort()).toEqual([
      "(same ns)/tigerbeetle",
      "(same ns)/tigerbeetle-stunnel",
      "lanai/lanai-portal",
      "vpp/vpp-orchestrator",
      "vpp/vpp-server",
      "whatsapp-commerce/ledger-bridge",
    ]);
  });

  it("our bridge's selector matches the labels the ledger-bridge Deployment really puts on its pods", () => {
    const dep = (loadAll(readFileSync(join(__dirname, "..", "k8s-flux/ledger-bridge-deployment.yaml"), "utf8")) as any[]).find((d) => d?.kind === "Deployment");
    const ours = froms.find((f) => f.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "whatsapp-commerce");
    for (const [k, v] of Object.entries(ours.podSelector.matchLabels)) expect(dep.spec.template.metadata.labels[k], k).toBe(v);
  });

  it("does NOT allow gds-gateway until its use of this TigerBeetle is confirmed (it is commented out, not active)", () => {
    expect(froms.map(named)).not.toContain("gds/gds-gateway");
    expect(raw).toMatch(/gds-gateway: UNCONFIRMED/);
  });
});
