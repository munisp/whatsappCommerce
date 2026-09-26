/**
 * End-to-end: the REAL worker process (services/temporal-workflows/worker.ts run under tsx)
 * against a real Temporal dev server and a stand-in for the platform's tRPC API.
 *
 * This is the closest pre-deploy check of the artifact that actually ships: env handling,
 * workflow bundling under tsx, the health endpoint, and the activities' HTTP client speaking
 * the tRPC wire format with the internal token.
 *
 * OPT-IN like temporalWorkflows.test.ts:   npm run test:temporal
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";

const enabled = process.env.TEMPORAL_WORKFLOW_TESTS === "1";
const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "e2e-internal-token";

describe.skipIf(!enabled)("temporal worker process (e2e)", () => {
  let env: TestWorkflowEnvironment;
  let platform: Server;
  let platformUrl = "";
  const platformCalls: Array<{ path: string; token: string | undefined; body: any }> = [];
  const children: ChildProcess[] = [];
  let seq = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createLocal();

    // Stand-in for the platform: same tRPC/superjson envelope and the same 401 the real
    // internalProcedure gives for a bad token.
    platform = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const proc = (req.url ?? "").replace("/api/trpc/", "");
        const token = req.headers["x-internal-token"] as string | undefined;
        const body = raw ? JSON.parse(raw) : null;
        platformCalls.push({ path: proc, token, body });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (token !== TOKEN) return send(401, { error: { json: { message: "invalid-internal-api-key", code: -32001 } } });
        if (proc === "temporalInternal.listInventorySyncTenants") return send(200, { result: { data: { json: { tenantIds: ["t1", "t2"] } } } });
        if (proc === "temporalInternal.syncTenantInventory") {
          if (body?.json?.tenantId === "t2") return send(404, { error: { json: { message: "Tenant t2 not found" } } });
          return send(200, { result: { data: { json: { tenantId: body.json.tenantId, recordsSynced: 9 } } } });
        }
        if (proc === "temporalInternal.journeyPlan") {
          if (body?.json?.journeyId === "e2e-journey") return send(200, { result: { data: { json: { activities: ["s1", "s2"] } } } });
          return send(400, { error: { json: { message: `unknown orchestration journey: ${body?.json?.journeyId}` } } });
        }
        if (proc === "temporalInternal.runJourneyActivity") return send(200, { result: { data: { json: { cached: false } } } });
        if (proc === "temporalInternal.finishJourney") return send(200, { result: { data: { json: { status: body.json.status, alreadyClosed: false } } } });
        return send(404, { error: { json: { message: `unknown procedure ${proc}` } } });
      });
    });
    await new Promise<void>((r) => platform.listen(0, "127.0.0.1", r));
    platformUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    for (const c of children) c.kill("SIGTERM");
    await new Promise<void>((r) => (platform ? platform.close(() => r()) : r()));
    await env?.teardown();
  });

  function spawnWorker(extra: Record<string, string>, opts: { omit?: string[] } = {}) {
    const taskQueue = `e2e-${++seq}`;
    const healthPort = 18800 + seq;
    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TEMPORAL_ADDRESS: env.address,
      TEMPORAL_NAMESPACE: "default",
      TEMPORAL_TASK_QUEUE: taskQueue,
      PLATFORM_API_URL: platformUrl,
      PLATFORM_INTERNAL_TOKEN: TOKEN,
      HEALTH_PORT: String(healthPort),
      ...extra,
    };
    for (const k of opts.omit ?? []) delete childEnv[k];
    const child = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["services/temporal-workflows/worker.ts"], { cwd: ROOT, env: childEnv });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    children.push(child);
    return { child, taskQueue, healthPort, logs: () => output };
  }

  async function waitHealthy(port: number, logs: () => string): Promise<Response> {
    const deadline = Date.now() + 120_000; // first start bundles the workflows with webpack
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.status === 200) return res;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`worker never became healthy. Output:\n${logs()}`);
  }

  it("boots, reports healthy, and runs InventorySyncWorkflow through the real HTTP client", async () => {
    platformCalls.length = 0;
    const w = spawnWorker({});
    const health = await waitHealthy(w.healthPort, w.logs);
    expect(await health.json()).toMatchObject({ state: "RUNNING", taskQueue: w.taskQueue });

    const result = await env.client.workflow.execute("InventorySyncWorkflow", {
      taskQueue: w.taskQueue,
      workflowId: `e2e-inv-${w.taskQueue}`,
      args: [{}],
    });

    // t1 syncs (9 records); t2 is a 404 → recorded as failed, NOT a workflow failure.
    expect(result).toEqual({ tenants: 2, succeeded: 1, failed: ["t2"], recordsSynced: 9 });

    // Every call carried the internal token and the superjson {json: input} body.
    expect(platformCalls.length).toBeGreaterThanOrEqual(3);
    expect(platformCalls.every((c) => c.token === TOKEN)).toBe(true);
    expect(platformCalls.map((c) => c.path)).toEqual(
      expect.arrayContaining(["temporalInternal.listInventorySyncTenants", "temporalInternal.syncTenantInventory"]),
    );
    expect(platformCalls.find((c) => c.path === "temporalInternal.syncTenantInventory")!.body).toEqual({ json: { tenantId: "t1" } });

    // The 404 for t2 is definitive: exactly ONE attempt, no retry storm.
    expect(platformCalls.filter((c) => c.body?.json?.tenantId === "t2")).toHaveLength(1);
  }, 240_000);

  it("runs JourneyOrchestrationWorkflow: plan → each step keyed by the first run id → finish(completed)", async () => {
    platformCalls.length = 0;
    const w = spawnWorker({});
    await waitHealthy(w.healthPort, w.logs);

    const handle = await env.client.workflow.start("JourneyOrchestrationWorkflow", {
      taskQueue: w.taskQueue,
      workflowId: `e2e-journey-${w.taskQueue}`,
      args: [{ journeyId: "e2e-journey", params: {} }],
    });
    const result = await handle.result();
    expect(result).toEqual({ journeyId: "e2e-journey", executed: ["s1", "s2"] });

    expect(platformCalls.every((c) => c.token === TOKEN)).toBe(true);
    expect(platformCalls.map((c) => [c.path, c.body?.json])).toEqual([
      ["temporalInternal.journeyPlan", { journeyId: "e2e-journey" }],
      ["temporalInternal.runJourneyActivity", { runId: handle.firstExecutionRunId, activityName: "s1" }],
      ["temporalInternal.runJourneyActivity", { runId: handle.firstExecutionRunId, activityName: "s2" }],
      ["temporalInternal.finishJourney", { runId: handle.firstExecutionRunId, status: "completed" }],
    ]);
  }, 240_000);

  it("an unknown journey (HTTP 400) fails once, is not retried, and the run is closed as failed", async () => {
    platformCalls.length = 0;
    const w = spawnWorker({});
    await waitHealthy(w.healthPort, w.logs);

    let failure: any;
    try {
      await env.client.workflow.execute("JourneyOrchestrationWorkflow", {
        taskQueue: w.taskQueue,
        workflowId: `e2e-journey-bad-${w.taskQueue}`,
        args: [{ journeyId: "no-such-journey", params: {} }],
      });
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeTruthy();
    let cause = failure.cause;
    while (cause && cause.type === undefined && cause.cause) cause = cause.cause;
    expect(cause.type).toBe("PlatformRejected");
    expect(cause.message).toContain("400");
    expect(platformCalls.filter((c) => c.path === "temporalInternal.journeyPlan")).toHaveLength(1);
    const finish = platformCalls.find((c) => c.path === "temporalInternal.finishJourney");
    expect(finish?.body?.json).toMatchObject({ status: "failed" });
    expect(String(finish?.body?.json?.error)).toContain("no-such-journey");
    expect(platformCalls.some((c) => c.path === "temporalInternal.runJourneyActivity")).toBe(false);
  }, 240_000);

  it("a wrong internal token fails fast with PlatformRejected — one call, no retries", async () => {
    platformCalls.length = 0;
    const w = spawnWorker({ PLATFORM_INTERNAL_TOKEN: "wrong-token" });
    await waitHealthy(w.healthPort, w.logs);

    let failure: any;
    try {
      await env.client.workflow.execute("InventorySyncWorkflow", { taskQueue: w.taskQueue, workflowId: `e2e-bad-${w.taskQueue}`, args: [{}] });
    } catch (e) {
      failure = e;
    }
    expect(failure, "the workflow must fail (an auth problem is not a per-tenant result)").toBeTruthy();
    let cause = failure.cause;
    while (cause && cause.type === undefined && cause.cause) cause = cause.cause;
    expect(cause.type).toBe("PlatformRejected");
    expect(cause.message).toContain("401");
    expect(platformCalls).toHaveLength(1);
  }, 240_000);

  for (const missing of ["PLATFORM_INTERNAL_TOKEN", "PLATFORM_API_URL", "TEMPORAL_ADDRESS"]) {
    it(`refuses to start (exit 1) when ${missing} is unset — never idles looking healthy`, async () => {
      const w = spawnWorker({}, { omit: [missing] });
      const code = await new Promise<number | null>((resolve) => w.child.on("exit", (c) => resolve(c)));
      expect(code).toBe(1);
      expect(w.logs()).toContain(`${missing} is required`);
    }, 60_000);
  }
});
