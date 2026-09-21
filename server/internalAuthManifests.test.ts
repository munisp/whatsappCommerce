/**
 * QA-038: the shared service-to-service secret is wired the same way on every party to a protected call.
 *
 * ledger-bridge, recon-worker and commerce-engine require X-Internal-Api-Key once INTERNAL_API_KEY is set on THEM;
 * server, recon-worker and event-processor send it. The failure modes worth pinning are quiet ones:
 *  - a caller that isn't given the key: it works today (the callee isn't enforcing yet) and breaks the moment the
 *    callee is flipped on;
 *  - a callee and its callers reading the secret from different places, so "the same secret" silently isn't;
 *  - `optional: true`, so a deleted Secret starts the pod UNAUTHENTICATED instead of stopping it;
 *  - the secret leaking into the tb-adapter sidecar, which has no need of it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";

type Obj = Record<string, any>;
const ROOT = join(__dirname, "..");
const deployment = (name: string) =>
  (loadAll(readFileSync(join(ROOT, `k8s-flux/${name}-deployment.yaml`), "utf8")) as Obj[]).find((d) => d?.kind === "Deployment")!;
const container = (dep: Obj, name: string) => (dep.spec.template.spec.containers as Obj[]).find((c) => c.name === name)!;
const keyEnv = (c: Obj) => (c.env as Obj[] | undefined)?.find((e) => e.name === "INTERNAL_API_KEY");

const SECRET = { name: "whatsapp-server-internal-api-key", key: "INTERNAL_API_KEY" };

// [deployment, main container, why it needs the key]
const PARTIES: Array<[string, string, string]> = [
  ["ledger-bridge", "ledger-bridge", "callee: requires it on every route except /health(/ready)"],
  ["recon-worker", "recon-worker", "callee of server (/recon/*) and caller of the bridge (/ledger/void)"],
  ["commerce-engine", "commerce-engine", "callee: its handlers trust an X-Tenant-ID header"],
  ["server", "server", "caller of the bridge and of recon-worker"],
  ["event-processor", "event-processor", "caller of commerce-engine (only) — dead code today, wired for when a consumer exists"],
];

describe.each(PARTIES)("%s / %s — %s", (dep, cont) => {
  const env = keyEnv(container(deployment(dep), cont));

  it("gets INTERNAL_API_KEY from the shared Secret", () => {
    expect(env, `${dep} has no INTERNAL_API_KEY`).toBeDefined();
    expect(env.valueFrom?.secretKeyRef).toMatchObject(SECRET);
    expect(env.value, "must come from the Secret, never an inline literal").toBeUndefined();
  });

  it("is NOT optional — a missing Secret must stop the pod, not start it unauthenticated", () => {
    expect(env.valueFrom.secretKeyRef.optional).not.toBe(true);
  });
});

describe("least privilege", () => {
  it("the tb-adapter sidecar does not get the secret (loopback-only; only the bridge talks to it)", () => {
    expect(keyEnv(container(deployment("ledger-bridge"), "tb-adapter"))).toBeUndefined();
  });
});

describe("every Deployment configured to call a protected service has the key", () => {
  const files = readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8").match(/[\w-]+-deployment\.yaml/g) ?? [];
  const protectedTargets = ["ledger-bridge", "commerce-engine", "recon-worker"];

  it("derives callers from env URLs and requires each to be wired (server reaches the BRIDGE via an in-code default no manifest mentions, but it does set RECON_WORKER_URL, so it is found here too)", () => {
    const callers = new Set<string>();
    for (const f of new Set(files)) {
      const d = (loadAll(readFileSync(join(ROOT, "k8s-flux", f), "utf8")) as Obj[]).find((x) => x?.kind === "Deployment")!;
      const self = d.spec.template.metadata.labels["app.kubernetes.io/name"] as string;
      for (const c of d.spec.template.spec.containers as Obj[]) {
        const points = (c.env ?? []).some((e: Obj) => protectedTargets.some((t) => t !== self && new RegExp(`//${t}[.:/]`).test(String(e.value ?? ""))));
        if (points) {
          callers.add(self);
          expect(keyEnv(c), `${self} is configured to call a protected service but is not given INTERNAL_API_KEY`).toBeDefined();
        }
      }
    }
    // not vacuous: the callers we know are configured are the ones found
    expect([...callers].sort()).toEqual(["event-processor", "recon-worker", "server"]);
  });
});
