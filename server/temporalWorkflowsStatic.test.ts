/**
 * Always-on static guards for services/temporal-workflows (the full behavioral suite,
 * server/temporalWorkflows.test.ts, is opt-in because it downloads a Temporal test server).
 *
 * These catch the mistakes that only bite at runtime inside the worker:
 *  - a non-deterministic / Node-only import in workflows.ts (fails at worker STARTUP, in prod),
 *  - a workflow name the server starts that no workflow defines (queues forever),
 *  - a worker that can silently idle instead of failing loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const workflowsSrc = read("services/temporal-workflows/workflows.ts");
const workerSrc = read("services/temporal-workflows/worker.ts");

/** Strip comments so prose that mentions `fetch` or `process.env` doesn't trip the scans. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("workflows.ts runs inside Temporal's deterministic sandbox", () => {
  it("imports only the workflow SDK, pure sibling modules, and TYPE-only activities", () => {
    const imports = [...code(workflowsSrc).matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => ({
      typeOnly: !!m[1],
      from: m[2],
    }));
    expect(imports.length).toBeGreaterThan(3);
    const allowed = new Set(["@temporalio/workflow", "./types", "./versions", "./failureTypes"]);
    for (const imp of imports) {
      if (imp.from === "./activities") {
        // A runtime import would drag @temporalio/activity (and fetch/process) into the sandbox bundle.
        expect(imp.typeOnly, "./activities must be `import type`").toBe(true);
      } else {
        expect(allowed.has(imp.from), `workflows.ts must not import "${imp.from}"`).toBe(true);
      }
    }
  });

  it("uses no Node/network/timer APIs that the sandbox forbids or that break determinism", () => {
    const src = code(workflowsSrc);
    for (const [label, re] of [
      ["fetch", /\bfetch\s*\(/],
      ["process.*", /\bprocess\./],
      ["require()", /\brequire\s*\(/],
      ["node: import", /["']node:/],
      ["setTimeout", /\bsetTimeout\s*\(/],
      ["setInterval", /\bsetInterval\s*\(/],
      ["Math.random", /Math\.random\s*\(/],
    ] as const) {
      expect(re.test(src), `workflows.ts must not use ${label}`).toBe(false);
    }
  });

  it("the sibling modules workflows.ts imports are themselves sandbox-pure", () => {
    for (const f of ["versions.ts", "failureTypes.ts", "types.ts"]) {
      const src = code(read(`services/temporal-workflows/${f}`));
      expect(/\bprocess\.|["']node:|\bfetch\s*\(|from\s+"@temporalio\/activity"/.test(src), `${f} must stay pure`).toBe(false);
    }
  });
});

describe("workflow names line up with what the server starts", () => {
  const defined = [...workflowsSrc.matchAll(/export async function (\w+Workflow)\b/g)].map((m) => m[1]);

  it("defines the five platform workflows", () => {
    expect(defined.sort()).toEqual([
      "BroadcastCampaignWorkflow",
      "InventorySyncWorkflow",
      "JourneyOrchestrationWorkflow",
      "OrderFulfillmentWorkflow",
      "TenantOnboardingWorkflow",
    ]);
  });

  it("every workflow server/temporal.ts starts by name is defined here (else it would queue forever)", () => {
    const started = [...read("server/temporal.ts").matchAll(/startWorkflow\(\s*"(\w+)"/g)].map((m) => m[1]);
    expect(started.length).toBeGreaterThan(0);
    for (const name of started) expect(defined, `${name} is started by the server but not defined`).toContain(name);
  });

  it("the journey orchestrator's workflow type is a workflow the worker actually defines", () => {
    const orchestrator = read("server/services/journeyOrchestrator.ts").match(/ORCHESTRATION_WORKFLOW_TYPE\s*=\s*"(\w+)"/)?.[1];
    expect(orchestrator).toBe("JourneyOrchestrationWorkflow");
    expect(defined).toContain(orchestrator);
  });

  it("documents the workflow types the server can start that NO worker defines (they must stay off)", () => {
    // The payment saga has no spec and touches money, so it is deliberately not implemented; it is
    // why TEMPORAL_ENABLED_WORKFLOWS defaults to none. If it gains a real workflow, move it out of
    // this list; if another such type appears, add it here on purpose.
    expect(defined).not.toContain("paymentSagaWorkflow");
  });
});

describe("worker.ts fails loudly instead of idling", () => {
  it("requires its connection settings and refuses to start without them", () => {
    for (const name of ["TEMPORAL_ADDRESS", "PLATFORM_API_URL", "PLATFORM_INTERNAL_TOKEN"]) {
      expect(workerSrc).toContain(`required("${name}")`);
    }
  });

  it("has no 'simulation mode' fallback that keeps a broken worker looking healthy", () => {
    expect(/simulation mode|setInterval\(/i.test(code(workerSrc))).toBe(false);
  });

  it("reports health honestly: 503 unless the worker is RUNNING", () => {
    expect(workerSrc).toContain('worker.getState()');
    expect(workerSrc).toMatch(/state === "RUNNING" \? 200 : 503/);
  });

  it("only starts when executed directly, so importing it (tests) never boots a worker", () => {
    expect(workerSrc).toMatch(/fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/);
  });
});
