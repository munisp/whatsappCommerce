/**
 * J85 — WhatsApp shelf-photo stock-take (CV-1).
 *
 * A tenant user photos their shelf and WhatsApps it to the business number.
 * With settings.visualInventoryWhatsAppEnabled on, the webhook media pipeline
 * opens a visual-inventory session (source 'whatsapp'), the (scripted) VLM
 * orchestrator returns counts, and the chat reply summarizes them
 * ("I counted: 12× Indomie Pack … Reply APPLY to update stock or REVIEW to
 * check first"). "APPLY" then runs the calibrated auto-apply policy:
 * the 0.98-confidence item with a verified mapping applies to real stock,
 * while the 0.75 item is queued for review (session review_needed + operator
 * notification) and its product stays untouched.
 *
 * Runs against the REAL webhook handlers: Meta Graph is scripted via
 * metaMock (media download), the orchestrator via the metaMock ERP host seam
 * (VISUAL_INVENTORY_ORCHESTRATOR_URL → orchestrator.sim.local).
 */
import { eq } from "drizzle-orm";
import { erp, scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const INDOMIE = { id: "p-j85-indomie", label: "Indomie Pack", startStock: 10, counted: 12 };
const WATER = { id: "p-j85-water", label: "Pure Water Sachet", startStock: 30, counted: 30 };

export const journey: Journey = {
  id: "J85",
  name: "whatsapp visual stock-take",
  feature: "photo → counts → APPLY (calibrated)",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // ── Tenant opts in + two stock products with verified label mappings ────
    const [t0] = await world.db
      .select({ settings: schema.tenants.settings })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, TENANT_ID))
      .limit(1);
    const originalSettings = (t0?.settings ?? {}) as Record<string, any>;
    await world.db
      .update(schema.tenants)
      .set({
        settings: { ...originalSettings, visualInventoryWhatsAppEnabled: true },
        updatedAt: new Date(),
      })
      .where(eq(schema.tenants.id, TENANT_ID));

    for (const p of [INDOMIE, WATER]) {
      await world.db.insert(schema.products).values({
        id: p.id,
        tenantId: TENANT_ID,
        sku: `SIM-J85-${p.id}`,
        name: p.label,
        description: `${p.label} — J85 stock-take item`,
        category: "sim",
        price: "100.00",
        currency: "NGN",
        status: "active",
        stockQuantity: p.startStock,
        lowStockThreshold: 1,
      }).onConflictDoNothing();
      await world.db.insert(schema.visualInventoryMappings).values({
        id: `map-j85-${p.id}`,
        tenantId: TENANT_ID,
        detectedLabel: p.label,
        productId: p.id,
        isVerified: true,
      }).onConflictDoNothing();
    }

    // ── Scripted VLM orchestrator (metaMock per-host seam) ─────────────────
    process.env.VISUAL_INVENTORY_ORCHESTRATOR_URL = "http://orchestrator.sim.local";
    erp.script("orchestrator.sim.local", () => ({
      json: {
        items: [
          { label: INDOMIE.label, count: INDOMIE.counted, confidence: 0.98 }, // ≥0.95 + verified → auto-apply
          { label: WATER.label, count: WATER.counted, confidence: 0.75 },     // [0.6, 0.95) → review queue
        ],
        scene_description: "corner shop shelf",
        vlm_model_used: "yolo11-sim",
        processing_ms: 12,
      },
    }));

    try {
      // ── 1. Shelf photo arrives on WhatsApp ────────────────────────────────
      const phone = world.newPhone("j85");
      await world.grantConsent(phone);
      scriptMedia("m-j85-shelf", "SIMIMG shelf photo");
      await world.image(phone, "m-j85-shelf");

      let sessionId = "";
      await world.waitFor(async () => {
        const rows = await world.db
          .select()
          .from(schema.visualInventorySessions)
          .where(eq(schema.visualInventorySessions.userId, phone))
          .limit(5);
        const s = rows.find((r: any) => r.status === "review_needed" || r.status === "completed");
        if (s) sessionId = s.id;
        return !!s;
      }, 15000, "stock-take session analysed");

      const [session] = await world.db
        .select()
        .from(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.id, sessionId))
        .limit(1);
      assert(session.source === "whatsapp", `session source is whatsapp (got ${session.source})`);
      assert(session.tenantId === TENANT_ID, "session is tenant-scoped");
      assert(session.totalItemsDetected === 42, `42 items detected (got ${session.totalItemsDetected})`);
      // The 0.75-confidence item holds the session in review_needed.
      assert(session.status === "review_needed", `low-confidence item → review_needed (got ${session.status})`);

      // Counts summary reply with APPLY/REVIEW instructions.
      const countsReply = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(countsReply, `I counted: ${INDOMIE.counted}× ${INDOMIE.label}, ${WATER.counted}× ${WATER.label}`, "counts summary");
      assertIncludes(countsReply, "APPLY", "APPLY instruction");
      assertIncludes(countsReply, "REVIEW", "REVIEW instruction");

      // ── 2. APPLY — calibrated auto-apply ──────────────────────────────────
      await world.text(phone, "APPLY");
      await world.waitFor(async () => {
        const [p] = await world.db
          .select()
          .from(schema.products)
          .where(eq(schema.products.id, INDOMIE.id))
          .limit(1);
        return p?.stockQuantity === INDOMIE.counted;
      }, 15000, "high-confidence item auto-applied to stock");

      // Confident item applied; low-confidence item untouched.
      const [water] = await world.db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, WATER.id))
        .limit(1);
      assert(water.stockQuantity === WATER.startStock, `low-confidence item NOT applied (got ${water.stockQuantity})`);

      // Session: applied but still review_needed for the queued item.
      const [after] = await world.db
        .select()
        .from(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.id, sessionId))
        .limit(1);
      assert(after.appliedToInventory === true, "session marked applied");
      assert(after.status === "review_needed", `session still review_needed after partial apply (got ${after.status})`);
      assert(String(after.appliedBy).startsWith("whatsapp:"), "appliedBy records the whatsapp sender");
      const updates = (after.inventoryUpdates ?? []) as Array<{ productId: string; newQty: number }>;
      assert(updates.some((u) => u.productId === INDOMIE.id && u.newQty === INDOMIE.counted), "inventory update recorded");
      assert(!updates.some((u) => u.productId === WATER.id), "queued item has no inventory update");

      // APPLY reply: 1 applied, 1 queued for review.
      const applyReply = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(applyReply, "Updated stock for 1 item", "apply summary");
      assertIncludes(applyReply, "review", "review pointer");

      // Operator review_required notification exists for this session.
      const notifs = await world.db
        .select()
        .from(schema.merchantNotifications)
        .where(eq(schema.merchantNotifications.tenantId, TENANT_ID))
        .limit(100);
      assert(
        notifs.some((n: any) => n.metadata?.kind === "visual_inventory_review_required" && n.metadata?.sessionId === sessionId),
        "operator review_required notification emitted",
      );

      // ── 3. Flag OFF → image is NOT claimed by the stock-take pipeline ─────
      await world.db
        .update(schema.tenants)
        .set({ settings: { ...originalSettings, visualInventoryWhatsAppEnabled: false }, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID));
      const sessionsBefore = await world.db
        .select()
        .from(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.tenantId, TENANT_ID))
        .limit(200);
      const phone2 = world.newPhone("j85off");
      await world.grantConsent(phone2);
      scriptMedia("m-j85-off", "SIMIMG shelf photo 2");
      await world.image(phone2, "m-j85-off");
      await world.settle(800);
      const sessionsAfter = await world.db
        .select()
        .from(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.tenantId, TENANT_ID))
        .limit(200);
      assert(
        sessionsAfter.length === sessionsBefore.length,
        `disabled flag → no new session (got ${sessionsAfter.length - sessionsBefore.length} new)`,
      );
    } finally {
      // Journey-owned rows + env — restore the seed world for later journeys.
      const { inArray } = await import("drizzle-orm");
      await world.db.delete(schema.visualInventoryMappings)
        .where(inArray(schema.visualInventoryMappings.id, [INDOMIE, WATER].map((p) => `map-j85-${p.id}`)))
        .catch(() => {});
      await world.db.delete(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.tenantId, TENANT_ID))
        .catch(() => {});
      await world.db.delete(schema.inventorySnapshots)
        .where(inArray(schema.inventorySnapshots.productId, [INDOMIE.id, WATER.id]))
        .catch(() => {});
      await world.db.delete(schema.merchantNotifications)
        .where(eq(schema.merchantNotifications.tenantId, TENANT_ID))
        .catch(() => {});
      await world.db.delete(schema.products)
        .where(inArray(schema.products.id, [INDOMIE.id, WATER.id]))
        .catch(() => {});
      await world.db
        .update(schema.tenants)
        .set({ settings: originalSettings, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID))
        .catch(() => {});
      delete process.env.VISUAL_INVENTORY_ORCHESTRATOR_URL;
    }
  },
};
