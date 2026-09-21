/**
 * QA-041: a gate to run BEFORE resuming the Flux Kustomization `whatsapp-commerce`.
 *
 *   npx tsx scripts/fluxResumePreflight.ts            # human-readable, exit 1 if anything blocks the resume
 *   npx tsx scripts/fluxResumePreflight.ts --json
 *
 * Flux has been suspended since the QA pass while the cluster ran hand-shipped `qa-local*` images. "Just resume it" is the
 * obvious next step and would be wrong in several quiet ways; each rule below is a way that has already been found the hard
 * way (or nearly). The evaluator is a pure function so it is unit-tested against fixtures of today's real state
 * (server/fluxResumePreflight.test.ts); the CLI at the bottom only gathers facts (git, the repo's manifests, the cluster).
 *
 * READ-ONLY: it never applies, patches, resumes or pushes anything.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "js-yaml";

export interface PreflightContainer {
  name: string;
  image: string;
  imagePullPolicy?: string;
  /** From a `# {"$imagepolicy": "flux-system:<name>"}` marker on the image line, if there is one. */
  imagePolicy?: string;
}

export interface PreflightDeployment {
  file: string;
  name: string;
  containers: PreflightContainer[];
  /** True when the manifest sets spec.replicas. */
  declaresReplicas: boolean;
}

export interface PreflightInput {
  /** null = could not be read */
  kustomizationSuspended: boolean | null;
  /** Commits on the local branch that the remote does not have. null = could not be determined. */
  unpushedCommits: number | null;
  deployments: PreflightDeployment[];
  /** Names of ImagePolicy objects in flux-system. null = could not be read. */
  imagePolicies: string[] | null;
  /** "<deployment>/<container>" -> the image the cluster is running right now. null = could not be read. */
  liveImages: Record<string, string> | null;
  /** Names of Deployments that an HPA scales. */
  hpaTargets: string[];
}

export interface PreflightResult {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  info: string[];
}

const LOCAL_TAG = /:qa-local/;

/** Where Flux's image automation would look for a container's ImagePolicy: its marker, or the `whatsapp-<container>` convention. */
export function expectedPolicyName(c: PreflightContainer): string {
  return c.imagePolicy ?? `whatsapp-${c.name}`;
}

export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  if (input.kustomizationSuspended === false) info.push("The Kustomization is already resumed.");
  if (input.kustomizationSuspended === null) warnings.push("Could not read the Kustomization's suspend state.");

  // 1. Flux deploys from GIT. Anything not pushed does not exist to it.
  // A gate must not PASS on a fact it could not read: unknown blocks (a missing upstream also means nothing is pushed).
  if (input.unpushedCommits === null) blockers.push("Could not determine how many local commits are unpushed (no upstream configured?) — the gate refuses to pass on missing information.");
  else if (input.unpushedCommits > 0) {
    blockers.push(`${input.unpushedCommits} local commit(s) are not pushed. Flux deploys from git: resuming now deploys the OLD manifests and reverts every live change made since.`);
  }

  for (const d of input.deployments) {
    for (const c of d.containers) {
      const id = `${d.name}/${c.name}`;

      // 2. A locally-shipped tag in the repo is only meaningful on nodes that had it loaded by hand.
      if (LOCAL_TAG.test(c.image)) {
        blockers.push(`${id}: the manifest pins a locally-shipped image (${c.image}). Let CI build a real tag and let image automation write it, THEN resume.`);
      }
      // 3. `Never` means a node that lacks the image can never start the pod — after a node replacement, or after the
      //    tag is deleted from the nodes (which is exactly what happened to qa-local1).
      if (c.imagePullPolicy === "Never") {
        blockers.push(`${id}: imagePullPolicy is Never. A pod scheduled onto a node without the image fails with ErrImageNeverPull and never starts.`);
      }
      // 4. A registry image that nothing updates is a tag frozen forever, and the pod that runs it silently stops
      //    tracking the code. Found for tb-adapter: CI builds it, but there was never an ImagePolicy for it.
      if (input.imagePolicies !== null && !LOCAL_TAG.test(c.image) && !input.imagePolicies.includes(expectedPolicyName(c))) {
        blockers.push(`${id}: no ImagePolicy '${expectedPolicyName(c)}' exists in flux-system, so nothing will ever update this image.`);
      }
      // (a local tag with no policy is already blocked by rule 2; say the policy part too so the fix list is complete)
      if (input.imagePolicies !== null && LOCAL_TAG.test(c.image) && !input.imagePolicies.includes(expectedPolicyName(c))) {
        blockers.push(`${id}: no ImagePolicy '${expectedPolicyName(c)}' exists in flux-system — CI's tag would never be picked up even once it exists.`);
      }
      if (c.imagePolicy === undefined && input.imagePolicies !== null && input.imagePolicies.includes(expectedPolicyName(c))) {
        warnings.push(`${id}: the policy '${expectedPolicyName(c)}' exists but the manifest's image line has no $imagepolicy marker, so it will not be updated.`);
      }

      // 5. Drift: what the cluster runs vs what git says. Resuming makes them equal — by changing the cluster.
      const live = input.liveImages?.[id];
      if (live !== undefined && live !== c.image) {
        warnings.push(`${id}: the cluster runs ${live} but git says ${c.image} — resuming reverts it.`);
      }
    }

    // 6. Two writers of one field: Flux re-applies spec.replicas on every reconcile and drags an autoscaled Deployment back.
    if (d.declaresReplicas && input.hpaTargets.includes(d.name)) {
      blockers.push(`${d.name}: the manifest sets spec.replicas but an HPA scales it — Flux would fight the autoscaler on every reconcile.`);
    }
  }

  if (input.imagePolicies === null) blockers.push("Could not read ImagePolicies from flux-system, so nothing about image automation was checked — the gate refuses to pass on missing information.");
  if (input.liveImages === null) warnings.push("Could not read the live images; drift was not checked.");

  return { ok: blockers.length === 0, blockers, warnings, info };
}

