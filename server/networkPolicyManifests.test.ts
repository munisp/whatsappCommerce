/**
 * QA-026 / QA-038: the ingress allowlists for ledger-bridge, commerce-engine and recon-worker, pinned so a "tidy-up"
 * cannot quietly reopen them and so a NEW caller cannot be added without the allowlist being updated with it.
 *
 * Failure modes these guard against (each one is silent in production):
 *  - a policy whose selector matches no pod protects nothing and looks fine in review;
 *  - an allow-from of `{}` / an ipBlock / a bare namespace turns "allowlist" into "everyone";
 *  - a Deployment gets pointed at one of these services and is then blocked at 3am, or never noticed;
 *  - adding `Egress` to policyTypes with no egress rules would cut the pod off from DNS, Postgres and TigerBeetle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";

type Obj = Record<string, any>;
const ROOT = join(__dirname, "..");
const load = (p: string) => (loadAll(readFileSync(join(ROOT, p), "utf8")) as Obj[]).filter(Boolean);
const policies = load("k8s-flux/network-policies.yaml").filter((d) => d.kind === "NetworkPolicy");
const byName = (n: string) => policies.find((p) => p.metadata.name === n)!;
const deployment = (f: string) => load(`k8s-flux/${f}`).find((d) => d.kind === "Deployment")!;
const NAME_LABEL = "app.kubernetes.io/name";

/** What each protected service is called by, as (same-namespace pod names, other namespaces) — the pinned decision. */
const EXPECTED = {
  "ledger-bridge-ingress": { target: "ledger-bridge", file: "ledger-bridge", port: 8095, pods: ["recon-worker", "server"], namespaces: [] },
  "commerce-engine-ingress": { target: "commerce-engine", file: "commerce-engine", port: 8083, pods: ["event-processor"], namespaces: [] },
  "recon-worker-ingress": { target: "recon-worker", file: "recon-worker", port: 8096, pods: ["server"], namespaces: [] },
} as const;

describe("network policies exist for the three services that trust the network", () => {
  it("has exactly these policies", () => {
    expect(policies.map((p) => p.metadata.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const p of policies) expect(p.metadata.namespace).toBe("whatsapp-commerce");
  });
});

describe.each(Object.entries(EXPECTED))("%s", (name, want) => {
  const p = byName(name);
  const rules = p.spec.ingress as Obj[];

  it("selects the REAL pods: its podSelector matches the labels on the Deployment's pod template (a selector that matches nothing protects nothing)", () => {
    const podLabels = deployment(`${want.file}-deployment.yaml`).spec.template.metadata.labels as Record<string, string>;
    const sel = p.spec.podSelector.matchLabels as Record<string, string>;
    expect(Object.keys(sel).length).toBeGreaterThan(0); // never `podSelector: {}` — that selects every pod in the namespace
    for (const [k, v] of Object.entries(sel)) expect(podLabels[k], k).toBe(v);
    expect(sel[NAME_LABEL]).toBe(want.target);
  });

  it("is ingress-only — adding Egress with no rules would cut the pod off from DNS, Postgres and TigerBeetle", () => {
    expect(p.spec.policyTypes).toEqual(["Ingress"]);
    expect(p.spec.egress).toBeUndefined();
  });

  it("allows only the pinned callers: named same-namespace pods plus the named namespaces — never `{}`, an ipBlock, or 'all namespaces'", () => {
    const pods: string[] = [], namespaces: string[] = [];
    for (const rule of rules) {
      for (const from of rule.from as Obj[]) {
        expect(from.ipBlock, "ipBlock would allow by address, not identity").toBeUndefined();
        if (from.namespaceSelector) {
          const ns = from.namespaceSelector.matchLabels?.["kubernetes.io/metadata.name"];
          expect(ns, "a namespaceSelector must name ONE namespace").toBeTruthy();
          expect(from.podSelector, "namespace-wide allows must be a deliberate, separately-pinned decision").toBeUndefined();
          namespaces.push(ns);
        } else {
          const n = from.podSelector?.matchLabels?.[NAME_LABEL];
          expect(n, "a podSelector must name a specific app").toBeTruthy();
          pods.push(n);
        }
      }
    }
    expect(pods.sort()).toEqual([...want.pods].sort());
    expect(namespaces.sort()).toEqual([...want.namespaces].sort());
  });

  it("allows only the service's own port, and it is the port the Service actually targets", () => {
    for (const rule of rules) expect((rule.ports as Obj[]).map((x) => x.port)).toEqual([want.port]);
    const svc = load(`k8s-flux/${want.file}-service.yaml`).find((d) => d.kind === "Service")!;
    expect((svc.spec.ports as Obj[]).map((x) => x.targetPort)).toContain(want.port);
  });
});

describe("a Deployment that is configured to call one of these services is on its allowlist", () => {
  // Callers configured through ENV in this repo's manifests. (server reaches ledger-bridge through the in-code default
  // http://ledger-bridge:8095, which no manifest mentions — it is pinned in EXPECTED above instead.)
  const files = readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8").match(/[\w-]+-deployment\.yaml/g) ?? [];
  const configured: Record<string, Set<string>> = { "ledger-bridge": new Set(), "commerce-engine": new Set(), "recon-worker": new Set() };
  for (const f of new Set(files)) {
    const d = deployment(f);
    const self = d.spec.template.metadata.labels[NAME_LABEL] as string;
    for (const c of d.spec.template.spec.containers as Obj[]) {
      for (const e of (c.env ?? []) as Obj[]) {
        const v = String(e.value ?? "");
        for (const target of Object.keys(configured)) if (self !== target && new RegExp(`//${target}[.:/]`).test(v)) configured[target].add(self);
      }
    }
  }

  it.each(Object.entries(EXPECTED))("%s", (name, want) => {
    for (const caller of configured[want.target]) expect(want.pods as readonly string[], `${caller} is configured to call ${want.target} but is not allowed to`).toContain(caller);
  });

  it("is not vacuous: it does find the callers we know are configured (event-processor -> commerce-engine, recon-worker -> ledger-bridge, server -> recon-worker)", () => {
    expect([...configured["commerce-engine"]]).toEqual(["event-processor"]);
    expect([...configured["ledger-bridge"]]).toContain("recon-worker");
    expect([...configured["recon-worker"]]).toContain("server");
  });
});

describe("wiring", () => {
  it("is part of the app's Kustomization, so a Flux resume keeps the protection", () => {
    expect(readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8")).toMatch(/network-policies\.yaml/);
  });
});
