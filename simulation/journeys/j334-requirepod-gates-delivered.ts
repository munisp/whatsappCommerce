// === W43 dispatch (Coder C) ===
/**
 * J334 — tenants.requirePod gates BOTH delivered transitions: the dashboard
 * simulateDelivery tRPC mutation refuses with PRECONDITION_FAILED and the
 * shipbubble carrier webhook holds the shipment at out_for_delivery
 * (podRequired:true) until a delivery_proofs row exists. Flag OFF (default)
 * keeps the pre-W43 behavior (delivered proceeds with no proof).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedDispatchOrder, setRequirePod } from "./w43-dispatch-seed";

function adminCaller(ctx: { user?: any } = {}) {
  return import("../../server/routers").then(({ appRouter }) =>
    appRouter.createCaller({
      user: ctx.user ?? {
        id: 1, openId: "sim-admin-j334", email: "admin@sim.local", name: "Sim Admin",
        loginMethod: "keycloak", role: "admin",
        createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
      },
      res: { clearCookie: () => {} },
    } as any));
}

export const journey: Journey = {
  id: "J334",
  name: "requirePod gates delivered (tRPC + carrier webhook)",
  feature: "tenants.requirePod delivered-transition gate, default off",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // ── Flag OFF (default): delivered proceeds with no POD (pre-W43) ──
    const phoneA = world.newPhone("j334a");
    await world.grantConsent(phoneA);
    const seedA = await seedDispatchOrder(world, "j334a", phoneA);
    const callerA = await adminCaller();
    const updatedA = await callerA.logistics.simulateDelivery({ shipmentId: seedA.shipmentId, status: "delivered" });
    assert(updatedA.status === "delivered", "flag off → simulateDelivery delivered unchanged");

    // ── Flag ON: both transitions refuse until POD exists ──
    const phoneB = world.newPhone("j334b");
    await world.grantConsent(phoneB);
    const seedB = await seedDispatchOrder(world, "j334b", phoneB);
    await setRequirePod(world, true);
    try {
      const callerB = await adminCaller();
      let refused = "";
      try {
        await callerB.logistics.simulateDelivery({ shipmentId: seedB.shipmentId, status: "delivered" });
      } catch (e: any) {
        refused = `${e?.code ?? ""}:${e?.message ?? ""}`;
      }
      assert(refused.includes("PRECONDITION_FAILED"), `tRPC delivered must refuse, got: ${refused || "(no throw)"}`);
      assert(refused.toLowerCase().includes("proof of delivery"), "refusal explains the POD requirement");
      let [sh] = await world.db.select().from(schema.logisticsShipments).where(eq(schema.logisticsShipments.id, seedB.shipmentId));
      assert(sh.status === "out_for_delivery", "shipment stays out_for_delivery after tRPC refusal");

      // Carrier webhook "delivered" → held at out_for_delivery, podRequired.
      const hook = await fetch(`${world.baseUrl}/api/webhooks/shipbubble`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tracking_number: seedB.trackingId, event: "shipment.delivered" }),
      });
      assert(hook.status === 200, `webhook 200, got ${hook.status}`);
      const hookBody = (await hook.json()) as any;
      assert(hookBody.podRequired === true, "webhook reports podRequired");
      [sh] = await world.db.select().from(schema.logisticsShipments).where(eq(schema.logisticsShipments.id, seedB.shipmentId));
      assert(sh.status === "out_for_delivery", `webhook holds out_for_delivery (got ${sh.status})`);
      const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seedB.orderId));
      assert(ord.status !== "delivered", "order NOT delivered without POD");

      // Record POD → webhook replay now completes the transition.
      const { getDb } = await import("../../server/db");
      const db = (await getDb())!;
      const { recordDeliveryProof } = await import("../../server/services/deliveryProof");
      const rec = await recordDeliveryProof(db, {
        tenantId: TENANT_ID,
        orderId: seedB.orderId,
        type: "photo",
        mediaBuffer: Buffer.from("SIM-POD-j334"),
        mimeType: "image/jpeg",
        capturedVia: "endpoint",
        idempotencyKey: `pod-j334-${seedB.orderId}`,
      });
      assert(rec.delivered === true, "POD completes delivery");
      [sh] = await world.db.select().from(schema.logisticsShipments).where(eq(schema.logisticsShipments.id, seedB.shipmentId));
      assert(sh.status === "delivered" && sh.deliveredAt, "shipment delivered after POD");
    } finally {
      await setRequirePod(world, false);
    }
  },
};
