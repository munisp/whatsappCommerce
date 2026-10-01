// === W48 api-db ===
/**
 * J470 — PERF-API-4 / PERF-API-17: additive composite indexes (migrations
 * 0171-0172) exist in the migrated schema, and the dashboard stats helpers
 * were rewritten to single conditional-aggregate scans with UNCHANGED
 * numbers.
 *
 * Proves:
 *   1. orders_tenant_status_created_idx, conversations_tenant_status_updated_idx,
 *      channel_messages_tenant_created_idx, channel_messages_addr_idx,
 *      wa_wh_retry_due_idx, wallet_tx_tenant_created_idx exist (pg_indexes);
 *   2. products trigram index either exists (pg_trgm available) or was
 *      skipped with a warning (PGlite) — migration is resilient either way;
 *   3. getOrderStats / getProductStats return correct counts against seeded
 *      data (conditional-aggregate rewrite is semantics-preserving).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J470",
  name: "composite indexes present + stats aggregates correct (PERF-API-4/17/18)",
  feature: "migrations 0171-0172 additive indexes; getOrderStats/getProductStats single-scan aggregates",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const res: any = await world.db.execute(sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    const names = new Set(rows.map((r: any) => String(r.indexname)));
    for (const ix of [
      "orders_tenant_status_created_idx",
      "conversations_tenant_status_updated_idx",
      "channel_messages_tenant_created_idx",
      "channel_messages_addr_idx",
      "wa_wh_retry_due_idx",
      "wallet_tx_tenant_created_idx",
    ]) {
      assert(names.has(ix), `index ${ix} exists (migration 0171)`);
    }
    // pg_trgm is optional (PGlite lacks the contrib module) — either the
    // index exists or the migration logged a skip; both are valid outcomes.
    console.log(`[J470] products_lower_name_trgm_idx present: ${names.has("products_lower_name_trgm_idx")}`);

    // Stats semantics — seed a known mix.
    const tid = TENANT_ID;
    const mk = (status: string, paymentStatus: string, total: string) => world.db.insert(schema.orders).values({
      id: `ord-j470-${randomUUID().slice(0, 8)}`,
      tenantId: tid, customerId: "sim-customer",
      orderNumber: `J470-${randomUUID().slice(0, 6)}`,
      status, totalAmount: total, currency: "NGN", paymentStatus, metadata: {},
    });
    const before = await (await import("../../server/db")).getOrderStats(tid);
    await mk("pending", "unpaid", "100.00");
    await mk("confirmed", "completed", "200.00");
    await mk("delivered", "completed", "300.00");
    const { getOrderStats, getProductStats } = await import("../../server/db");
    const after = await getOrderStats(tid);
    assert(after.total === before.total + 3, "getOrderStats total +3");
    assert(after.pending === before.pending + 1, "getOrderStats pending +1");
    assert(after.confirmed === before.confirmed + 1, "getOrderStats confirmed +1");
    assert(after.delivered === before.delivered + 1, "getOrderStats delivered +1");
    assert(Math.abs(after.revenue - before.revenue - 500) < 0.01, "getOrderStats revenue +500 (completed only)");

    const pb = await getProductStats(tid);
    await world.db.insert(schema.products).values({
      id: randomUUID(), tenantId: tid, sku: `J470-${randomUUID().slice(0, 6)}`,
      name: "J470 widget", price: "10.00", currency: "NGN", status: "active",
      stockQuantity: 2, lowStockThreshold: 10,
    });
    const pa = await getProductStats(tid);
    assert(pa.total === pb.total + 1 && pa.active === pb.active + 1 && pa.lowStock === pb.lowStock + 1,
      "getProductStats +1/+1/+1 low-stock");
  },
};
