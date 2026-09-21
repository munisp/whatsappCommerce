/**
 * QA-031: the ledger-bridge → tb-adapter → TigerBeetle wiring. Each assertion is a failure that
 * actually happened, or one that the design depends on:
 *  - the adapter is an unauthenticated endpoint that can write the ledger, so it must stay on
 *    loopback (there are no NetworkPolicies);
 *  - kubelet probes connect to the POD IP, so a loopback listener needs an exec probe — a
 *    tcpSocket probe was refused and restart-looped the container on the first rollout;
 *  - the TigerBeetle client needs io_uring, which the runtime-default seccomp profile blocks;
 *  - the bridge must never fall back to its non-durable in-memory ledger in a real environment;
 *  - CI built the deprecated services/ledger-bridge shim instead of the canonical bridge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";

type Obj = Record<string, any>;
const ROOT = join(__dirname, "..");
const dep = (loadAll(readFileSync(join(ROOT, "k8s-flux/ledger-bridge-deployment.yaml"), "utf8")) as Obj[]).find((d) => d?.kind === "Deployment")!;
const pod = dep.spec.template.spec;
const bridge = pod.containers.find((c: Obj) => c.name === "ledger-bridge");
const adapter = pod.containers.find((c: Obj) => c.name === "tb-adapter");
const env = (c: Obj, name: string) => c.env?.find((e: Obj) => e.name === name);

describe("ledger-bridge deployment (QA-031)", () => {
  it("is a two-container pod: the bridge and its TigerBeetle adapter sidecar", () => {
    expect(pod.containers.map((c: Obj) => c.name).sort()).toEqual(["ledger-bridge", "tb-adapter"]);
  });

  it("stays a single replica until multi-replica replay has been tested", () => {
    expect(dep.spec.replicas).toBe(1);
  });

  describe("bridge", () => {
    it("never falls back to the in-memory ledger (it fabricates results and is not durable)", () => {
      expect(env(bridge, "LEDGER_ALLOW_INMEMORY")?.value).toBe("false");
    });
    it("talks to the adapter over loopback on the port the adapter listens on", () => {
      const addr = env(bridge, "TIGERBEETLE_ADDRESS")?.value as string;
      expect(addr).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(addr.split(":")[1]).toBe(env(adapter, "PORT")?.value);
    });
    it("takes its database from the app's secret (so it follows the app if the database moves), never inline", () => {
      expect(env(bridge, "DATABASE_URL")?.valueFrom?.secretKeyRef).toEqual({ key: "DATABASE_URL", name: "whatsapp-postgres-dsn" });
      expect(env(bridge, "DATABASE_URL")?.value).toBeUndefined();
    });
    it("logs (a silent bridge makes a ledger incident undiagnosable)", () => {
      expect(env(bridge, "RUST_LOG")?.value).toBe("info");
    });
    it("keeps readiness on the shallow /health: a deep probe would pull the only replica out of its Service", () => {
      expect(bridge.readinessProbe.httpGet.path).toBe("/health");
    });
  });

  describe("tb-adapter sidecar", () => {
    it("listens on loopback only — it is unauthenticated and can write the ledger", () => {
      expect(env(adapter, "HOST")?.value).toBe("127.0.0.1");
      expect(adapter.ports).toBeUndefined(); // nothing is published on the pod IP
    });
    it("uses an exec liveness probe: kubelet probes hit the pod IP, which a loopback listener refuses", () => {
      expect(adapter.livenessProbe.exec).toBeDefined();
      expect(adapter.livenessProbe.tcpSocket).toBeUndefined();
      expect(adapter.livenessProbe.httpGet).toBeUndefined();
    });
    it("has NO readiness probe: a sidecar failing readiness would take the bridge out of its Service", () => {
      expect(adapter.readinessProbe).toBeUndefined();
    });
    it("declares seccomp Unconfined explicitly (io_uring), so RuntimeDefault later fails loudly instead of crash-looping", () => {
      expect(adapter.securityContext.seccompProfile).toEqual({ type: "Unconfined" });
    });
    it("is otherwise locked down: non-root, read-only rootfs, no privilege escalation, no capabilities", () => {
      const sc = adapter.securityContext;
      expect(sc.runAsNonRoot).toBe(true);
      expect(sc.runAsUser).toBeGreaterThan(0);
      expect(sc.readOnlyRootFilesystem).toBe(true);
      expect(sc.allowPrivilegeEscalation).toBe(false);
      expect(sc.capabilities.drop).toContain("ALL");
      expect(adapter.resources.limits.memory).toBeTruthy();
    });
    it("points at a real cluster: numeric u128 cluster id and host:port addresses", () => {
      expect(env(adapter, "TB_CLUSTER_ID")?.value).toMatch(/^\d+$/);
      for (const a of (env(adapter, "TB_ADDRESSES")?.value as string).split(",")) expect(a).toMatch(/^[^:]+:\d+$/);
    });
    it("carries no credential in its environment", () => {
      for (const e of adapter.env) expect(e.name).not.toMatch(/PASS|SECRET|TOKEN|KEY/i);
    });
    it("has a writable /tmp despite the read-only root filesystem", () => {
      expect(adapter.volumeMounts.some((m: Obj) => m.mountPath === "/tmp")).toBe(true);
      expect(pod.volumes.some((v: Obj) => v.name === adapter.volumeMounts[0].name && v.emptyDir)).toBe(true);
    });
  });
});

describe("CI builds the right ledger images (QA-031)", () => {
  const wf = readFileSync(join(ROOT, ".github/workflows/build-and-push.yml"), "utf8");
  it("builds the canonical rust/ledger-bridge, not the deprecated services/ledger-bridge shim", () => {
    expect(wf).toContain('[ledger-bridge]="rust/ledger-bridge/Dockerfile"');
    expect(wf).toContain('[ledger-bridge]="rust/ledger-bridge"');
    expect(wf).toContain('[ledger-bridge]="rust/ledger-bridge/"'); // so a change to the canonical bridge actually triggers a build
    expect(wf).not.toMatch(/\[ledger-bridge\]="services\/ledger-bridge/);
  });
  it("builds the tb-adapter image the deployment references", () => {
    expect(wf).toContain('[tb-adapter]="services/tb-adapter/Dockerfile"');
    expect(wf).toContain('[tb-adapter]="services/tb-adapter"');
    expect(wf).toContain('[tb-adapter]="services/tb-adapter/"');
    expect(adapter.image).toMatch(/\/whatsapp-tb-adapter:/);
  });
});

describe("tb-adapter image", () => {
  const df = readFileSync(join(ROOT, "services/tb-adapter/Dockerfile"), "utf8");
  it("runs as a non-root user and installs only production dependencies", () => {
    expect(df).toMatch(/^USER node$/m);
    expect(df).toMatch(/npm ci --omit=dev/);
  });
  it("does not default to listening on all interfaces", () => {
    expect(df).not.toMatch(/ENV\s+HOST\s*=?\s*0\.0\.0\.0/);
    expect(readFileSync(join(ROOT, "services/tb-adapter/server.mjs"), "utf8")).toMatch(/process\.env\.HOST \?\? "127\.0\.0\.1"/);
  });
});
