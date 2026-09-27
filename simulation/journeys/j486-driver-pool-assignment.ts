/**
 * J486 — the platform-wide driver pool end to end: sign up, verify by email OTP, go online, share
 * location, get picked by a nearby merchant, update delivery status — and the access-boundary guards
 * around it (offline drivers can't be assigned, a driver can't touch a delivery that isn't theirs,
 * cross-tenant assignment is rejected).
 *
 * Replaces the retired per-tenant `riders` table (2026-09-26, user's explicit direction: "let's have
 * our own drivers, they'll have their own apps, then register, switch on their location, then merchant
 * can pick the driver closest to them"). See server/routers/drivers.ts's own header comment.
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, expectTrpcError, publicCaller, tenantCaller } from "./helpers";

const TID = "j486-driver-tenant";
const OTHER_TID = "j486-driver-other-tenant";
const KNOWN_OTP = "482913";

export const journey: Journey = {
  id: "J486",
  name: "platform driver pool: signup, location, nearest-driver assignment, cross-tenant guards",
  feature: "server/routers/drivers.ts",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { hashOtp } = await import("../../server/routers/phoneAuth");
    const now = new Date();
    // Re-run/retry safe: drivers are a real unique-email table, not a fresh-per-journey tenant sandbox.
    const tag = crypto.randomUUID().slice(0, 8);
    const DRIVER_EMAIL = `j486.driver.${tag}@example.com`;

    // ── Merchant tenant + its own location (needed for "nearby") ──────────
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J486 Merchant", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: "48600", role: "owner" }).onConflictDoNothing();
    await approveKyb(world, TID);
    // University of Lagos area, matching the live tenant's own real delivery zone this session traced.
    await world.db.insert(schema.merchantLocations).values({
      tenantId: TID, label: "Main branch", latitude: "6.5158", longitude: "3.3898",
      city: "Lagos", country: "Nigeria", geohash: "s00000", discoverable: false,
    }).onConflictDoNothing();

    // A second tenant, used only for the cross-tenant guard check below.
    await world.db.insert(schema.tenants).values({
      id: OTHER_TID, name: "J486 Other Merchant", slug: OTHER_TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({ tenantId: OTHER_TID, userId: "48601", role: "owner" }).onConflictDoNothing();

    const merchant = await tenantCaller(TID, { userId: 48600 });
    const otherMerchant = await tenantCaller(OTHER_TID, { userId: 48601 });
    const pub = await publicCaller();
    // Set both drivers offline when this journey ends (pass or fail) — "drivers" is genuinely
    // platform-wide and TID's merchant location is a fixed, reused fixture, so a driver left online
    // forever would sit in every future run's "nearby" results indefinitely. The assertions above are
    // already robust to that (ID-based, not count-based) so this is hygiene, not a correctness fix.
    let token: string | null = null;
    let otherToken: string | null = null;

    try {
    // ── Driver signs up, verifies by email OTP (known value seeded directly — same pattern
    // simulation/journeys/j453-phone-uniqueness.ts uses for phoneOtpSessions) ─────────────
    await pub.drivers.signup({ name: "J486 Driver", phone: "+2348011112222", email: DRIVER_EMAIL, vehicleType: "bike" });
    await world.db.update(schema.driverEmailOtpSessions)
      .set({ otpHash: hashOtp(KNOWN_OTP) })
      .where(and(eq(schema.driverEmailOtpSessions.email, DRIVER_EMAIL), eq(schema.driverEmailOtpSessions.purpose, "signup")));
    const wrongOtp = await pub.drivers.verifyOtp({ email: DRIVER_EMAIL, otp: "000000", purpose: "signup" })
      .then(() => { throw new Error("wrong OTP unexpectedly accepted"); })
      .catch((e: any) => e);
    assert(wrongOtp?.message === "Incorrect code.", `wrong OTP rejected (got: ${wrongOtp?.message})`);
    const verified = await pub.drivers.verifyOtp({ email: DRIVER_EMAIL, otp: KNOWN_OTP, purpose: "signup" });
    assert(verified.driver.status === "offline", `driver flips to offline once verified (got ${verified.driver.status})`);
    assert(verified.driver.emailVerifiedAt != null, "emailVerifiedAt stamped");
    token = verified.token;

    // ── Offline driver never appears in "nearby", even with a location on file ────────────
    // Asserts by this driver's OWN id, not array length — "drivers" is a genuinely platform-wide table
    // other journeys (and other runs of this same journey) can leave online drivers in, so an exact
    // count is exactly the "shared tenant state" fragility this session has hit before (J483's
    // cheaper-options fix). TID's merchant location is fixed across runs on purpose (idempotent
    // fixture), so this journey's own past runs are the most likely source of leftover online drivers —
    // asserting properties of THIS driver, not the list's size, is robust to that.
    await pub.drivers.updateLocation({ token, lat: 6.5200, lng: 3.3950 }); // ~0.6km from the merchant
    let nearby = await merchant.drivers.nearby({ tenantId: TID });
    assert(!nearby.some((d) => d.id === verified.driver.id), "offline driver is invisible to nearby search");

    // ── Go online → now visible, ranked by real haversine distance ────────────────────────
    await pub.drivers.goOnline({ token });
    nearby = await merchant.drivers.nearby({ tenantId: TID });
    const self = nearby.find((d) => d.id === verified.driver.id);
    assert(!!self, `online driver appears in nearby (got ${nearby.length} driver(s), none matching)`);
    assert(self!.distanceKm > 0 && self!.distanceKm < 5, `distance is a real, small number (got ${self!.distanceKm})`);

    // ── A real delivery order, assigned to this driver — auto-books the delivery on first use ──
    // Inserted directly rather than via createChatOrderViaNlp: that helper's chat flow always creates
    // the order under the shared "sim-tenant" (simulation/world.ts's TENANT_ID) regardless of which
    // tenant's caller you use afterward — it has no way to target a custom tenant like TID. A direct
    // insert with the same shape bookDelivery needs (metadata.fulfillment + metadata.deliveryQuote.courier,
    // matching what real checkout writes) is the correct tool here, not a chat-flow simulation.
    const phone = world.newPhone("j486buyer");
    await world.grantConsent(phone);
    async function seedDeliveryOrder(suffix: string) {
      const id = crypto.randomUUID();
      const orderNumber = `ORD-J486-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
      await world.db.insert(schema.orders).values({
        id, tenantId: TID, customerId: phone, orderNumber, status: "confirmed",
        totalAmount: "5000.00", currency: "NGN", paymentStatus: "completed",
        metadata: { fulfillment: "delivery", deliveryQuote: { courier: "local_dispatch", quoteId: `j486_${suffix}`, feeCents: 150000 } },
        shippingAddress: { raw: "1 University Rd, Lagos" },
        createdAt: new Date(), updatedAt: new Date(),
      });
      return { orderId: id, orderNumber };
    }
    const order = await seedDeliveryOrder("a");

    // Cross-tenant: the OTHER merchant must not be able to assign against an order that isn't theirs.
    await expectTrpcError(
      otherMerchant.drivers.assign({ tenantId: OTHER_TID, orderId: order.orderId, driverId: verified.driver.id }),
      "NOT_FOUND",
      "cross-tenant assign on someone else's order is rejected",
    );

    const assigned = await merchant.drivers.assign({ tenantId: TID, orderId: order.orderId, driverId: verified.driver.id });
    assert(assigned.assigned === true, "assignment succeeded");
    assert(assigned.driverPhone === "+2348011112222", "assignment returns the driver's real phone for the merchant to coordinate");

    const [delivery] = await world.db.select().from(schema.deliveries)
      .where(and(eq(schema.deliveries.orderId, order.orderId), eq(schema.deliveries.tenantId, TID)));
    assert(delivery?.driverId === verified.driver.id, "deliveries.driver_id set to the assigned driver");
    assert(delivery?.status === "booked", `delivery auto-booked (got ${delivery?.status})`);

    // ── Assigning to an OFFLINE driver is refused ──────────────────────────────────────────
    await pub.drivers.goOffline({ token });
    const secondOrder = await seedDeliveryOrder("b");
    await expectTrpcError(
      merchant.drivers.assign({ tenantId: TID, orderId: secondOrder.orderId, driverId: verified.driver.id }),
      "CONFLICT",
      "offline driver cannot be assigned",
    );
    await pub.drivers.goOnline({ token });

    // ── Driver updates their own delivery's status; cannot touch a delivery that isn't theirs ──
    const otherDriverEmail = `j486.other.driver.${tag}@example.com`;
    await pub.drivers.signup({ name: "Someone Else", phone: "+2348099998888", email: otherDriverEmail });
    await world.db.update(schema.driverEmailOtpSessions)
      .set({ otpHash: hashOtp(KNOWN_OTP) })
      .where(and(eq(schema.driverEmailOtpSessions.email, otherDriverEmail), eq(schema.driverEmailOtpSessions.purpose, "signup")));
    const otherVerified = await pub.drivers.verifyOtp({ email: otherDriverEmail, otp: KNOWN_OTP, purpose: "signup" });
    otherToken = otherVerified.token;

    await expectTrpcError(
      pub.drivers.updateDeliveryStatus({ token: otherVerified.token, deliveryId: delivery!.id, status: "picked_up" }),
      "FORBIDDEN",
      "a driver cannot update a delivery that isn't assigned to them",
    );

    const picked = await pub.drivers.updateDeliveryStatus({ token, deliveryId: delivery!.id, status: "picked_up" });
    assert(picked.transitioned === true && picked.status === "picked_up", `assigned driver CAN update their own delivery (got ${JSON.stringify(picked)})`);

    const myDeliveries = await pub.drivers.myDeliveries({ token });
    assert(myDeliveries.some((d) => d.id === delivery!.id), "myDeliveries lists the assigned delivery");
    } finally {
      if (token) await pub.drivers.goOffline({ token }).catch(() => {});
      if (otherToken) await pub.drivers.goOffline({ token: otherToken }).catch(() => {});
    }
  },
};
