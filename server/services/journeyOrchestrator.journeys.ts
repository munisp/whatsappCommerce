/**
 * server/services/journeyOrchestrator.journeys.ts — built-in orchestration
 * definitions for the journey orchestrator (W23).
 *
 * Each activity is a THIN ADAPTER over an existing platform service:
 *   - inventory.checkAvailability      (customer discovery)
 *   - offlineOrders.createOfflineOrder (order capture)
 *   - tradeCredit.suggestLimitTx       (PD-scored limit) +
 *     creditFacilities.createFacility  (facility provisioning)
 *   - visualInventoryApply.applyVisualCounts (visual inventory decrement)
 *   - auditChain.appendAuditEventTx / verifyAuditChain (compliance chain)
 *
 * Registration is lazy + idempotent (services snapshot env at import time in
 * the sim harness, so all service imports happen INSIDE each activity run()).
 */
import {
  registerJourneyOrchestration,
  type OrchestrationActivity,
} from "./journeyOrchestrator";

export const FULLSTACK_JOURNEY_ID = "j121-fullstack";

let registered = false;

/** Idempotent registration of all built-in orchestrations. */
export function ensureBuiltinOrchestrations(): void {
  if (registered) return;
  registered = true;

  const discoverCatalog: OrchestrationActivity = {
    name: "discoverCatalog",
    async run(ctx) {
      const { checkAvailability } = await import("./inventory");
      const productId = String(ctx.params.productId);
      const quantity = Number(ctx.params.quantity ?? 1);
      const availability = await checkAvailability(ctx.db, ctx.tenantId!, [
        { productId, qty: quantity },
      ] as any);
      return { productId, quantity, availability };
    },
  };

  const createOrder: OrchestrationActivity = {
    name: "createOrder",
    async run(ctx) {
      const { createOfflineOrder } = await import("./offlineOrders");
      const order = await createOfflineOrder(ctx.db, {
        tenantId: ctx.tenantId!,
        customerName: String(ctx.params.customerName ?? "Orchestrated Buyer"),
        customerPhone: String(ctx.params.customerPhone),
        items: [{ productId: String(ctx.params.productId), qty: Number(ctx.params.quantity ?? 1) }],
        paymentMethod: "transfer",
        note: `orchestrated:${ctx.idempotencyKey}`,
      });
      return { orderId: (order as any).orderId ?? (order as any).id ?? null, orderNumber: (order as any).orderNumber ?? null, total: (order as any).total ?? null };
    },
  };

  const creditFacilityPd: OrchestrationActivity = {
    name: "creditFacilityPd",
    async run(ctx) {
      const { suggestLimitTx } = await import("./tradeCredit/scoring");
      const { createFacility, getFacilityByRef, FacilityRefExistsError } = await import("./creditFacilities/facilities");
      const buyerTenantId = String(ctx.params.buyerTenantId ?? ctx.tenantId);
      const supplierTenantId = String(ctx.params.supplierTenantId ?? ctx.tenantId);
      const scored = await suggestLimitTx(ctx.db as any, buyerTenantId, supplierTenantId);
      const facilityRef = `orch-${ctx.idempotencyKey}`.slice(0, 120);
      let facility;
      try {
        facility = await createFacility(ctx.db as any, {
          lenderName: String(ctx.params.lenderName ?? "Orchestrated Lender"),
          facilityRef,
          commitmentCents: Math.max(0, Math.round(scored.suggestedLimitCents)),
          currency: "NGN",
        });
      } catch (err: any) {
        // Idempotent re-entry: a replayed activity reuses the same facility.
        if (err instanceof FacilityRefExistsError || /exists/i.test(String(err?.message))) {
          facility = await getFacilityByRef(ctx.db as any, facilityRef);
        } else {
          throw err;
        }
      }
      return {
        facilityId: facility?.id ?? null,
        facilityRef,
        score: scored.score,
        suggestedLimitCents: scored.suggestedLimitCents,
        pd: scored.pd ?? null,
        pdSource: scored.pdSource ?? null,
        termsBand: (scored as any).terms?.band ?? null,
      };
    },
  };

  const visualInventoryDecrement: OrchestrationActivity = {
    name: "visualInventoryDecrement",
    async run(ctx) {
      const { applyVisualCounts, VI_POLICY_DEFAULTS } = await import("./visualInventoryApply");
      const { products } = await import("../../drizzle/schema");
      const { and, eq } = await import("drizzle-orm");
      // The stocktake target defaults to the ordered product but can be
      // overridden (the order flow already reserves its own stock).
      const productId = String(ctx.params.stocktakeProductId ?? ctx.params.productId);
      const quantity = Number(ctx.params.quantity ?? 1);
      const [product] = await ctx.db
        .select()
        .from(products)
        .where(and(eq(products.id, productId), eq(products.tenantId, ctx.tenantId!)))
        .limit(1);
      if (!product) throw new Error(`product ${productId} not found for tenant`);
      const newQty = Math.max(0, Number(product.stockQuantity ?? 0) - quantity);
      const applied = await applyVisualCounts(ctx.db as any, {
        tenantId: ctx.tenantId!,
        sessionId: ctx.idempotencyKey,
        items: [{ detectedLabel: product.name, confirmedCount: newQty, productId }],
        policy: VI_POLICY_DEFAULTS,
      });
      return { productId, oldQty: Number(product.stockQuantity ?? 0), newQty, applied: applied.applied, errors: applied.errors };
    },
  };

  const complianceAudit: OrchestrationActivity = {
    name: "complianceAudit",
    async run(ctx) {
      const { appendAuditEventTx, verifyAuditChain } = await import("./auditChain");
      const order = ctx.outputs.createOrder as any;
      const facility = ctx.outputs.creditFacilityPd as any;
      const inventory = ctx.outputs.visualInventoryDecrement as any;
      const events = [
        { eventType: "orchestration.catalog_discovered", payload: ctx.outputs.discoverCatalog ?? null },
        { eventType: "orchestration.order_created", payload: { orderId: order?.orderId, orderNumber: order?.orderNumber } },
        { eventType: "orchestration.credit_facility_created", payload: { facilityId: facility?.facilityId, pd: facility?.pd, pdSource: facility?.pdSource } },
        { eventType: "orchestration.inventory_decremented", payload: { productId: inventory?.productId, oldQty: inventory?.oldQty, newQty: inventory?.newQty } },
      ];
      const ids: string[] = [];
      for (const e of events) {
        const row = await appendAuditEventTx(ctx.db as any, {
          tenantId: ctx.tenantId,
          eventType: e.eventType,
          actorId: `orchestrator:${ctx.runId}`,
          payload: e.payload as Record<string, unknown>,
        });
        ids.push(row.id);
      }
      const verification = await verifyAuditChain(ctx.db as any, { tenantId: ctx.tenantId });
      return { eventIds: ids, verified: verification.ok, rowsChecked: verification.rowsChecked };
    },
  };

  registerJourneyOrchestration(FULLSTACK_JOURNEY_ID, [
    discoverCatalog,
    createOrder,
    creditFacilityPd,
    visualInventoryDecrement,
    complianceAudit,
  ]);
}
