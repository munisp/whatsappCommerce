/**
 * J121 — E3 full-stack integration executed THROUGH the W23 journey
 * orchestrator (local-fallback mode: TEMPORAL_ADDRESS unset in the sim).
 *
 * Orchestrated sequence (j121-fullstack registry — every activity calls an
 * existing platform service):
 *   discoverCatalog (inventory.checkAvailability)
 *   → createOrder (offlineOrders.createOfflineOrder)
 *   → creditFacilityPd (tradeCredit.suggestLimitTx PD score +
 *     creditFacilities.createFacility)
 *   → visualInventoryDecrement (visualInventoryApply.applyVisualCounts)
 *   → complianceAudit (auditChain.appendAuditEventTx + verifyAuditChain)
 *
 * Asserts:
 *   1. inline run completes with 5 checkpoints, deterministic idempotency
 *      keys, final status completed in temporal_workflow_runs.
 *   2. end state: order created, stock decremented, PD-scored facility.
 *   3. the tenant's compliance audit chain CONTAINS the orchestration
 *      events and still verifies.
 *   4. deferred run + cron tick (/api/scheduled/journey-orchestrate-tick)
 *      resumes and completes it (durable resume path).
 */
import { and, eq } from "drizzle-orm";
import { PRODUCTS, TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J121",
  name: "orchestrated full-stack (discovery → order → PD credit → VI → audit)",
  feature: "journey orchestrator local-fallback: checkpoints, durable resume via cron tick, compliance audit chain",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    assert(!process.env.TEMPORAL_ADDRESS, "J121 requires local-fallback mode (TEMPORAL_ADDRESS unset)");
    const { FULLSTACK_JOURNEY_ID } = await import("../../server/services/journeyOrchestrator.journeys");

    const caller = await tenantCaller(TENANT_ID, { userId: 1210 });

    // Cross-tenant guard on the orchestrator entry point.
    await expectTrpcError(
      caller.orchestrator.start({ journeyId: FULLSTACK_JOURNEY_ID, tenantId: "someone-else", params: {}, deferExecution: false }),
      "FORBIDDEN",
      "orchestrator.start cross-tenant",
    );

    const buyerPhone = world.newPhone("fs");
    const productId = PRODUCTS.jollof.id;
    const stocktakeId = PRODUCTS.ankara.id;
    const [before] = await world.db.select().from(schema.products).where(eq(schema.products.id, stocktakeId)).limit(1);
    const qty = 3;

    // ── 1. Inline orchestrated run ────────────────────────────────────────
    const started = await caller.orchestrator.start({
      journeyId: FULLSTACK_JOURNEY_ID,
      tenantId: TENANT_ID,
      params: {
        productId,
        stocktakeProductId: stocktakeId,
        quantity: qty,
        customerPhone: buyerPhone,
        customerName: "J121 Fullstack Buyer",
        buyerTenantId: TENANT_ID,
        supplierTenantId: TENANT_ID,
        lenderName: "J121 Orchestrated Lender",
      },
      deferExecution: false,
    });
    assert(started.mode === "local-fallback", `local-fallback mode (got ${started.mode})`);
    assert(started.status === "completed", `orchestration completed (got ${started.status}: ${started.error ?? ""})`);
    assert(started.executed.length === 5, `all five activities executed (got ${started.executed.join(",")})`);

    // Orchestrator checkpoints persisted + final state.
    const [run] = await world.db
      .select()
      .from(schema.temporalWorkflowRuns)
      .where(eq(schema.temporalWorkflowRuns.runId, started.runId))
      .limit(1);
    assert(run, "orchestration run recorded in temporal_workflow_runs");
    assert(run.workflowType === "JourneyOrchestrationWorkflow", "workflow type recorded");
    assert(run.status === "completed", "run completed");
    const result = run.result as any;
    const names = result.checkpoints.map((c: any) => c.name);
    assert(
      JSON.stringify(names) === JSON.stringify(["discoverCatalog", "createOrder", "creditFacilityPd", "visualInventoryDecrement", "complianceAudit"]),
      `checkpoint sequence (got ${names.join(",")})`,
    );
    for (const c of result.checkpoints) {
      assert(c.key === `${started.runId}:${c.name}`, `deterministic idempotency key for ${c.name}`);
    }

    // ── 2. End state: order, PD-scored facility, stock decrement ──────────
    const orderId = result.checkpoints.find((c: any) => c.name === "createOrder")?.output?.orderId;
    assert(orderId, "order id in createOrder checkpoint");
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    assert(order && order.tenantId === TENANT_ID, "order created for the tenant");

    const facilityOut = result.checkpoints.find((c: any) => c.name === "creditFacilityPd")?.output;
    assert(facilityOut?.facilityId, "facility created");
    assert(typeof facilityOut.pd === "number" && facilityOut.pd >= 0 && facilityOut.pd <= 1,
      `PD score present (got ${facilityOut?.pd})`);
    assert(facilityOut.pdSource === "ml" || facilityOut.pdSource === "rules", "pdSource recorded");

    const viOut = result.checkpoints.find((c: any) => c.name === "visualInventoryDecrement")?.output;
    assert(viOut?.newQty === Number(before.stockQuantity) - qty,
      `visual inventory decrement ${before.stockQuantity} → ${Number(before.stockQuantity) - qty} (got ${viOut?.newQty})`);
    const [after] = await world.db.select().from(schema.products).where(eq(schema.products.id, stocktakeId)).limit(1);
    assert(Number(after.stockQuantity) === Number(before.stockQuantity) - qty, "product stock decremented");
    // The order itself reserved its units on the ordered product.
    const [ordered] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(Number(ordered.stockQuantity) === PRODUCTS.jollof.stock - qty, "order reserved its stock");

    // ── 3. Compliance audit chain contains the events ─────────────────────
    const auditOut = result.checkpoints.find((c: any) => c.name === "complianceAudit")?.output;
    assert(auditOut?.verified === true, "audit chain verifies");
    const auditRows = await world.db
      .select()
      .from(schema.auditChain)
      .where(eq(schema.auditChain.tenantId, TENANT_ID));
    const eventTypes = auditRows.map((r: any) => r.eventType);
    for (const t of ["orchestration.catalog_discovered", "orchestration.order_created", "orchestration.credit_facility_created", "orchestration.inventory_decremented"]) {
      assert(eventTypes.includes(t), `audit chain contains ${t}`);
    }
    const orderEvent = auditRows.find((r: any) => r.eventType === "orchestration.order_created");
    assert((orderEvent.payload as any)?.orderId === orderId, "audit order event carries the order id");

    // ── 4. Durable resume: deferred run completed by the cron tick ────────
    const deferred = await caller.orchestrator.start({
      journeyId: FULLSTACK_JOURNEY_ID,
      tenantId: TENANT_ID,
      params: {
        productId: PRODUCTS.chicken.id,
        quantity: 1,
        customerPhone: world.newPhone("fd"),
        customerName: "J121 Deferred Buyer",
        buyerTenantId: TENANT_ID,
        supplierTenantId: TENANT_ID,
        lenderName: "J121 Orchestrated Lender",
      },
      deferExecution: true,
    });
    assert(deferred.status === "running", "deferred run recorded as running");
    const statusBefore = await caller.orchestrator.status({ runId: deferred.runId });
    assert(statusBefore.checkpointCount === 0, "no checkpoints before the tick");

    const tick = await world.runCron("/api/scheduled/journey-orchestrate-tick");
    assert(tick.status === 200, `tick endpoint accepted (got ${tick.status})`);
    assert(tick.json?.ok === true, "tick ok");

    const statusAfter = await caller.orchestrator.status({ runId: deferred.runId });
    assert(statusAfter.status === "completed", `deferred run completed by the tick (got ${statusAfter.status})`);
    assert(statusAfter.checkpointCount === 5, "deferred run checkpointed all five activities");
    const history = await caller.orchestrator.history({ runId: deferred.runId });
    assert(history.checkpoints.length === 5, "history exposes the full checkpoint trail");

    // Cross-tenant reads are forbidden.
    const admin = await adminCaller();
    const intruderTenant = await admin.onboarding.start({ name: "J121 Intruder" });
    const intruder = await tenantCaller(intruderTenant.tenantId, { userId: 1211 });
    await expectTrpcError(intruder.orchestrator.status({ runId: deferred.runId }), "FORBIDDEN", "cross-tenant status");
    await expectTrpcError(intruder.orchestrator.history({ runId: deferred.runId }), "FORBIDDEN", "cross-tenant history");
  },
};
