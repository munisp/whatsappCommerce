/**
 * J177 — W30 screening/guard rails:
 *   1. Fraud screening BLOCKS a high-risk payment before the ledger reserve.
 *   2. payment.confirm fails CLOSED on an inconclusive provider probe; the
 *      admin override requires step-up (rejected without it).
 *   3. Geo discovery is KYB fail-closed: an unverified merchant is excluded.
 *   4. SSRF guard: odoo.testConnection + custom provider config reject
 *      private/link-local baseUrls.
 *   5. Mojaloop callback rejects missing FSPIOP headers by DEFAULT
 *      (validation default-on).
 *   6. Delivery PIN: hashed storage, timing-safe verify, 5/day attempt cap.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import {
  adminCaller, approveKyb, expectTrpcError, publicCaller, resetGeoDiscovery,
  seedOrderForInitiate, tenantCaller,
} from "./helpers";

export const journey: Journey = {
  id: "J177",
  name: "fraud block + confirm fail-closed + geo fail-closed + SSRF + mojaloop + PIN cap",
  feature: "payment screening guards + ssrfGuard + mojaloop JWS default-on + delivery PIN hardening",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await tenantCaller(TENANT_ID, { userId: 1771 });
    const admin = await adminCaller();

    // ── 1. Fraud block before ledger reserve ────────────────────────────
    await seedOrderForInitiate(world, { orderId: "j177-o1", tenantId: TENANT_ID, amountMajor: 600_000 });
    const fraudErr = await expectTrpcError(
      caller.payment.initiate({
        tenantId: TENANT_ID, orderId: "j177-o1", amount: 600_000,
        provider: "paystack", customerPhone: "123", // >₦500k + bad phone → high risk
      }),
      "PRECONDITION_FAILED",
      "high-risk payment blocked",
    );
    assert(/fraud/i.test(fraudErr.message), `rejection cites fraud screening (${fraudErr.message})`);
    const [blockedIntent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.orderId, "j177-o1"));
    assert(blockedIntent?.status === "failed", "blocked intent marked failed");
    assert(blockedIntent?.failureReason === "fraud_screening_blocked", `failure reason recorded (${blockedIntent?.failureReason})`);
    assert(!blockedIntent?.ledgerPendingId, "no ledger reserve happened before the block");

    // ── 2. payment.confirm fail-closed + override requires step-up ──────
    const ref = `PAY-J177-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.paymentIntents).values({
      id: randomUUID(), tenantId: TENANT_ID, orderId: "j177-o1",
      amount: "1000.00", currency: "NGN", provider: "paystack",
      providerPaymentId: ref, idempotencyKey: `j177:${ref}`,
      status: "pending", customerId: "cust-j177",
    });
    const probeErr = await expectTrpcError(
      admin.payment.confirm({ reference: ref, providerStatus: "success" }),
      "PRECONDITION_FAILED",
      "inconclusive probe fails closed",
    );
    assert(/inconclusive|probe/i.test(probeErr.message), `rejection cites probe (${probeErr.message})`);
    const overrideErr = await expectTrpcError(
      admin.payment.confirm({
        reference: ref, providerStatus: "success",
        overrideReason: "Provider dashboard manually verified by ops",
      }),
      "PRECONDITION_FAILED",
      "override without step-up rejected",
    );
    assert(/step-up/i.test(overrideErr.message), `override rejection cites step-up (${overrideErr.message})`);

    // ── 3. Geo discovery KYB fail-closed ────────────────────────────────
    await resetGeoDiscovery(world);
    const GEO_TID = "j177-geo-tenant";
    await world.db.insert(schema.tenants).values({
      id: GEO_TID, name: "J177 Geo", slug: GEO_TID, status: "active",
    }).onConflictDoNothing();
    const geoCaller = await tenantCaller(GEO_TID, { userId: 1772 });
    await geoCaller.geo.merchant.setLocation({ latitude: 6.5244, longitude: 3.3792, serviceRadiusKm: 10 });
    await geoCaller.geo.merchant.setDiscoverable({ discoverable: true });
    const pub = await publicCaller();
    let res = await pub.geo.discover({ lat: 6.5244, lng: 3.3792 });
    assert(!res.items.some((i: any) => i.tenantId === GEO_TID), "unverified merchant excluded (fail closed)");
    await approveKyb(world, GEO_TID);
    res = await pub.geo.discover({ lat: 6.5244, lng: 3.3792 });
    assert(res.items.some((i: any) => i.tenantId === GEO_TID), "verified merchant discoverable");

    // ── 4. SSRF guard ────────────────────────────────────────────────────
    await expectTrpcError(
      caller.odoo.testConnection({
        baseUrl: "http://169.254.169.254/latest/meta-data",
        database: "db", username: "u", apiKey: "k",
      }),
      "BAD_REQUEST",
      "odoo link-local baseUrl rejected",
    );
    await expectTrpcError(
      caller.paymentGateway.configureProvider({
        tenantId: TENANT_ID, provider: "custom", instructions: "settle to sim bank",
        customConfig: { baseUrl: "http://127.0.0.1:8080" },
      }),
      "BAD_REQUEST",
      "custom provider loopback baseUrl rejected",
    );

    // ── 5. Mojaloop callback: validation default-on, fail closed ────────
    {
      const prev = process.env.MOJALOOP_VALIDATE_SIG;
      delete process.env.MOJALOOP_VALIDATE_SIG; // unset → validation ON (W30)
      try {
        const res = await fetch(`${world.baseUrl}/api/callbacks/mojaloop/transfers/j177-x`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transferState: "COMMITTED", fulfilment: "x" }),
        });
        assert(res.status === 401, `mojaloop without FSPIOP headers → 401 by default (got ${res.status})`);
      } finally {
        if (prev === undefined) delete process.env.MOJALOOP_VALIDATE_SIG;
        else process.env.MOJALOOP_VALIDATE_SIG = prev;
      }
    }

    // ── 6. Delivery PIN: cap + hashed storage ───────────────────────────
    {
      const { hashDeliveryPin, isHashedDeliveryPin } = await import("../../server/routers/logistics");
      await seedOrderForInitiate(world, { orderId: "j177-o2", tenantId: TENANT_ID, amountMajor: 500 });
      const shipmentId = randomUUID();
      await world.db.insert(schema.logisticsShipments).values({
        id: shipmentId, orderId: "j177-o2", tenantId: TENANT_ID,
        provider: "shipbubble", status: "out_for_delivery",
        deliveryPin: hashDeliveryPin("4321", shipmentId),
      });
      const [stored] = await world.db.select().from(schema.logisticsShipments)
        .where(eq(schema.logisticsShipments.id, shipmentId));
      assert(stored.deliveryPin && isHashedDeliveryPin(stored.deliveryPin) && !stored.deliveryPin.includes("4321"),
        "PIN stored hashed, never plaintext");

      for (let i = 1; i <= 5; i++) {
        await expectTrpcError(
          caller.logistics.simulateDelivery({ shipmentId, status: "delivered", pin: "9999" }),
          "FORBIDDEN",
          `wrong PIN attempt ${i}`,
        );
      }
      await expectTrpcError(
        caller.logistics.simulateDelivery({ shipmentId, status: "delivered", pin: "9999" }),
        "TOO_MANY_REQUESTS",
        "6th PIN attempt capped",
      );
      // Even the CORRECT PIN is locked out for the rest of the day.
      await expectTrpcError(
        caller.logistics.simulateDelivery({ shipmentId, status: "delivered", pin: "4321" }),
        "TOO_MANY_REQUESTS",
        "correct PIN still capped after 5 failures",
      );
      const [after] = await world.db.select().from(schema.logisticsShipments)
        .where(eq(schema.logisticsShipments.id, shipmentId));
      assert(after.status === "out_for_delivery", "shipment never transitioned on failed PINs");
    }
  },
};
