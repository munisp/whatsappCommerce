/**
 * J152 — Micro-insurance: opt-in add-on at checkout → policy → parametric claim.
 * A real chat order (Jollof ₦2,500 = 250,000 cents) is created via the NLP
 * pipeline; the merchant configures a delivery-insurance product (200 bps,
 * 50,000-cent coverage); the buyer opts in over WhatsApp ("insure
 * delivery-basic") → deterministic premium (5,000 cents) bound as a policy,
 * attached to the order metadata add-ons; a parametric delivery_failed event
 * auto-files + pays the claim at full coverage. The WhatsApp policy
 * confirmation message is asserted.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J152",
  name: "insurance add-on → policy → parametric claim",
  feature: "checkout opt-in + mock adapter + parametric trigger hook",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("ins");
    await world.grantConsent(phone);

    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    const orderCents = Math.round(order.total * 100);
    assert(orderCents === 250_000, `order total 250,000 cents (got ${orderCents})`);

    const admin = await adminCaller();
    await admin.insurance.upsertProduct({
      tenantId: TENANT_ID,
      id: "delivery-basic",
      name: "Delivery Insurance",
      premiumBps: 200, // 2%
      flatPremiumCents: 100,
      coverageCents: 50_000,
    });

    // Menu over WhatsApp lists the add-on.
    await world.text(phone, "insure");
    const menu = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(menu, "delivery-basic", "insurance menu lists the product");
    assertIncludes(menu, "500.00", "coverage shown in the menu");

    // Opt-in → policy confirmation over WhatsApp.
    await world.text(phone, "insure delivery-basic");
    const confirm = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(confirm, "Policy confirmed", "WhatsApp policy confirmation");
    assertIncludes(confirm, "POL-", "policy number in confirmation");
    assertIncludes(confirm, "50.00", "premium ₦50.00 (2% of ₦2,500) in confirmation");

    // DB: policy bound, deterministic premium, attached to the order.
    const [policy] = await world.db.select().from(schema.insurancePolicies)
      .where(eq(schema.insurancePolicies.orderId, order.orderId));
    assert(policy, "policy persisted");
    assert(policy.premiumCents === 5_000, `premium = 2% of 250,000 = 5,000 (got ${policy.premiumCents})`);
    assert(policy.coverageCents === 50_000, "coverage carried from product");
    assert(policy.status === "active", "policy active");
    assert(policy.holderPhone === phone, "policy holder is the buyer");

    const [orderRow] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, order.orderId));
    const meta = orderRow.metadata as any;
    const addOn = (meta?.addOns ?? []).find((a: any) => a.kind === "insurance");
    assert(addOn, "insurance add-on attached to order metadata");
    assert(addOn.premiumCents === 5_000, "add-on premium in integer cents");
    assert(meta.insurancePremiumCents === 5_000, "order insurancePremiumCents total");

    // Quote is now bound — rebinding returns the same policy (idempotent).
    const [quote] = await world.db.select().from(schema.insuranceQuotes)
      .where(eq(schema.insuranceQuotes.orderId, order.orderId));
    assert(quote.status === "bound", "quote marked bound");
    const rebind = await admin.insurance.bind({ tenantId: TENANT_ID, quoteId: quote.id });
    assert(rebind.alreadyBound === true && rebind.policy.id === policy.id, "rebind is idempotent");

    // ── Parametric trigger: delivery_failed event auto-claims ────────────
    const insurance = await import("../../server/services/insurance");
    const result = await insurance.handleParametricEvent(world.db, {
      tenantId: TENANT_ID, event: { type: "delivery_failed", orderId: order.orderId },
    });
    assert(result, "parametric event matched the active policy");
    assert(result!.claim.trigger === "parametric", "claim tagged parametric");
    // W30 (V1#2): approved ≠ paid — no money moved, so the claim waits at
    // pending_payout until ops confirms a real disbursement.
    assert(result!.claim.status === "pending_payout", `parametric claim honestly pending payout (got ${result!.claim.status})`);
    assert(result!.claim.payoutCents === 50_000, "payout = full coverage");
    assert(result!.claim.resolvedAt == null, "unresolved until the payout lands");

    // Ops confirms the payout with evidence → exactly one guarded flip.
    const confirmed = await admin.insurance.confirmPayout({
      tenantId: TENANT_ID, claimId: result!.claim.id, note: "ops disbursement ref DISB-152",
    });
    assert(confirmed.status === "paid" && confirmed.resolvedAt != null, "manual ops confirm marks paid");
    const dup = await admin.insurance.confirmPayout({
      tenantId: TENANT_ID, claimId: result!.claim.id, note: "again",
    }).catch((e: any) => e);
    assert(dup instanceof Error, "second payout confirm rejected");

    // Policy claimed; a second event is a no-op (idempotent).
    const [after] = await world.db.select().from(schema.insurancePolicies)
      .where(eq(schema.insurancePolicies.id, policy.id));
    assert(after.status === "claimed", "policy status → claimed");
    const again = await insurance.handleParametricEvent(world.db, {
      tenantId: TENANT_ID, event: { type: "delivery_failed", orderId: order.orderId },
    });
    assert(again === null, "second parametric event ignored");
    const claims = await world.db.select().from(schema.insuranceClaims)
      .where(eq(schema.insuranceClaims.policyId, policy.id));
    assert(claims.length === 1, "exactly one claim recorded");
  },
};
