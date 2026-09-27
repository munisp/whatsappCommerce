// === W54 capabilities (CAP-1) ===
/**
 * J556 — Paid membership tier: "join membership 1" creates the pending
 * order + PSP payment link on the EXISTING rail (paymentIntents idempotency
 * key membership:<orderId>); the real paystack webhook confirms payment and
 * the receipts post-commit seam ACTIVATES the membership with a period end
 * (paymentConfirm.ts untouched). The roster query shows the activated
 * member, and a replayed activation never double-inserts.
 */
import { desc, eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { paystackChargeSuccess, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J556",
  name: "paid membership: join → link → webhook → active (period end) → roster",
  feature: "W54 capabilities: paid membership tiers on the existing payment rail",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/membershipPlans");
    const phone = world.newPhone("549");
    await world.grantConsent(phone);

    // ── 1. Merchant seeds a PAID Gold tier: ₦1,000/month, 10% off ───────
    const plan = await svc.createMembershipPlan(world.db as any, {
      tenantId: TENANT_ID, name: "J556 Gold", priceCents: 100_000, period: "month",
      discountPercent: 10, pointsMultiplier: 1,
    });

    const say = async (text: string, label: string): Promise<string> => {
      const before = world.outbound.ofType("text", phone).length;
      await world.text(phone, text);
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 15000, `${label} reply`);
      return bodyText(world.outbound.lastOfType("text", phone));
    };

    // ── 2. join → pending order + payment link (NOT yet active) ─────────
    await say("membership", "plan list");
    const join = await say("join membership 1", "join");
    assert(join.includes("MBR-") && join.includes("1,000.00"), `join summary (got ${join.slice(0, 240)})`);
    assert(join.includes("http"), `payment link in the reply (got ${join.slice(0, 240)})`);
    const [order] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.customerId, phone))
      .orderBy(desc(schema.orders.createdAt)).limit(1);
    assert(order && (order.metadata as any)?.membershipJoin?.planId === plan.id, "membership-join order persisted");
    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.orderId, order.id));
    assert(intent && intent.idempotencyKey === `membership:${order.id}`, "payment intent idempotency key");

    // Not active before payment.
    const pre = await svc.getMembershipStatus(world.db as any, TENANT_ID, phone);
    assert(pre === null, "no membership before payment");

    // ── 3. paystack webhook → receipts seam activates the membership ────
    const res = await paystackChargeSuccess(world, { reference: intent.providerPaymentId!, amountMajor: 1000 });
    assert(res.status === 200, `webhook accepted (got ${res.status})`);
    let membership: any = null;
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.customerMemberships)
        .where(eq(schema.customerMemberships.planId, plan.id));
      membership = rows[0] ?? null;
      return !!membership && membership.status === "active";
    }, 12000, "membership activated after payment");
    assert(membership.customerId === phone, "membership bound to the buyer");
    assert(membership.currentPeriodEnd instanceof Date && membership.currentPeriodEnd.getTime() > Date.now(),
      "paid tier carries a period end");
    assert(membership.orderId === order.id, "activation linked to the join order");

    // ── 4. Activation is idempotent — a replay never double-inserts ──────
    const again = await svc.activateMembershipForOrder(world.db as any, order.id, intent.providerPaymentId!);
    assert(again.activated === false && again.membership?.id === membership.id, "replay returns the same membership");
    const count = await world.db.select().from(schema.customerMemberships)
      .where(eq(schema.customerMemberships.planId, plan.id));
    assert(count.length === 1, "still exactly one membership row");

    // ── 5. Status + roster read it back ──────────────────────────────────
    const status = await say("my membership", "status");
    // Localized reply (see J554 note): assert plan + the ISO period-end date.
    assert(status.includes("J556 Gold") && /\d{4}-\d{2}-\d{2}/.test(status), `status shows period end (got ${status.slice(0, 240)})`);
    const userId = 5491;
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TENANT_ID, userId: String(userId), role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(TENANT_ID, { userId });
    const roster = await caller.membershipPlans.roster({ tenantId: TENANT_ID, planId: plan.id, status: "active" });
    assert(roster.length === 1 && roster[0].customerId === phone, "roster shows the activated member");
  },
};
// === END W54 capabilities ===
