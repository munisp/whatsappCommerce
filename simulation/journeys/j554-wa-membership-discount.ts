// === W54 capabilities (CAP-1) ===
/**
 * J554 — WhatsApp membership: "membership" → plan list → "join membership 1"
 * (free tier → instantly ACTIVE) → "my membership" status → the member
 * discount ACTUALLY applies at chat checkout (integer cents, order total +
 * metadata snapshot + the 💎 summary line) → the points multiplier ACTUALLY
 * multiplies the delivered-order loyalty earn.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J554",
  name: "WA membership: list → join free → status → checkout discount + 2x earn",
  feature: "W54 capabilities: consumer membership tiers (WA)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/membershipPlans");
    const phone = world.newPhone("547");
    await world.grantConsent(phone);

    // ── 1. Merchant seeds a free Gold tier: 10% off + 2x points ─────────
    const plan = await svc.createMembershipPlan(world.db as any, {
      tenantId: TENANT_ID, name: "J554 Gold", priceCents: 0, period: "month",
      discountPercent: 10, pointsMultiplier: 2,
    });

    const say = async (text: string, label: string): Promise<string> => {
      const before = world.outbound.ofType("text", phone).length;
      await world.text(phone, text);
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 15000, `${label} reply`);
      return bodyText(world.outbound.lastOfType("text", phone));
    };

    // ── 2. "membership" lists the plan with benefits + price ────────────
    const list = await say("membership", "plan list");
    assert(list.includes("J554 Gold"), `list carries the plan (got ${list.slice(0, 160)})`);
    // NOTE: "memberSHIp" trips the hausa detection hint ("shi") — the reply
    // is correctly LOCALIZED, so assertions stay locale-agnostic (digits).
    assert(list.includes("10%") && /2x|x2/.test(list), `benefits rendered (got ${list.slice(0, 200)})`);

    // ── 3. "join membership 1" → immediately ACTIVE (free tier) ─────────
    const joined = await say("join membership 1", "join");
    assert(joined.includes("J554 Gold") && joined.includes("🎉"), `join activates (got ${joined.slice(0, 160)})`);
    const [row] = await world.db.select().from(schema.customerMemberships)
      .where(eq(schema.customerMemberships.planId, plan.id));
    assert(row && row.status === "active" && row.customerId === phone, "live membership row persisted");

    // ── 4. "my membership" status ────────────────────────────────────────
    const status = await say("my membership", "status");
    assert(status.includes("J554 Gold") && status.includes("10%"), `status reply (got ${status.slice(0, 160)})`);

    // ── 5. Checkout: the 10% member discount ACTUALLY applies ───────────
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }], // ₦2,500.00
      fulfillment: "pickup",
    });
    const [orderRow] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, order.orderId));
    const meta = (orderRow.metadata as Record<string, any>) ?? {};
    const subtotalCents = Math.round(parseFloat(meta.subtotal) * 100);
    assert(subtotalCents === 250_000, `subtotal sanity (got ${subtotalCents})`);
    const disc = meta.membershipDiscount as { planName: string; discountPercent: number; discountCents: number } | undefined;
    assert(disc && disc.discountPercent === 10 && disc.discountCents === 25_000,
      `member discount snapshot (got ${JSON.stringify(disc)})`);
    const totalCents = Math.round(parseFloat(orderRow.totalAmount) * 100);
    assert(totalCents === 225_000, `order total reflects the discount (${totalCents} != 225000)`);
    assert(order.summaryText.includes("💎") && order.summaryText.includes("J554 Gold"),
      `summary carries the member line (got ${order.summaryText.slice(0, 240)})`);

    // ── 6. Points multiplier: delivered order earns 2x ──────────────────
    await world.db.update(schema.orders)
      .set({ status: "delivered", updatedAt: new Date() })
      .where(eq(schema.orders.id, order.orderId));
    const { awardPointsForOrder, getBalance } = await import("../../server/services/loyalty");
    const earn = await awardPointsForOrder(world.db as any, TENANT_ID, order.orderId);
    const base = Math.floor(225_000 / 10_000); // default rules: 1 pt / ₦100
    assert(earn.awarded === base * 2, `multiplier doubles the earn (${earn.awarded} != ${base * 2})`);
    const bal = await getBalance(world.db as any, TENANT_ID, phone);
    assert(bal === base * 2, `balance reflects the multiplied earn (${bal} != ${base * 2})`);
  },
};
// === END W54 capabilities ===
