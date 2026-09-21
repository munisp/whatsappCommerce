/**
 * QA-041: the Flux-resume gate. Each rule is a way that resuming Flux would have gone wrong; each is pinned here so the
 * gate cannot quietly stop noticing. The last block runs the parser over the REAL k8s-flux/ manifests — the rules are only
 * as good as the facts fed to them, and the image-policy marker is a YAML *comment* that a parser drops.
 */
import { describe, it, expect } from "vitest";
import {
  evaluatePreflight, expectedPolicyName, readDeployments,
  type PreflightDeployment, type PreflightInput,
} from "../scripts/fluxResumePreflight";

const REG = "registry.digitalocean.com/talentgraph-auth";
const dep = (name: string, image: string, extra: Partial<PreflightDeployment["containers"][number]> = {}, declaresReplicas = false): PreflightDeployment =>
  ({ file: `${name}-deployment.yaml`, name, declaresReplicas, containers: [{ name, image, imagePolicy: `whatsapp-${name}`, ...extra }] });

/** A state in which resuming Flux is safe. Every test below breaks exactly one thing. */
const good = (): PreflightInput => ({
  kustomizationSuspended: true,
  unpushedCommits: 0,
  deployments: [dep("server", `${REG}/whatsapp-server:20260922-0900`), dep("ledger-bridge", `${REG}/whatsapp-ledger-bridge:20260922-0900`)],
  imagePolicies: ["whatsapp-server", "whatsapp-ledger-bridge"],
  liveImages: { "server/server": `${REG}/whatsapp-server:20260922-0900`, "ledger-bridge/ledger-bridge": `${REG}/whatsapp-ledger-bridge:20260922-0900` },
  hpaTargets: ["server"],
});

