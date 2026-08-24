/**
 * J178 — W30 deploy: compose env completeness (boot-gate dry check) +
 * scheduler route parity + scheduler invokes /api/scheduled/* WITH cron auth.
 *
 *   1. docker-compose.yml platform service defines every REQUIRED_BY_ENV key
 *      (parsed from server/_core/env.ts — the boot gate itself), so
 *      `docker compose up platform` no longer crashes at env import.
 *   2. services/scheduler SCHEDULE covers exactly the app.post("/api/scheduled/*")
 *      routes registered in server/_core/index.ts (34 at time of writing).
 *   3. invokeRoute() against a mock HTTP server sends
 *      Authorization: Bearer <HS256 JWT> whose openId carries the cron_
 *      prefix and a task_uid claim — i.e. authenticated invocation.
 *   4. The scheduler refuses unknown routes and refuses to run without CRON_JWT.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function requiredByEnvKeys(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "server/_core/env.ts"), "utf-8");
  const block = src.match(/REQUIRED_BY_ENV[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert(!!block, "REQUIRED_BY_ENV block not found in env.ts");
  const keys = [...block![1].matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  assert(keys.length >= 5, `expected >=5 required keys, got ${keys.length}`);
  return keys;
}

function scheduledRoutes(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
  return [...src.matchAll(/app\.post\("(\/api\/scheduled\/[a-z0-9-]+)"/g)].map((m) => m[1]);
}

export const journey: Journey = {
  id: "J178",
  name: "compose boot-gate completeness + scheduler authenticated cron invocation",
  feature: "deploy/observability: bootable compose, cron scheduler with CRON_JWT auth",
  async run(_world: World) {
    // ── 1. Compose platform env covers the boot gate ─────────────────────
    const { load: yamlLoad } = await import("js-yaml");
    const compose = yamlLoad(fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf-8")) as any;
    const platformEnv = compose?.services?.platform?.environment ?? {};
    for (const key of requiredByEnvKeys()) {
      assert(
        key in platformEnv,
        `platform service missing REQUIRED_BY_ENV key ${key} — compose cannot boot`,
      );
    }
    // WHATSAPP_VERIFY_TOKEN boot gate (separate from REQUIRED_BY_ENV)
    assert("WHATSAPP_VERIFY_TOKEN" in platformEnv, "platform env missing WHATSAPP_VERIFY_TOKEN");
    // Port collision fixed: tigerbeetle no longer binds host 3000
    const tbPorts = (compose.services.tigerbeetle.ports ?? []) as string[];
    assert(!tbPorts.some((p) => String(p).startsWith("3000:")), "tigerbeetle still binds host port 3000");

    // ── 2. Scheduler allowlist parity with the platform routes ───────────
    const scheduler = await import("../../services/scheduler/scheduler.mjs");
    const routes = scheduledRoutes();
    assert(routes.length >= 30, `expected >=30 scheduled routes, found ${routes.length}`);
    const schedulePaths = new Set(scheduler.SCHEDULE.map((r: { path: string }) => r.path));
    for (const r of routes) {
      assert(schedulePaths.has(r), `scheduler missing route ${r}`);
    }
    assert(schedulePaths.size === new Set(routes).size, "scheduler allowlist has extra/duplicate routes");

    // ── 3. Authenticated invocation against a mock HTTP server ───────────
    const secret = "j178-cron-secret";
    const seen: Array<{ path: string; auth: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as any).port;
      const result = await scheduler.invokeRoute("/api/scheduled/sla-scan", {
        platformUrl: `http://127.0.0.1:${port}`,
        secret,
      });
      assert(result.status === 200, `expected 200 from mock, got ${result.status}`);
      assert(seen.length === 1, "mock server did not receive the invocation");
      const auth = seen[0].auth ?? "";
      assert(auth.startsWith("Bearer "), `missing Bearer auth header (got: ${auth || "none"})`);
      const token = auth.slice(7);
      const [h, p, sig] = token.split(".");
      const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest().toString("base64url");
      assert(sig === expected, "cron JWT signature does not verify against CRON_JWT");
      const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf-8"));
      assert(typeof claims.openId === "string" && claims.openId.startsWith("cron_"), "cron JWT openId lacks cron_ prefix");
      assert(typeof claims.task_uid === "string" && claims.task_uid.length > 0, "cron JWT missing task_uid");

      // ── 4. Fail-closed behaviour ───────────────────────────────────────
      let threw = false;
      try {
        await scheduler.invokeRoute("/api/scheduled/not-a-route", { platformUrl: "http://127.0.0.1:1", secret });
      } catch { threw = true; }
      assert(threw, "scheduler accepted a route outside the allowlist");
      threw = false;
      try {
        await scheduler.invokeRoute("/api/scheduled/sla-scan", { platformUrl: "http://127.0.0.1:1", secret: "" });
      } catch { threw = true; }
      assert(threw, "scheduler invoked without CRON_JWT secret");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
