// === W44 giftcards-referrals (Coder A) ===
/**
 * J338 — Gift card redemption is claim-first: partial redeem draws the
 * balance down (redeemed_partially), an overdraw attempt is an honest
 * insufficient_funds CONFLICT with NO money moved, a replayed redemption
 * (same idempotency key) returns the ORIGINAL result without double-debit,
 * full redemption depletes the card, and disabled/expired cards refuse.
 * applyGiftCardToOrder covers a whole order → order flips to PAID.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J338",
  name: "gift card redeem: claim-first debit, CONFLICT on insufficient, idempotent replay",
  feature: "W44 gift_cards claim-first redemption",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const gift = await import("../../server/services/giftCards");
    const phone = world.newPhone("j338");
    await world.grantConsent(phone);

    // Merchant-issued ₦1,000 card.
    const card = await gift.issueGiftCard(TENANT_ID, { amountCents: 100000, actor: "j338-merchant" });
    assert(card.status === "active" && card.balanceCents === 100000, "issued active with full balance");

    // Partial redeem: ₦400 → 60,000 left, redeemed_partially.
    const r1 = await gift.redeemGiftCard(TENANT_ID, card.code, 40000, { idempotencyKey: "redeem:j338:1" });
    assert(r1.ok && r1.appliedCents === 40000 && r1.balanceCents === 60000, `partial redeem (${JSON.stringify(r1)})`);
    assert(r1.status === "redeemed_partially", "status flips to redeemed_partially");

    // Idempotent replay: same key returns the ORIGINAL result, no double debit.
    const r1b = await gift.redeemGiftCard(TENANT_ID, card.code, 40000, { idempotencyKey: "redeem:j338:1" });
    assert(r1b.ok && r1b.duplicate === true && r1b.appliedCents === 40000, "replay is a duplicate");
    let fresh = await gift.getGiftCardByCode(TENANT_ID, card.code);
    assert(fresh!.balanceCents === 60000, "replay moved no money");

    // Insufficient funds: honest failure, balance untouched.
    const r2 = await gift.redeemGiftCard(TENANT_ID, card.code, 70000, { idempotencyKey: "redeem:j338:2" });
    assert(!r2.ok && r2.error === "insufficient_funds", `overdraw refused (${JSON.stringify(r2)})`);
    fresh = await gift.getGiftCardByCode(TENANT_ID, card.code);
    assert(fresh!.balanceCents === 60000, "failed redeem moved no money");

    // Drain to zero → depleted; further redeems refuse.
    const r3 = await gift.redeemGiftCard(TENANT_ID, card.code, 60000, { idempotencyKey: "redeem:j338:3", orderId: "j338-order" });
    assert(r3.ok && r3.balanceCents === 0 && r3.status === "depleted", "full drain depletes");
    const r4 = await gift.redeemGiftCard(TENANT_ID, card.code, 100, { idempotencyKey: "redeem:j338:4" });
    assert(!r4.ok && r4.error === "gift_card_depleted", "depleted card refuses");

    // Disabled card refuses redemption.
    const card2 = await gift.issueGiftCard(TENANT_ID, { amountCents: 50000, actor: "j338-merchant" });
    await gift.disableGiftCard(TENANT_ID, card2.code, "j338-merchant");
    const r5 = await gift.redeemGiftCard(TENANT_ID, card2.code, 1000, { idempotencyKey: "redeem:j338:5" });
    assert(!r5.ok && r5.error === "gift_card_disabled", "disabled card refuses");

    // Unknown code is honest.
    const r6 = await gift.redeemGiftCard(TENANT_ID, "GC-NOPE-0000", 1000, { idempotencyKey: "redeem:j338:6" });
    assert(!r6.ok && r6.error === "gift_card_not_found", "unknown code honest");

    // ── Checkout application: card covers the full order → order PAID ──
    const buyer = world.newPhone("j338b");
    await world.grantConsent(buyer);
    const order = await createChatOrderViaNlp(world, buyer, {
      items: [{ product: "Jollof Rice", quantity: 1 }], // ₦2,500
    });
    assert(order.total === 2500, `order total 2500 (got ${order.total})`);
    const bigCard = await gift.issueGiftCard(TENANT_ID, { amountCents: 300000, customerId: buyer, actor: "j338-merchant" });
    const app = await gift.applyGiftCardToOrder(TENANT_ID, bigCard.code, order.orderId, { customerRef: buyer });
    assert(app.ok && app.appliedCents === 250000 && app.remainderCents === 0, `full coverage (${JSON.stringify(app)})`);
    assert(app.orderPaidInFull === true, "order paid in full by card");
    const [paid] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId));
    assert(paid.paymentStatus === "completed", `order completed (got ${paid.paymentStatus})`);
    const big = await gift.getGiftCardByCode(TENANT_ID, bigCard.code);
    assert(big!.balanceCents === 50000 && big!.status === "redeemed_partially", "residual balance honest");

    // Redeem transaction is linked to the order.
    const orderTx = await world.db.select().from(schema.giftCardTransactions)
      .where(eq(schema.giftCardTransactions.orderId, order.orderId));
    assert(orderTx.length === 1 && orderTx[0].type === "redeem" && orderTx[0].amountCents === 250000, "redeem tx linked to order");

    // Re-applying the same card to the same order is idempotent (same key).
    const app2 = await gift.applyGiftCardToOrder(TENANT_ID, bigCard.code, order.orderId, { customerRef: buyer });
    assert(app2.ok && app2.duplicate === true, "same-order re-apply is a duplicate");
    const big2 = await gift.getGiftCardByCode(TENANT_ID, bigCard.code);
    assert(big2!.balanceCents === 50000, "no double debit on re-apply");
  },
};
