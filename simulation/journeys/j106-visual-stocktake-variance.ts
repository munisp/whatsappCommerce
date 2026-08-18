/**
 * J106 — M4: merchant sends a shelf photo via WhatsApp → visual stock-take
 * session → VLM analyse (mock mode: scripted orchestrator) → VARIANCE ALERT
 * when the count delta exceeds the tenant threshold → auto-apply only at high
 * confidence; mid-confidence items queue for review; sub-threshold items are
 * excluded → inventory counts updated.
 *
 * Distinct from J85 (which sits exactly AT the 20% threshold → no alert):
 * here RICE jumps 30→50 (+66.7% > 20%) so the high-confidence auto-apply also
 * emits a `visual_inventory_variance` merchant notification; BEANS (0.80)
 * queues for review untouched; GARRI (0.50) is excluded below the review
 * floor. Pure-policy math (classifyDetectedItems / computeVariancePct) is
 * asserted in mock mode before the end-to-end flow.
 */
import { eq, inArray } from "drizzle-orm";
import { erp, scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const RICE = { id: "p-j106-rice", label: "J106 Rice 5kg", startStock: 30, counted: 50, conf: 0.98 };
const BEANS = { id: "p-j106-beans", label: "J106 Beans 2kg", startStock: 20, counted: 18, conf: 0.8 };
const GARRI = { id: "p-j106-garri", label: "J106 Garri 1kg", startStock: 12, counted: 12, conf: 0.5 };

export const journey: Journey = {
  id: "J106",
  name: "visual stocktake variance + review queue",
  feature: "VLM mock analyse, variance alert > threshold, calibrated auto-apply vs review queue vs excluded",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const vi = await import("../../server/services/visualInventoryApply");

    // ── Policy math (mock mode, pure) ─────────────────────────────────────
    assert(vi.computeVariancePct(30, 50) > 20, "+66.7% variance exceeds the 20% alert threshold");
    assert(vi.computeVariancePct(20, 18) === -10, "beans -10% variance under the threshold");
    const policy = vi.getViPolicy(null);
    const mappings = new Map<string, { productId: string; isVerified: boolean }>([
      [RICE.label, { productId: RICE.id, isVerified: true }],
      [BEANS.label, { productId: BEANS.id, isVerified: true }],
      [GARRI.label, { productId: GARRI.id, isVerified: true }],
    ]);
    const classified = vi.classifyDetectedItems(
      [
        { label: RICE.label, count: RICE.counted, confidence: RICE.conf },
        { label: BEANS.label, count: BEANS.counted, confidence: BEANS.conf },
        { label: GARRI.label, count: GARRI.counted, confidence: GARRI.conf },
      ],
      mappings,
      policy,
    );
    assert(classified[0].decision === "auto_apply", "0.98 + verified → auto_apply");
    assert(classified[1].decision === "review" && classified[1].reason === "below_auto_apply_confidence", "0.80 → review queue");
    assert(classified[2].decision === "excluded" && classified[2].reason === "below_review_confidence", "0.50 → excluded");

    // ── Tenant opts in + products with verified mappings ──────────────────
    const [t0] = await world.db
      .select({ settings: schema.tenants.settings })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, TENANT_ID))
      .limit(1);
    const originalSettings = (t0?.settings ?? {}) as Record<string, any>;
    await world.db
      .update(schema.tenants)
      .set({ settings: { ...originalSettings, visualInventoryWhatsAppEnabled: true }, updatedAt: new Date() })
      .where(eq(schema.tenants.id, TENANT_ID));

    for (const p of [RICE, BEANS, GARRI]) {
      await world.db.insert(schema.products).values({
        id: p.id, tenantId: TENANT_ID, sku: `SIM-J106-${p.id}`, name: p.label,
        description: `${p.label} — J106 stock-take item`, category: "sim",
        price: "100.00", currency: "NGN", status: "active",
        stockQuantity: p.startStock, lowStockThreshold: 1,
      }).onConflictDoNothing();
      await world.db.insert(schema.visualInventoryMappings).values({
        id: `map-j106-${p.id}`, tenantId: TENANT_ID, detectedLabel: p.label, productId: p.id, isVerified: true,
      }).onConflictDoNothing();
    }
    // Baseline snapshot for RICE — the variance alert compares against the
    // PREVIOUS snapshot qty (30 → 50 = +66.7% > 20% threshold).
    await world.db.insert(schema.inventorySnapshots).values({
      id: "snap-j106-rice", tenantId: TENANT_ID, productId: RICE.id,
      stockQty: String(RICE.startStock), reservedQty: "0", availableQty: String(RICE.startStock),
      syncSource: "odoo",
    }).onConflictDoNothing();

    // ── Scripted VLM orchestrator (mock mode) ─────────────────────────────
    process.env.VISUAL_INVENTORY_ORCHESTRATOR_URL = "http://orchestrator.sim.local";
    erp.script("orchestrator.sim.local", () => ({
      json: {
        items: [
          { label: RICE.label, count: RICE.counted, confidence: RICE.conf },
          { label: BEANS.label, count: BEANS.counted, confidence: BEANS.conf },
          { label: GARRI.label, count: GARRI.counted, confidence: GARRI.conf },
        ],
        scene_description: "j106 shelf",
        vlm_model_used: "yolo11-sim",
        processing_ms: 9,
      },
    }));

    try {
      // ── 1. Merchant sends the shelf photo via WhatsApp ──────────────────
      const phone = world.newPhone("j106");
      await world.grantConsent(phone);
      scriptMedia("m-j106-shelf", "SIMIMG j106 shelf photo");
      await world.image(phone, "m-j106-shelf");

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
      }, 15000, "j106 stock-take session analysed");

      const [session] = await world.db
        .select()
        .from(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.id, sessionId))
        .limit(1);
      assert(session.source === "whatsapp" && session.tenantId === TENANT_ID, "session tenant-scoped whatsapp source");
      assert(session.status === "review_needed", `mid-confidence item → review_needed (got ${session.status})`);
      const summary = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(summary, `${RICE.counted}× ${RICE.label}`, "counts summary lists rice");
      assertIncludes(summary, "APPLY", "APPLY instruction offered");

      // ── 2. APPLY → high-confidence item auto-applies with a variance
      //       alert; mid-confidence queues for review; excluded untouched ──
      await world.text(phone, "APPLY");
      await world.waitFor(async () => {
        const [p] = await world.db.select().from(schema.products).where(eq(schema.products.id, RICE.id)).limit(1);
        return p?.stockQuantity === RICE.counted;
      }, 15000, "rice auto-applied to stock");

      const [beans] = await world.db.select().from(schema.products).where(eq(schema.products.id, BEANS.id)).limit(1);
      assert(beans.stockQuantity === BEANS.startStock, "review-queue beans NOT applied");
      const [garri] = await world.db.select().from(schema.products).where(eq(schema.products.id, GARRI.id)).limit(1);
      assert(garri.stockQuantity === GARRI.startStock, "excluded garri NOT applied");

      // Variance alert: |+66.7%| > 20% threshold → notification for rice only.
      const notifs = await world.db
        .select()
        .from(schema.merchantNotifications)
        .where(eq(schema.merchantNotifications.tenantId, TENANT_ID))
        .limit(200);
      const variance = notifs.filter((n: any) => n.metadata?.kind === "visual_inventory_variance");
      assert(
        variance.some((n: any) => n.metadata?.productId === RICE.id && n.metadata?.sessionId === sessionId && n.metadata?.variancePct > 20),
        "rice variance alert emitted (> threshold)",
      );
      assert(!variance.some((n: any) => n.metadata?.productId === BEANS.id), "no variance alert for unapplied beans");

      // Review queue: operator notification + session stays review_needed.
      assert(
        notifs.some((n: any) => n.metadata?.kind === "visual_inventory_review_required" && n.metadata?.sessionId === sessionId),
        "operator review_required notification emitted",
      );
      const [after] = await world.db
        .select()
        .from(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.id, sessionId))
        .limit(1);
      assert(after.appliedToInventory === true && after.status === "review_needed", "session applied but still review_needed");
      const updates = (after.inventoryUpdates ?? []) as Array<{ productId: string; newQty: number }>;
      assert(updates.some((u) => u.productId === RICE.id && u.newQty === RICE.counted), "rice inventory update recorded");
      assert(!updates.some((u) => u.productId === BEANS.id || u.productId === GARRI.id), "no updates for queued/excluded items");
    } finally {
      await world.db.delete(schema.visualInventoryMappings)
        .where(inArray(schema.visualInventoryMappings.id, [RICE, BEANS, GARRI].map((p) => `map-j106-${p.id}`)))
        .catch(() => {});
      await world.db.delete(schema.visualInventorySessions)
        .where(eq(schema.visualInventorySessions.tenantId, TENANT_ID))
        .catch(() => {});
      await world.db.delete(schema.inventorySnapshots)
        .where(inArray(schema.inventorySnapshots.productId, [RICE.id, BEANS.id, GARRI.id]))
        .catch(() => {});
      await world.db.delete(schema.merchantNotifications)
        .where(eq(schema.merchantNotifications.tenantId, TENANT_ID))
        .catch(() => {});
      await world.db.delete(schema.products)
        .where(inArray(schema.products.id, [RICE.id, BEANS.id, GARRI.id]))
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
