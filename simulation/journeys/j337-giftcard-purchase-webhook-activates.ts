// === W44 giftcards-referrals (Coder A) ===
/**
 * J337 — Gift card purchase rides the EXISTING payment-intent path: a
 * payment_intents row (metadata.kind='gift_card_purchase') + PSP link; the
 * pinned confirmProviderPayment verifies the webhook and the W44 hook then
 * creates the ACTIVE card with full balance, writes the 'purchase' audit
 * transaction, and delivers the code to the buyer. Webhook replay is
 * exactly-once (idempotency_key claim) — no second card, no second tx.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J337",
  name: "gift card purchase → payment intent → webhook activates card (idempotent)",
  feature: "W44 gift_cards purchase via existing payment path",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const gift = await import("../../server/services/giftCards");
    const phone = world.newPhone("j337");
    await world.grantConsent(phone);

    // ── Purchase ₦2,500 gift card via the payment-intent path ──
    const purchase = await gift.purchaseGiftCard(TENANT_ID, { amountCents: 250000, purchaserRef: phone });
    assert(purchase.reference.startsWith("GC-"), "reference minted");
    assert(purchase.paymentUrl, `PSP checkout link issued (got ${purchase.paymentUrl})`);

    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, purchase.reference));
    assert(intent, "payment_intents row created");
    assert((intent.metadata as any).kind === "gift_card_purchase", "intent carries gift_card_purchase kind");
    assert(intent.status !== "completed", "intent not completed before webhook");

    // No spendable card exists before payment clears.
    const before = await world.db.select().from(schema.giftCards)
      .where(eq(schema.giftCards.tenantId, TENANT_ID));
    assert(before.length === 0, `no card before payment (got ${before.length})`);

    // ── PSP webhook (verified by the PINNED confirm path) activates it ──
    const res = await paystackChargeSuccess(world, { reference: purchase.reference, amountMajor: 2500 });
    assert(res.status === 200, `webhook accepted (got ${res.status})`);

    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.giftCards).where(eq(schema.giftCards.tenantId, TENANT_ID));
      return rows.length === 1;
    }, 10000, "gift card activated on payment");
    const [card] = await world.db.select().from(schema.giftCards).where(eq(schema.giftCards.tenantId, TENANT_ID));
    assert(card.id === purchase.giftCardId, "card id from intent metadata");
    assert(card.status === "active", `active (got ${card.status})`);
    assert(card.balanceCents === 250000 && card.initialBalanceCents === 250000, "full balance credited");
    assert(card.purchaserCustomerId === phone, "purchaser recorded");

    const txs = await world.db.select().from(schema.giftCardTransactions)
      .where(eq(schema.giftCardTransactions.giftCardId, card.id));
    assert(txs.length === 1 && txs[0].type === "purchase" && txs[0].amountCents === 250000, "purchase audit row");
    assert(txs[0].idempotencyKey === `purchase:${purchase.reference}`, "idempotency key = purchase:<ref>");

    // Buyer received the code on their channel.
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phone);
      return !!t && bodyText(t).includes(card.code);
    }, 10000, "activation notice with code delivered");
    const notice = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(notice, "ACTIVE", "activation notice");

    // ── Webhook replay: exactly once (unique idempotency claim) ──
    const replay = await paystackChargeSuccess(world, { reference: purchase.reference, amountMajor: 2500 });
    assert(replay.status === 200, "replay accepted");
    const cardsAfter = await world.db.select().from(schema.giftCards).where(eq(schema.giftCards.tenantId, TENANT_ID));
    assert(cardsAfter.length === 1, "replay does not duplicate the card");
    const txsAfter = await world.db.select().from(schema.giftCardTransactions)
      .where(eq(schema.giftCardTransactions.giftCardId, card.id));
    assert(txsAfter.length === 1, "replay does not duplicate the purchase tx");
  },
};
