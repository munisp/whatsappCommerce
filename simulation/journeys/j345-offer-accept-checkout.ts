// === W44 preorders-offers (Coder B) ===
/**
 * J345 — Haggling happy path on WhatsApp: buyer "I'll pay 4500 for …" →
 * pending custom_offers row + merchant approval card (WA interactive
 * buttons, offer:accept|reject|counter:<id> grammar) → merchant taps ACCEPT
 * → priced checkout: order at the AGREED price with a price-override
 * snapshot (list vs agreed) + audit row + PSP payment link sent to the
 * customer. One open offer per customer+product is enforced.
 */
import { and, desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { addStaffUser } from "./w43-dispatch-seed";
import { seedPreorderProduct } from "./w44-preorder-offer-seed";

export const journey: Journey = {
  id: "J345",
  name: "chat offer → merchant card accept → priced checkout link",
  feature: "custom_offers + approval card + price override + audit + payment link",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j345");
    await world.grantConsent(phone);
    const prod = await seedPreorderProduct(world, "j345", { price: "5000.00" });

    const merchant = world.newPhone("j345m");
    await world.grantConsent(merchant);
    await addStaffUser(world, "j345", merchant);
    await world.patchTenantSettings({ adminPhone: merchant });

    // ── Buyer makes the offer in chat ──
    await world.text(phone, `I'll pay 4500 for ${prod.name}`);
    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "is with the store", "buyer gets pending confirmation");
    assertIncludes(reply, "₦4,500.00", "reply echoes the offer amount");

    const [offer] = await world.db.select().from(schema.customOffers)
      .where(and(
        eq(schema.customOffers.tenantId, TENANT_ID),
        eq(schema.customOffers.customerId, phone),
      ))
      .orderBy(desc(schema.customOffers.createdAt))
      .limit(1);
    assert(offer, "custom_offers row created");
    assert(offer.status === "pending", `pending (got ${offer.status})`);
    assert(offer.offeredPriceCents === 450000, `4500 naira = 450000 kobo (got ${offer.offeredPriceCents})`);
    assert(offer.productId === prod.productId, "product resolved by name");
    assert(offer.expiresAt, "expiry stamped");

    // ── Merchant got the approval card (WA interactive buttons) ──
    await world.waitFor(() => !!world.outbound.lastOfType("interactive", merchant), 10000, "merchant approval card sent");
    const card = JSON.stringify(world.outbound.lastOfType("interactive", merchant));
    assert(card.includes(`offer:accept:${offer.id}`), "card carries accept id");
    assert(card.includes(`offer:reject:${offer.id}`), "card carries reject id");
    assert(card.includes(`offer:counter:${offer.id}`), "card carries counter id");

    // ── Second offer on same product while open → conflict ──
    await world.text(phone, `I'll pay 4600 for ${prod.name}`);
    const dup = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(dup, "already have an open offer", "duplicate open offer refused");

    // ── Merchant taps ACCEPT → priced checkout ──
    await world.buttonReply(merchant, `offer:accept:${offer.id}`, "✅ Accept");
    const mReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(mReply, "accepted", "merchant gets accept confirmation");

    const [decided] = await world.db.select().from(schema.customOffers).where(eq(schema.customOffers.id, offer.id));
    assert(decided.status === "accepted", `accepted (got ${decided.status})`);
    assert(decided.decidedAt, "decidedAt stamped");
    assert(decided.orderId, "order created");

    // Price-override snapshot on the order (list vs agreed, integer cents).
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, decided.orderId!));
    assert(order.totalAmount === "4500.00", `order at agreed price (got ${order.totalAmount})`);
    const ov = (order.metadata as any).priceOverride;
    assert(ov, "price-override snapshot present");
    assert(ov.offerId === offer.id, "snapshot references the offer");
    assert(ov.listPriceCents === 500000 && ov.agreedPriceCents === 450000, "list vs agreed integer cents");
    const [line] = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id));
    assert(line.unitPrice === "4500.00", `line at agreed price (got ${line.unitPrice})`);

    // Audit trail.
    const audits = await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND entity_id = '${offer.id}' ORDER BY created_at DESC LIMIT 1`,
    ) as any;
    const auditRows: any[] = Array.isArray(audits) ? audits : (audits?.rows ?? []);
    assert(auditRows.length > 0 && auditRows[0].action === "custom_offer.price_override", `audit row written (got ${JSON.stringify(auditRows[0] ?? null)})`);

    // ── Customer got the priced checkout link (payment_link category) ──
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phone);
      return !!t && bodyText(t).includes("ACCEPTED");
    }, 10000, "customer accept notification");
    const notif = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(notif, "Pay", "checkout link offered to customer");
    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.idempotencyKey, `offer-checkout:${offer.id}`));
    assert(intent, "payment intent row with offer idempotency key");
    assert(intent.status === "initiated", `link initiated (got ${intent.status})`);
    assert(typeof (intent.metadata as any)?.paymentUrl === "string" && (intent.metadata as any).paymentUrl.length > 0, "payment URL captured");

    // ── Double decision refused (state machine) ──
    await world.buttonReply(merchant, `offer:reject:${offer.id}`, "❌ Reject");
    const again = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(again, "Could not", "second decision refused");
  },
};
