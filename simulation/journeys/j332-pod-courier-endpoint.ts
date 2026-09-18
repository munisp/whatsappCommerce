// === W43 dispatch (Coder C) ===
/**
 * J332 — Courier POD capture via POST /api/delivery/proof: token auth fails
 * closed, base64 photo stored on the existing WA media path, idempotent
 * replay, delivered transition completes (order + shipment + escrow seam),
 * buyer notified, POD visible on the public tracking timeline.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedDispatchOrder, setRequirePod } from "./w43-dispatch-seed";

export const journey: Journey = {
  id: "J332",
  name: "courier POD endpoint → delivered + timeline",
  feature: "POST /api/delivery/proof (auth, idempotency, media storage, delivered completion)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j332");
    await world.grantConsent(phone);
    const seed = await seedDispatchOrder(world, "j332", phone);
    const COURIER_TOKEN = "sim-courier-token-j332";
    await world.patchTenantSettings({ dispatch: { courierToken: COURIER_TOKEN } });
    await setRequirePod(world, true);
    try {
      // ── Auth fails closed: no/wrong token → 401 ──
      const unauth = await fetch(`${world.baseUrl}/api/delivery/proof`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: TENANT_ID, orderId: seed.orderId, imageBase64: Buffer.from("POD").toString("base64") }),
      });
      assert(unauth.status === 401, `no token must be 401, got ${unauth.status}`);

      // ── Valid capture → proof row + delivered ──
      const imgB64 = Buffer.from("SIM-POD-PHOTO-j332").toString("base64");
      const res = await fetch(`${world.baseUrl}/api/delivery/proof`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-delivery-proof-token": COURIER_TOKEN },
        body: JSON.stringify({
          tenantId: TENANT_ID,
          orderId: seed.orderId,
          type: "photo",
          imageBase64: imgB64,
          mimeType: "image/jpeg",
          capturedByDriverId: "drv-1",
          idempotencyKey: `pod-j332-${seed.orderId}`,
        }),
      });
      assert(res.status === 200, `proof POST must be 200, got ${res.status}`);
      const body = (await res.json()) as any;
      assert(body.ok === true && body.proofId, "proofId returned");
      assert(body.delivered === true, "order completes to delivered");
      // Sim has no MinIO: mediaUrl is the /api/storage/ URL when object
      // storage is up, null after the documented non-fatal degrade — the
      // tenant-scoped mediaKey is always recorded either way.
      assert(body.mediaUrl === null || String(body.mediaUrl).includes("/api/storage/"), "mediaUrl honest (stored or degraded-null)");

      const [proof] = await world.db.select().from(schema.deliveryProofs)
        .where(and(eq(schema.deliveryProofs.tenantId, TENANT_ID), eq(schema.deliveryProofs.orderId, seed.orderId)));
      assert(proof, "delivery_proofs row created");
      assert(proof.type === "photo" && proof.capturedVia === "endpoint", "endpoint photo recorded");
      assert(proof.capturedByDriverId === "drv-1", "driver id recorded");
      assert(proof.shipmentId === seed.shipmentId, "shipment linked");
      assert((proof.mediaKey ?? "").startsWith(`whatsapp-media/${TENANT_ID}/`), "media key on the existing WA media path");

      const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seed.orderId));
      assert(order.status === "delivered", `order delivered (got ${order.status})`);
      const [shipment] = await world.db.select().from(schema.logisticsShipments).where(eq(schema.logisticsShipments.id, seed.shipmentId));
      assert(shipment.status === "delivered" && shipment.deliveredAt, "shipment delivered + stamped");

      // ── Idempotent replay: same key → duplicate, no second row ──
      const replay = await fetch(`${world.baseUrl}/api/delivery/proof`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-delivery-proof-token": COURIER_TOKEN },
        body: JSON.stringify({
          tenantId: TENANT_ID, orderId: seed.orderId, type: "photo",
          imageBase64: imgB64, idempotencyKey: `pod-j332-${seed.orderId}`,
        }),
      });
      const replayBody = (await replay.json()) as any;
      assert(replayBody.duplicate === true && replayBody.proofId === body.proofId, "replay returns original proof");
      const all = await world.db.select().from(schema.deliveryProofs).where(eq(schema.deliveryProofs.orderId, seed.orderId));
      assert(all.length === 1, `exactly one proof row (got ${all.length})`);

      // ── Buyer notified (delivered confirmation) ──
      await world.waitFor(() => {
        const t = world.outbound.lastOfType("text", phone);
        return !!t && bodyText(t).includes("delivered");
      }, 10000, "buyer delivered notification");
      const notif = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(notif, seed.orderNumber, "notification references order number");

      // ── POD visible on the public tracking timeline ──
      const { generateTrackingToken } = await import("../../server/services/trackingToken");
      const { appRouter } = await import("../../server/routers");
      const caller = appRouter.createCaller({ user: null, res: { clearCookie: () => {} } } as any);
      const view = await caller.tracking.getByToken({ token: generateTrackingToken(seed.orderId) });
      assert(view.deliveryProof, "deliveryProof on tracking timeline");
      assert(view.deliveryProof!.type === "photo", "timeline proof type");
      assert(view.deliveryProof!.mediaUrl === null || view.deliveryProof!.mediaUrl!.includes("/api/storage/"), "timeline media URL honest");
      assert(view.shipment?.history.some((h) => h.status === "pod_captured"), "timeline history has pod_captured event");
    } finally {
      await setRequirePod(world, false);
    }
  },
};
