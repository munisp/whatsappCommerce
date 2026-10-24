// === W66 learning ===
/**
 * J629 — R6 restock intelligence (services/restockIntel.ts):
 *   1. computeRestockSignals derives depletion rate + days-of-cover from
 *      order_items cadence (completed payments only; old/unpaid excluded).
 *   2. runRestockSweep auto-drafts a restock PO (status draft, supplier from
 *      the merchant's last PO for that product) and nudges the merchant
 *      admin with a one-tap confirm link; a same-day re-run is idempotent
 *      (no second draft, no second nudge).
 *   3. confirmRestockDraft is claim-first: draft→submitted once; a double
 *      confirm is CONFLICT/wrong_status. Drafts NEVER auto-submit.
 *   4. /api/scheduled/restock-sweep registered + allowlisted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN_PHONE = "2348062900001";
const SUPPLIER = "sup-j629";

export const journey: Journey = {
  id: "J629",
  name: "restock sweep drafts PO from depletion, idempotent re-run, claim-first confirm",
  feature: "W66 R6 restock & procurement intelligence",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const before = await world.tenantSettings();
    try {
      await world.patchTenantSettings({
        adminPhone: ADMIN_PHONE,
        marketingFrequency: { ...(before?.marketingFrequency ?? {}), quietStart: "00:00", quietEnd: "00:00" },
      });

      // ── Seeds: product with ~1/day depletion and 3 units of stock ─────
      await world.db.insert(schema.products).values({
        id: "p-j629", tenantId: TENANT_ID, sku: "SIM-J629-P", name: "J629 Beans 50kg",
        price: "200.00", currency: "NGN", status: "active", stockQuantity: 3, lowStockThreshold: 5,
      }).onConflictDoNothing();
      // 30 sold over 30d across completed orders → 1/day → 3 days of cover.
      // Spread 10d apart so c-j629's reorder cadence (10d interval) has NOT
      // elapsed during J630's next-week run in a shared world (J630 asserts
      // exactly one nudge then).
      const offsetsDays = [20, 10, 0];
      for (let i = 0; i < 3; i++) {
        await world.db.insert(schema.orders).values({
          id: `o-j629-${i}`, tenantId: TENANT_ID, customerId: "c-j629", orderNumber: `SIM-J629-${i}`,
          status: "delivered", totalAmount: "2000.00", currency: "NGN", paymentStatus: "completed",
        }).onConflictDoNothing();
        if (offsetsDays[i] > 0) {
          await world.db.execute(sql`
            UPDATE orders SET "createdAt" = now() - (${offsetsDays[i]} * interval '1 day') WHERE id = ${`o-j629-${i}`}
          `);
        }
        await world.db.insert(schema.orderItems).values({
          id: `oi-j629-${i}`, orderId: `o-j629-${i}`, productId: "p-j629",
          productName: "J629 Beans 50kg", quantity: 10, unitPrice: "200.00", currency: "NGN",
        }).onConflictDoNothing();
      }
      // An UNPAID order whose items must NOT count toward depletion.
      await world.db.insert(schema.orders).values({
        id: "o-j629-unpaid", tenantId: TENANT_ID, customerId: "c-j629", orderNumber: "SIM-J629-U",
        status: "pending", totalAmount: "20000.00", currency: "NGN", paymentStatus: "unpaid",
      }).onConflictDoNothing();
      await world.db.insert(schema.orderItems).values({
        id: "oi-j629-unpaid", orderId: "o-j629-unpaid", productId: "p-j629",
        productName: "J629 Beans 50kg", quantity: 100, unitPrice: "200.00", currency: "NGN",
      }).onConflictDoNothing();
      // Prior fulfilled PO from SUPPLIER for this product (supplier resolution).
      await world.db.insert(schema.purchaseOrders).values({
        id: "00000000-0000-4000-8000-000000000629", poNumber: "PO-J629-PRIOR", buyerTenantId: TENANT_ID,
        supplierTenantId: SUPPLIER, status: "fulfilled", subtotalCents: 1_500_000,
        paymentMode: "paynow",
      }).onConflictDoNothing();
      await world.db.insert(schema.poItems).values({
        id: "00000000-0000-4000-8000-000000001629", poId: "00000000-0000-4000-8000-000000000629", productRef: "p-j629",
        name: "J629 Beans 50kg", qty: 50, unitPriceCents: 15_000, lineTotalCents: 750_000,
      }).onConflictDoNothing();

      const svc = await import("../../server/services/restockIntel");

      // ── 1. Signals ─────────────────────────────────────────────────────
      const signals = await svc.computeRestockSignals(world.db, TENANT_ID);
      const sig = signals.find((s) => s.productId === "p-j629")!;
      assert(sig.soldQtyWindow === 30, `sold ${sig.soldQtyWindow} (unpaid must be excluded)`);
      assert(sig.dailyRate === 1, `rate ${sig.dailyRate}`);
      assert(sig.daysOfCover === 3, `cover ${sig.daysOfCover}`);
      assert(sig.suggestedQty === 18, `suggested ${sig.suggestedQty}`); // 21d target − 3 stock
      assert(svc.lowCoverSignals(signals).some((s) => s.productId === "p-j629"), "low cover flagged");

      // ── 2. Sweep drafts a PO + nudges; re-run idempotent ──────────────
      const r1 = await svc.runRestockSweep();
      assert(r1.draftsCreated === 1, `drafts ${r1.draftsCreated}`);
      assert(r1.nudgesSent === 1, `nudges ${r1.nudgesSent}`);
      const r2 = await svc.runRestockSweep();
      assert(r2.draftsCreated === 0 && r2.nudgesSent === 0, "second sweep idempotent");

      // Draft exists as DRAFT (never auto-submitted), priced in integer cents
      const drafts = await svc.listRestockDrafts(world.db, TENANT_ID);
      const draft = drafts.find((d) => d.notes?.includes("J629 Beans"))!;
      assert(draft, "draft listed");
      assert(draft.subtotalCents === 18 * 15_000, `subtotal ${draft.subtotalCents}`);
      const [poRow] = await world.db.select().from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.id, draft.id));
      assert(poRow.status === "draft", "stays draft until confirm");
      assert(poRow.supplierTenantId === SUPPLIER, "supplier from last PO");

      // ── 3. Claim-first confirm (via tenant router) ────────────────────
      const caller = await tenantCaller(TENANT_ID);
      const confirmed = await caller.learning.confirmRestockDraft({ tenantId: TENANT_ID, poId: draft.id });
      assert(confirmed.ok && confirmed.poNumber === draft.poNumber, "confirmed");
      let conflict = false;
      try {
        await caller.learning.confirmRestockDraft({ tenantId: TENANT_ID, poId: draft.id });
      } catch (e: any) {
        conflict = true;
      }
      assert(conflict, "double confirm conflicts");

      // ── 4. Scheduler parity ────────────────────────────────────────────
      const indexSrc = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf8");
      assert(indexSrc.includes('"/api/scheduled/restock-sweep"'), "route registered");
      const schedSrc = fs.readFileSync(path.join(ROOT, "services/scheduler/scheduler.mjs"), "utf8");
      assert(schedSrc.includes("/api/scheduled/restock-sweep"), "allowlist entry");
    } finally {
      await world.patchTenantSettings(before ?? {});
    }
  },
};