// ── fact gathering (CLI only) ──────────────────────────────────────────────────────────────────────────────────

// import.meta.url, not __dirname: this file runs both as an ES module under tsx and inside vitest.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const KUBE = process.env.KUBE_CONTEXT ?? "kind-newwave-dev";
const NS = "whatsapp-commerce";

function tryRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  } catch {
    return null;
  }
}
const kube = (...args: string[]) => tryRun("kubectl", ["--context", KUBE, ...args]);

export function readDeployments(dir = join(ROOT, "k8s-flux")): PreflightDeployment[] {
  const out: PreflightDeployment[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith("-deployment.yaml")).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const dep = (loadAll(text) as any[]).find((d) => d?.kind === "Deployment");
    if (!dep) continue;
    const lines = text.split("\n");
    const containers: PreflightContainer[] = (dep.spec.template.spec.containers as any[]).map((c) => {
      // the marker is a trailing YAML comment on the image line, which the parser drops — read it from the text
      const line = lines.find((l) => l.includes("image:") && l.includes(c.image)) ?? "";
      const m = line.match(/"\$imagepolicy":\s*"flux-system:([^"]+)"/);
      return { name: c.name, image: c.image, imagePullPolicy: c.imagePullPolicy, imagePolicy: m?.[1] };
    });
    out.push({ file, name: dep.metadata.name, containers, declaresReplicas: dep.spec.replicas !== undefined });
  }
  return out;
}

export function gatherInput(): PreflightInput {
  const susp = kube("-n", "flux-system", "get", "kustomization", "whatsapp-commerce", "-o", "jsonpath={.spec.suspend}");
  const unpushed = tryRun("git", ["rev-list", "--count", "@{u}..HEAD"]);
  const pol = kube("-n", "flux-system", "get", "imagepolicy", "-o", "name");
  const dep = kube("-n", NS, "get", "deploy", "-o", "json");
  const hpa = kube("-n", NS, "get", "hpa", "-o", "json");

  let liveImages: Record<string, string> | null = null;
  if (dep) {
    liveImages = {};
    for (const d of JSON.parse(dep).items) for (const c of d.spec.template.spec.containers) liveImages[`${d.metadata.name}/${c.name}`] = c.image;
  }
  return {
    kustomizationSuspended: susp === null ? null : susp.trim() === "true",
    unpushedCommits: unpushed === null ? null : Number(unpushed.trim()),
    deployments: readDeployments(),
    imagePolicies: pol === null ? null : pol.split("\n").map((l) => l.replace(/^.*\//, "").trim()).filter(Boolean),
    liveImages,
    hpaTargets: hpa ? JSON.parse(hpa).items.map((h: any) => h.spec.scaleTargetRef.name) : [],
  };
}

function main() {
  const result = evaluatePreflight(gatherInput());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const section = (title: string, xs: string[]) => xs.length && console.log(`\n${title} (${xs.length})\n${xs.map((x) => `  - ${x}`).join("\n")}`);
    console.log(result.ok ? "SAFE TO RESUME FLUX: yes (no blockers)" : "SAFE TO RESUME FLUX: NO");
    section("BLOCKERS", result.blockers);
    section("WARNINGS", result.warnings);
    section("INFO", result.info);
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && /fluxResumePreflight\.ts$/.test(process.argv[1])) main();
