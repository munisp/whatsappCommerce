/**
 * === W42 workflows (Coder C / PLT-17) ===
 * J319 — Pool client-swap leak regression: withRetry() hitting a transient
 * connection error must END the old postgres.js pool (resetDbConnection)
 * before swapping references — the pre-W42 code dropped it un-ended and
 * leaked its sockets. After the swap the pool must be recreated and the
 * world DB fully usable.
 */
import { sql } from "drizzle-orm";
import { assert } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J319",
  name: "withRetry client-swap ends old pool",
  feature: "leak fix: old pool ended before swap; DB recreated + usable",
  async run() {
    const dbmod = await import("../../server/db");

    // Ensure a live pool exists to swap.
    const db0 = await dbmod.getDb();
    assert(db0, "pool live before swap");
    const resetsBefore = dbmod.getDbPoolResetCount();

    // Transient failure on attempt 1 (ECONNRESET) → retry path swaps pool.
    let attempts = 0;
    const result = await dbmod.withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("read ECONNRESET") as Error & { code: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return "ok";
    });
    assert(result === "ok", "withRetry succeeds after transient error");
    assert(attempts === 2, "exactly one retry happened");

    // REGRESSION PIN: the swap must have ended a live pool (counter moved).
    const resetsAfter = dbmod.getDbPoolResetCount();
    assert(
      resetsAfter === resetsBefore + 1,
      `old pool ended exactly once during swap (before=${resetsBefore} after=${resetsAfter})`
    );

    // The pool is lazily recreated and the DB is fully usable afterwards.
    const db1 = await dbmod.getDb();
    assert(db1, "pool recreated after swap");
    const rows = await db1.execute(sql`select 1 as one`);
    assert((rows as unknown as unknown[]).length === 1, "recreated pool serves queries");
  },
};
