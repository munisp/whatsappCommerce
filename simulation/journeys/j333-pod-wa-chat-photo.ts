// === W43 dispatch (Coder C) ===
/**
 * J333 — Customer-side POD: with tenants.requirePod ON and the shipment
 * out_for_delivery (the awaiting_pod state), a WhatsApp photo from the buyer
 * is claimed by the POD path (BEFORE visual search), stored, and completes
 * the delivered transition. When the flag is OFF the same photo is NOT
 * claimed (falls through the pre-W43 chain).
 */
import { and, eq } from "drizzle-orm";
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedDispatchOrder, setRequirePod } from "./w43-dispatch-seed";

export const journey: Journey = {
  id: "J333",
  name: "buyer WA photo POD while awaiting_pod",
  feature: "inbound-chat POD capture (awaiting_pod claim) + requirePod gating of delivered",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // ── Flag OFF: buyer photo is NOT claimed as POD (pre-W43 behavior) ──
    const phoneA = world.newPhone("j333a");
    await world.grantConsent(phoneA);
    const seedA = await seedDispatchOrder(world, "j333a", phoneA);
    scriptMedia("m-pod-off", "SIMIMG pod-off");
    await world.image(phoneA, "m-pod-off");
    // Give the async chain a beat; no proof may exist while the flag is off.
    await new Promise((r) => setTimeout(r, 1500));
    const offProofs = await world.db.select().from(schema.deliveryProofs)
      .where(eq(schema.deliveryProofs.orderId, seedA.orderId));
    assert(offProofs.length === 0, "requirePod off → photo not claimed as POD");

    // ── Flag ON: buyer photo completes delivery ──
    const phoneB = world.newPhone("j333b");
    await world.grantConsent(phoneB);
    const seedB = await seedDispatchOrder(world, "j333b", phoneB);
    await setRequirePod(world, true);
    try {
      scriptMedia("m-pod-on", "SIMIMG pod-on");
      await world.image(phoneB, "m-pod-on");

      await world.waitFor(async () => {
        const rows = await world.db.select().from(schema.deliveryProofs)
          .where(and(eq(schema.deliveryProofs.tenantId, TENANT_ID), eq(schema.deliveryProofs.orderId, seedB.orderId)));
        return rows.length > 0;
      }, 15000, "POD row recorded from WA photo");

      const [proof] = await world.db.select().from(schema.deliveryProofs)
        .where(eq(schema.deliveryProofs.orderId, seedB.orderId));
      assert(proof.capturedVia === "whatsapp", "captured via whatsapp");
      assert(proof.idempotencyKey === "wa:m-pod-on", "WA media id is the idempotency key");
      assert((proof.mediaKey ?? "").startsWith(`whatsapp-media/${TENANT_ID}/`), "photo keyed on existing media path");
      assert(proof.mediaUrl === null || proof.mediaUrl!.includes("/api/storage/"), "media URL honest (sim has no MinIO)");

      await world.waitFor(async () => {
        const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seedB.orderId));
        return o?.status === "delivered";
      }, 10000, "order flips to delivered on buyer POD");
      const [shipment] = await world.db.select().from(schema.logisticsShipments)
        .where(eq(schema.logisticsShipments.id, seedB.shipmentId));
      assert(shipment.status === "delivered", "shipment delivered");

      const reply = bodyText(world.outbound.lastOfType("text", phoneB));
      assertIncludes(reply, "Proof of delivery", "buyer gets POD confirmation");
      assertIncludes(reply, seedB.orderNumber, "reply references order");

      // Replay of the same media id must not double-record.
      await world.image(phoneB, "m-pod-on");
      await new Promise((r) => setTimeout(r, 1500));
      const rows = await world.db.select().from(schema.deliveryProofs)
        .where(eq(schema.deliveryProofs.orderId, seedB.orderId));
      assert(rows.length === 1, "same media id replay stays single-proof");
    } finally {
      await setRequirePod(world, false);
    }
  },
};
