/**
 * Temporal worker — WhatsApp Commerce platform.
 *
 * Polls one task queue, runs the workflows in workflows.ts (in Temporal's sandbox) and the
 * activities in activities.ts (here, in this process) which call back into the platform's
 * tRPC internalProcedure endpoints with the shared internal key.
 *
 * Run:  npx tsx services/temporal-workflows/worker.ts
 *
 * Environment (all required except where a default is shown):
 *   TEMPORAL_ADDRESS          frontend gRPC address, e.g. temporal-frontend.temporal.svc.cluster.local:7233
 *   TEMPORAL_NAMESPACE        default "whatsapp-commerce"
 *   TEMPORAL_TASK_QUEUE       default "whatsapp-commerce"
 *   PLATFORM_API_URL          e.g. http://server.whatsapp-commerce.svc.cluster.local:3000
 *   PLATFORM_INTERNAL_TOKEN   must equal the server's INTERNAL_API_KEY
 *   TEMPORAL_WORKER_BUILD_ID  optional label (default: the workflow version tuple)
 *   HEALTH_PORT               default 8080 — GET /healthz is 200 only while the worker is RUNNING
 *   OTEL_ENABLED=true         optional; adds the manual activity span interceptor
 *
 * There is intentionally NO "simulation mode": a worker that cannot start exits non-zero so
 * the failure is visible, instead of idling and looking healthy.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities, createApiCall } from "./activities";
import { TASK_QUEUE as DEFAULT_TASK_QUEUE, workerBuildId } from "./versions";

export const WORKER_BUILD_ID = workerBuildId(process.env.TEMPORAL_WORKER_BUILD_ID);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[temporal-worker] ${name} is required but not set — refusing to start`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const address = required("TEMPORAL_ADDRESS");
  const namespace = process.env.TEMPORAL_NAMESPACE?.trim() || "whatsapp-commerce";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE?.trim() || DEFAULT_TASK_QUEUE;
  const platformUrl = required("PLATFORM_API_URL");
  const internalToken = required("PLATFORM_INTERNAL_TOKEN");
  const healthPort = Number(process.env.HEALTH_PORT ?? 8080);

  console.log(`[temporal-worker] address=${address} namespace=${namespace} taskQueue=${taskQueue} buildId=${WORKER_BUILD_ID}`);

  const activities = createActivities({
    apiCall: createApiCall({ baseUrl: platformUrl, internalToken }),
  });

  // OTel is opt-in and loaded lazily so the default worker needs no @opentelemetry packages.
  // Only activity interceptors are wired: workflow interceptors must be supplied as a module
  // (`workflowModules`) because they execute inside the sandbox — the structural workflow
  // interceptor in otelInterceptors.ts cannot be used that way.
  let interceptors: { activity: Array<(ctx: any) => any> } | undefined;
  if ((process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true") {
    const { createOtelWorkerInterceptors } = await import("./otelInterceptors");
    const built = createOtelWorkerInterceptors();
    if (built) interceptors = { activity: built.activity };
  }

  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    // Bundled at startup with Temporal's webpack pipeline; the file must stay sandbox-safe.
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
    // Label only (worker versioning itself is off): shows which build served a task.
    buildId: WORKER_BUILD_ID,
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 5,
    ...(interceptors ? { interceptors } : {}),
  });

  // Health endpoint — honest: 200 only while the poller is actually RUNNING.
  const health = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const state = worker.getState();
    res.writeHead(state === "RUNNING" ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ state, namespace, taskQueue, buildId: WORKER_BUILD_ID }));
  });
  health.listen(healthPort, () => console.log(`[temporal-worker] health on :${healthPort}/healthz`));

  try {
    console.log("[temporal-worker] worker created, polling");
    await worker.run(); // resolves on SIGINT/SIGTERM after in-flight tasks drain
  } finally {
    health.close();
    await connection.close();
  }
}

// Only run when executed directly, so importing WORKER_BUILD_ID (tests) never starts a worker.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("[temporal-worker] fatal:", err);
    process.exit(1);
  });
}
