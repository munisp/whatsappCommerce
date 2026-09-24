// === W47 stakeholders ===
/**
 * J455 — ONB-S-10 rider onboarding:
 *   - riders register as PENDING and cannot be assigned until approved;
 *   - approve is claim-first and audited; one rider per (tenant, phone);
 *   - assign binds a delivery to an ACTIVE rider (deliveries.rider_id);
 *   - rider-side status updates require a phone_identity proof matching the
 *     ASSIGNED rider's phone — wrong proofs and unassigned deliveries are
 *     refused.
 */
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, publicCaller, tenantCaller } from "./helpers";
import { seedOrder } from "./w46-uc-docs-seed";
// W47 MERGER: ENV must be imported LAZILY inside run() — a static import
// evaluates server/_core/env BEFORE the sim world's setEnv boot, freezing
// LLM_BASE_URL/PAYSTACK keys at their pre-boot defaults and breaking every
// payment/LLM journey in the shared module graph.

const T = "j455-riders";
const RIDER_PHONE = "+2348070000455";

export const journey: Journey = {
  id: "J455",
  name: "rider register→approve→assign + phone-proof rider updates",
  feature: "W47 stakeholders: ONB-S-10 rider registry",
  async run(world: World) {
    const { ENV } = await import("../../server/_core/env");
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: T, name: "J455 Riders", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "4551", role: "owner",
    }).onConflictDoNothing();
    const owner = await tenantCaller(T, { userId: 4551 });
    const pub = await publicCaller();
    const proofFor = (phone: string) =>
      jwt.sign({ type: "phone_identity", phone }, ENV.jwtSecret, { expiresIn: "15m" });

    // ── 1. Register (pending) + idempotent re-register ──────────────────
    const reg = await owner.riders.register({ tenantId: T, phone: RIDER_PHONE, name: "Rider Emeka", idReference: "NIN-455" });
    assert(reg.rider.status === "pending", "rider starts pending");
    const reg2 = await owner.riders.register({ tenantId: T, phone: RIDER_PHONE, name: "Rider Emeka" });
    assert(reg2.duplicate === true && reg2.rider.id === reg.rider.id, "one rider per (tenant, phone)");

    // ── 2. Delivery for a paid order ────────────────────────────────────
    const order = await seedOrder(world, T, "455a", "2348040001455", { unitPrice: "2000.00", qty: 1 });
    const [delivery] = await world.db.insert(schema.deliveries).values({
      tenantId: T, orderId: order.orderId, courier: "local-dispatch", status: "booked", feeCents: 500,
    }).returning();

    // ── 3. Pending riders cannot be assigned ────────────────────────────
    await expectTrpcError(
      owner.riders.assign({ tenantId: T, deliveryId: delivery.id, riderId: reg.rider.id }),
      "CONFLICT",
      "pending rider cannot be assigned",
    );

    // ── 4. Approve → assign ─────────────────────────────────────────────
    const ap = await owner.riders.approve({ tenantId: T, riderId: reg.rider.id });
    assert(ap.rider.status === "active", "rider approved");
    const ap2 = await owner.riders.approve({ tenantId: T, riderId: reg.rider.id });
    assert(ap2.duplicate === true, "double approve is idempotent");
    const asg = await owner.riders.assign({ tenantId: T, deliveryId: delivery.id, riderId: reg.rider.id });
    assert(asg.assigned === true, "delivery assigned to active rider");
    const [d1] = await world.db.select().from(schema.deliveries).where(eq(schema.deliveries.id, delivery.id));
    assert(d1.riderId === reg.rider.id, "deliveries.rider_id stamped");

    // ── 5. Rider-side update needs the ASSIGNED rider's phone proof ─────
    await expectTrpcError(
      pub.riders.riderUpdate({ deliveryId: delivery.id, status: "picked_up", identityProof: proofFor("+2348000000000") }),
      "FORBIDDEN",
      "wrong-phone proof refused",
    );
    const upd = await pub.riders.riderUpdate({ deliveryId: delivery.id, status: "picked_up", identityProof: proofFor(RIDER_PHONE) });
    assert(upd.transitioned === true && upd.status === "picked_up", "assigned rider updates with proof");
    const delivered = await pub.riders.riderUpdate({ deliveryId: delivery.id, status: "delivered", identityProof: proofFor(RIDER_PHONE) });
    assert(delivered.transitioned === true && delivered.status === "delivered", "rider marks delivered");
    const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId));
    assert(o.status === "delivered", "order flips delivered via the rider update");

    // ── 6. Unassigned delivery refuses rider updates ────────────────────
    const order2 = await seedOrder(world, T, "455b", "2348040002455", { unitPrice: "1500.00", qty: 1 });
    const [d2] = await world.db.insert(schema.deliveries).values({
      tenantId: T, orderId: order2.orderId, courier: "local-dispatch", status: "booked", feeCents: 500,
    }).returning();
    await expectTrpcError(
      pub.riders.riderUpdate({ deliveryId: d2.id, status: "picked_up", identityProof: proofFor(RIDER_PHONE) }),
      "PRECONDITION_FAILED",
      "unassigned delivery refuses rider updates",
    );

    // Audit trail covers the lifecycle.
    const audits = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.tenantId, T));
    for (const action of ["rider.registered", "rider.approved", "rider.assigned", "rider.statusUpdate"]) {
      assert(audits.some((a: any) => a.action === action), `audit row for ${action}`);
    }
  },
};
