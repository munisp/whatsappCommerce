/**
 * === W42 workflows (Coder C / PLT-17) ===
 * J320 — Bounded pool queue: when ops in flight reach PG_POOL_QUEUE_MAX,
 * withRetry() rejects immediately with DB_POOL_QUEUE_SATURATED (503) instead
 * of queueing unboundedly behind a pile-up. The bound is a fast-fail shed,
 * not a connection limit (postgres.js `max` already bounds connections).
 */
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J320",
  name: "pool queue bound sheds load",
  feature: "PG_POOL_QUEUE_MAX fast-fail: DB_POOL_QUEUE_SATURATED instead of unbounded queue",
  async run() {
    const dbmod = await import("../../server/db");

    const prev = process.env.PG_POOL_QUEUE_MAX;
    process.env.PG_POOL_QUEUE_MAX = "1";
    try {
      assert(dbmod.getDbQueueMax() === 1, "queue bound reflects env");
      assert(dbmod.getDbQueueDepth() === 0, "queue empty at start");

      // Occupy the single slot with an op we control.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const first = dbmod.withRetry(() => gate);
      // Let the first op enter the queue.
      await new Promise((r) => setTimeout(r, 10));
      assert(dbmod.getDbQueueDepth() === 1, "first op holds the single slot");

      // Second op must shed immediately — no queueing behind the pile-up.
      let shedErr: (Error & { code?: string; statusCode?: number }) | null = null;
      try {
        await dbmod.withRetry(async () => "never");
      } catch (e: any) {
        shedErr = e;
      }
      assert(shedErr, "second op rejected under saturation");
      assert(shedErr!.code === "DB_POOL_QUEUE_SATURATED", "rejection carries saturation code");
      assert(shedErr!.statusCode === 503, "rejection maps to 503");
      assertIncludes(shedErr!.message, "db_pool_queue_saturated", "honest error message");

      // Depth recovers when the held op completes.
      release();
      await first;
      await new Promise((r) => setTimeout(r, 10));
      assert(dbmod.getDbQueueDepth() === 0, "queue drains after release");
      await dbmod.withRetry(async () => "ok"); // accepts again post-drain
    } finally {
      if (prev === undefined) delete process.env.PG_POOL_QUEUE_MAX;
      else process.env.PG_POOL_QUEUE_MAX = prev;
    }
  },
};
