// === W62 findings ===
/**
 * J615 — F14: /api/cron/* ops sweeps (webhook-dedupe-sweep,
 * orphan-tenant-sweep) were registered cron-auth routes with NO production
 * invoker — not in the scheduler allowlist and no k8s CronJob. They are now
 * scheduler-invoked (SCHEDULE allowlist) and J178's parity regex covers
 * /api/cron/* too.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J615",
  name: "cron allowlist parity: /api/cron sweeps are scheduler-invoked",
  feature: "W62 findings F14: cron allowlist parity",
  async run(_world: World) {
    const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
    assert(idx.includes('app.post("/api/cron/webhook-dedupe-sweep"'), "dedupe sweep route registered");
    assert(idx.includes('app.post("/api/cron/orphan-tenant-sweep"'), "orphan sweep route registered");
    const scheduler = await import("../../services/scheduler/scheduler.mjs");
    for (const p of ["/api/cron/webhook-dedupe-sweep", "/api/cron/orphan-tenant-sweep"]) {
      assert(scheduler.SCHEDULE.some((x: { path: string }) => x.path === p), `scheduler allowlist entry for ${p}`);
    }
    // J178 parity regex must cover /api/cron/* so the invariant is enforced.
    const j178 = fs.readFileSync(path.join(ROOT, "simulation/journeys/j178-scheduler-compose-boot.ts"), "utf-8");
    assert(j178.includes("scheduled|cron"), "J178 parity regex covers /api/cron/*");
  },
};
