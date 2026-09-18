// === W46 orders-p2 (Coder G) ===
/**
 * J421 — ORD-19 cron wiring: POST /api/scheduled/po-breach-sweep runs under
 * W42 cronAuth (cron-only; scope+jti), is on the scheduler.mjs allowlist
 * (J178 contract), and drives the breach sweep end-to-end over HTTP.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { assert, SUPPLIER_ADMIN_PHONE, type World } from "../world";
import type { Journey } from "../runner";
import { seedSupplierProfile, seedPo } from "./w46-orders-seed";

const HERE = dirname(fileURLToPath(import.meta.url));

export const journey: Journey = {
  id: "J421",
  name: "po-breach-sweep cron route: cronAuth + allowlist + end-to-end alert",
  feature: "ORD-19 /api/scheduled/po-breach-sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // J178 contract: the route exists in index.ts AND the scheduler allowlist.
    const indexTs = readFileSync(join(HERE, "../../server/_core/index.ts"), "utf8");
    assert(indexTs.includes('"/api/scheduled/po-breach-sweep"'), "route registered in _core/index.ts");
    const schedulerMjs = readFileSync(join(HERE, "../../services/scheduler/scheduler.mjs"), "utf8");
    assert(schedulerMjs.includes('"/api/scheduled/po-breach-sweep"'), "route on scheduler.mjs allowlist");

    // cronAuth: an UNAUTHENTICATED call is refused (403 cron-only).
    const unauth = await fetch(`${world.baseUrl}/api/scheduled/po-breach-sweep`, { method: "POST" });
    assert(unauth.status === 403, `unauthenticated refused (got ${unauth.status})`);

    // End-to-end: seed a breached PO, fire the cron route, alert lands.
    await seedSupplierProfile(world, 3);
    const buyerPhone = world.newPhone("j421");
    const poId = await seedPo(world, "j421", { status: "approved", buyerPhone });
    await world.db.update(schema.purchaseOrders).set({
      approvedAt: new Date(Date.now() - 10 * 86_400_000),
      promisedDate: new Date(Date.now() - 4 * 86_400_000),
    }).where(eq(schema.purchaseOrders.id, poId));

    const res = await world.runCron("/api/scheduled/po-breach-sweep");
    assert(res.status === 200, `cron route 200 (got ${res.status}: ${JSON.stringify(res.json)})`);
    assert(res.json?.ok === true && res.json.alerted >= 1, `sweep alerted ≥1 (got ${JSON.stringify(res.json)})`);
    await world.waitFor(
      () => world.outbound.findByBody("past its promised delivery date", buyerPhone).length > 0,
      5000,
      "buyer breach alert via cron",
    );
    assert(world.outbound.findByBody("Promise breached", SUPPLIER_ADMIN_PHONE).length > 0, "supplier admin alerted via cron");

    // Idempotent re-fire: second cron run alerts nothing new for this PO.
    const res2 = await world.runCron("/api/scheduled/po-breach-sweep");
    assert(res2.status === 200 && (res2.json?.alerted ?? 0) === 0, "re-fire alerts nothing new");
  },
};
// === END W46 orders-p2 ===