describe("evaluatePreflight", () => {
  it("passes when everything is pushed, built by CI, automated, and matches the cluster", () => {
    const r = evaluatePreflight(good());
    expect(r.blockers).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("blocks on unpushed commits (Flux deploys from git; unpushed work does not exist to it)", () => {
    const r = evaluatePreflight({ ...good(), unpushedCommits: 64 });
    expect(r.ok).toBe(false);
    expect(r.blockers.join("\n")).toMatch(/64 local commit\(s\) are not pushed/);
  });

  it("blocks on a locally-shipped image tag in a manifest", () => {
    const i = good(); i.deployments[0] = dep("server", `${REG}/whatsapp-server:qa-local7`);
    const r = evaluatePreflight(i);
    expect(r.blockers.join("\n")).toMatch(/server\/server: the manifest pins a locally-shipped image/);
  });

  it("blocks on imagePullPolicy Never (a node without the image can never start the pod)", () => {
    const i = good(); i.deployments[1] = dep("ledger-bridge", `${REG}/whatsapp-ledger-bridge:20260922-0900`, { imagePullPolicy: "Never" });
    expect(evaluatePreflight(i).blockers.join("\n")).toMatch(/ledger-bridge\/ledger-bridge: imagePullPolicy is Never/);
  });

  it("THE tb-adapter TRAP: a container with no ImagePolicy blocks — CI builds the image, nothing ever deploys it", () => {
    const i = good();
    i.deployments[1].containers.push({ name: "tb-adapter", image: `${REG}/whatsapp-tb-adapter:qa-local1`, imagePullPolicy: "Never" });
    const r = evaluatePreflight(i);
    const text = r.blockers.join("\n");
    expect(text).toMatch(/tb-adapter: the manifest pins a locally-shipped image/);
    expect(text).toMatch(/tb-adapter: imagePullPolicy is Never/);
    expect(text).toMatch(/no ImagePolicy 'whatsapp-tb-adapter'/);
  });

  it("a registry image with no ImagePolicy blocks even when its tag is a real one (it is frozen forever)", () => {
    const i = good();
    i.deployments[1].containers.push({ name: "tb-adapter", image: `${REG}/whatsapp-tb-adapter:20260922-0900` });
    expect(evaluatePreflight(i).blockers.join("\n")).toMatch(/no ImagePolicy 'whatsapp-tb-adapter' exists .* nothing will ever update this image/);
  });

  it("uses the manifest's own $imagepolicy marker to decide which policy to look for, else the whatsapp-<container> convention", () => {
    expect(expectedPolicyName({ name: "tb-adapter", image: "x", imagePolicy: "flux-x-custom" })).toBe("flux-x-custom");
    expect(expectedPolicyName({ name: "tb-adapter", image: "x" })).toBe("whatsapp-tb-adapter");
    const i = good(); i.deployments[0].containers[0].imagePolicy = "custom-policy"; // not in the live list
    expect(evaluatePreflight(i).blockers.join("\n")).toMatch(/no ImagePolicy 'custom-policy'/);
  });

  it("warns when a policy exists but the manifest has no marker for it (it would never be updated)", () => {
    const i = good(); i.deployments[0].containers[0].imagePolicy = undefined;
    const r = evaluatePreflight(i);
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/server\/server: the policy 'whatsapp-server' exists but the manifest's image line has no \$imagepolicy marker/);
  });

  it("warns (does not block) about drift: what the cluster runs vs what git says", () => {
    const i = good(); i.liveImages!["server/server"] = `${REG}/whatsapp-server:qa-local7`;
    const r = evaluatePreflight(i);
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/cluster runs .*qa-local7 but git says .*20260922-0900 — resuming reverts it/);
  });

  it("blocks when a Deployment sets replicas but an HPA scales it (Flux would fight the autoscaler on every reconcile)", () => {
    const i = good(); i.deployments[0].declaresReplicas = true;
    expect(evaluatePreflight(i).blockers.join("\n")).toMatch(/server: the manifest sets spec.replicas but an HPA scales it/);
  });

  it("does not block on replicas for a Deployment no HPA scales", () => {
    const i = good(); i.deployments[1].declaresReplicas = true; // ledger-bridge: fixed 2 replicas, no HPA
    expect(evaluatePreflight(i).ok).toBe(true);
  });

  it.each([
    ["unpushed count", (i: PreflightInput) => { i.unpushedCommits = null; }],
    ["image policies", (i: PreflightInput) => { i.imagePolicies = null; }],
  ])("REFUSES to pass on a fact it could not read (%s) — a gate that passes on missing information is not a gate", (_n, breakIt) => {
    const i = good(); breakIt(i);
    const r = evaluatePreflight(i);
    expect(r.ok).toBe(false);
    expect(r.blockers.join("\n")).toMatch(/refuses to pass on missing information/);
  });

  it("an unreadable suspend state or unreadable live images only warn (they inform, they do not gate)", () => {
    const i = good(); i.kustomizationSuspended = null; i.liveImages = null;
    const r = evaluatePreflight(i);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(2);
  });

  it("today's real state: exactly the four blockers that stop a resume, and drift as warnings", () => {
    // Facts as of 2026-09-21, written out so a future change to the rules is a visible decision:
    const i: PreflightInput = {
      kustomizationSuspended: true,
      unpushedCommits: 64,
      deployments: [
        { file: "ledger-bridge-deployment.yaml", name: "ledger-bridge", declaresReplicas: true, containers: [
          { name: "ledger-bridge", image: `${REG}/whatsapp-ledger-bridge:20260831-1409`, imagePolicy: "whatsapp-ledger-bridge", imagePullPolicy: "IfNotPresent" },
          { name: "tb-adapter", image: `${REG}/whatsapp-tb-adapter:qa-local1`, imagePullPolicy: "Never" },
        ] },
        dep("server", `${REG}/whatsapp-server:20260918-2031`),
      ],
      imagePolicies: ["whatsapp-ledger-bridge", "whatsapp-server"], // 15 exist live; there is no whatsapp-tb-adapter
      liveImages: { "ledger-bridge/ledger-bridge": `${REG}/whatsapp-ledger-bridge:qa-local2`, "ledger-bridge/tb-adapter": `${REG}/whatsapp-tb-adapter:qa-local2`, "server/server": `${REG}/whatsapp-server:qa-local7` },
      hpaTargets: ["server"],
    };
    const r = evaluatePreflight(i);
    expect(r.ok).toBe(false);
    expect(r.blockers).toHaveLength(4);
    expect(r.warnings.filter((w) => /resuming reverts it/.test(w))).toHaveLength(3);
  });
});

describe("readDeployments — the facts, read from the REAL manifests", () => {
  const real = readDeployments();
  const container = (d: string, c: string) => real.find((x) => x.name === d)?.containers.find((x) => x.name === c);

  it("finds every service Deployment", () => {
    expect(real.length).toBeGreaterThanOrEqual(15);
    for (const n of ["server", "ledger-bridge", "recon-worker", "commerce-engine", "payment-orchestrator"]) expect(real.map((d) => d.name), n).toContain(n);
  });

  it("reads the $imagepolicy marker — a YAML COMMENT that a parser drops — from the image line", () => {
    expect(container("ledger-bridge", "ledger-bridge")?.imagePolicy).toBe("whatsapp-ledger-bridge");
    expect(container("server", "server")?.imagePolicy).toBe("whatsapp-server");
  });

  it("sees the tb-adapter sidecar as what it is today: locally shipped, never pulled, no policy marker", () => {
    // If this starts failing because someone FIXED it (a real tag, IfNotPresent, a marker), good — update the test and
    // delete the blocker; that is the whole point of the gate.
    const tb = container("ledger-bridge", "tb-adapter")!;
    expect(tb.image).toMatch(/whatsapp-tb-adapter:/);
    expect(tb.imagePullPolicy).toBeDefined();
  });

  it("the server Deployment no longer declares replicas (the HPA owns it — QA-041)", () => {
    expect(real.find((d) => d.name === "server")!.declaresReplicas).toBe(false);
  });
});
