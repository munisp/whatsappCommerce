// === W62 findings ===
/**
 * J613 — F10: payment idempotency lock TTL raised 300s → 24h (86400).
 * PSP retries arriving >5 min after initiation used to bypass the Redis
 * gate; the DB unique constraints + claim-first guards remain the backstop.
 * Asserts the new default and the documented backstop, and that the lock
 * acquisition still uses SET NX EX (fail-closed in production).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J613",
  name: "payment idempotency lock TTL 24h + documented DB backstop",
  feature: "W62 findings F10: idempotency TTL",
  async run(_world: World) {
    const src = fs.readFileSync(path.join(ROOT, "server/routers/payment.ts"), "utf-8");
    assert(src.includes("ttlSeconds = 86400"), "idempotency lock default TTL is 24h");
    assert(!/ttlSeconds = 300\b/.test(src), "old 300s default removed");
    assert(src.includes("payment_outbox_reference_uniq"), "DB unique-constraint backstop documented");
    assert(src.includes('"EX", ttlSeconds, "NX"'), "SET NX EX lock acquisition preserved");
    assert(src.includes("idempotency fail-closed"), "production fail-closed policy preserved");
  },
};
