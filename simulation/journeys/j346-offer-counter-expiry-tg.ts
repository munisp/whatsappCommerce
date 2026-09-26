// === W44 preorders-offers (Coder B) ===
/**
 * J346 — Offer counter/expiry/floor + Telegram parity:
 *  1. Price floor: products.minPriceCents set → an offer below it is refused
 *     honestly (no row created).
 *  2. Counter flow: merchant typed "OFFER COUNTER <id> 4800" → countered +
 *     customer counter card (offer:caccept/offer:cdecline) → customer accepts
 *     the counter → priced checkout at the COUNTER price.
 *  3. Expiry sweep: open offer past expiresAt flips to 'expired' + notify.
 *  4. Telegram parity: TG buyer offer, TG merchant card (inline keyboard,
 *     same id grammar), TG callback reject → rejected + TG notices.
 */
import { and, desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { addStaffUser } from "./w43-dispatch-seed";
import { seedPreorderProduct } from "./w44-preorder-offer-seed";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

async function latestOffer(world: World, customerRef: string) {
  const schema = await import("../../drizzle/schema");
  const [o] = await world.db.select().from(schema.customOffers)
    .where(and(
      eq(schema.customOffers.tenantId, TENANT_ID),
      eq(schema.customOffers.customerId, customerRef),
    ))
    .orderBy(desc(schema.customOffers.createdAt))
    .limit(1);
  return o;
}

export const journey: Journey = {
  id: "J346",
  name: "offer counter/expiry/floor + telegram parity",
  feature: "counter card + expiry sweep + minPriceCents floor + TG inline keyboard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const merchant = world.newPhone("j346m");
    await world.grantConsent(merchant);
    await addStaffUser(world, "j346", merchant);
    await world.patchTenantSettings({ adminPhone: merchant });

    // ── 1. Price floor guard ──
    const floorProd = await seedPreorderProduct(world, "j346f", { price: "5000.00", minPriceCents: 400000 });
    const phoneF = world.newPhone("j346f");
    await world.grantConsent(phoneF);
    await world.text(phoneF, `I'll pay 3000 for ${floorProd.name}`);
    const floorReply = bodyText(world.outbound.lastOfType("text", phoneF));
    assertIncludes(floorReply, "below this store's minimum price", "below-floor offer refused honestly");
    const noRow = await latestOffer(world, phoneF);
    assert(!noRow, "no row created for a refused offer");

    // ── 2. Counter flow (typed merchant command + customer card) ──
    const prod = await seedPreorderProduct(world, "j346c", { price: "5000.00" });
    const phoneC = world.newPhone("j346c");
    await world.grantConsent(phoneC);
    await world.text(phoneC, `I'll pay 4500 for ${prod.name}`);
    const offerC = await latestOffer(world, phoneC);
    assert(offerC?.status === "pending", "counter-leg offer pending");

    await world.text(merchant, `OFFER COUNTER ${offerC.id} 4800`);
    const mReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(mReply, "₦4,800.00", "merchant counter confirmation shows amount");
    const [countered] = await world.db.select().from(schema.customOffers).where(eq(schema.customOffers.id, offerC.id));
    assert(countered.status === "countered", `countered (got ${countered.status})`);
    assert(countered.counterPriceCents === 480000, "counter price in kobo");

    // Customer counter card with caccept/cdecline buttons.
    await world.waitFor(() => {
      const cardMsg = world.outbound.lastOfType("interactive", phoneC);
      return !!cardMsg;
    }, 10000, "customer counter card sent");
    const cardJson = JSON.stringify(world.outbound.lastOfType("interactive", phoneC));
    assert(cardJson.includes(`offer:caccept:${offerC.id}`), "counter card carries caccept id");
    assert(cardJson.includes(`offer:cdecline:${offerC.id}`), "counter card carries cdecline id");

    await world.buttonReply(phoneC, `offer:caccept:${offerC.id}`, "✅ Accept counter");
    const [accepted] = await world.db.select().from(schema.customOffers).where(eq(schema.customOffers.id, offerC.id));
    assert(accepted.status === "accepted", `counter accepted (got ${accepted.status})`);
    assert(accepted.orderId, "order created from counter accept");
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, accepted.orderId!));
    assert(order.totalAmount === "4800.00", `order at COUNTER price (got ${order.totalAmount})`);
    const ov = (order.metadata as any).priceOverride;
    assert(ov?.agreedPriceCents === 480000, "override snapshot at counter price");
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phoneC);
      return !!t && bodyText(t).includes("Deal!");
    }, 10000, "customer deal notification");

    // ── 3. Expiry sweep ──
    const phoneX = world.newPhone("j346x");
    await world.grantConsent(phoneX);
    await world.text(phoneX, `I'll pay 4000 for ${prod.name}`);
    const offerX = await latestOffer(world, phoneX);
    assert(offerX?.status === "pending", "expiry-leg offer pending");
    await world.backdate(
      `UPDATE custom_offers SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [offerX.id],
    );
    const { sweepExpiredOffers } = await import("../../server/services/customOffers");
    const sweep = await sweepExpiredOffers({ db: world.db });
    assert(sweep.expired === 1, `one offer expired (got ${sweep.expired})`);
    const [exp] = await world.db.select().from(schema.customOffers).where(eq(schema.customOffers.id, offerX.id));
    assert(exp.status === "expired", `expired (got ${exp.status})`);
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phoneX);
      return !!t && bodyText(t).includes("expired");
    }, 10000, "customer expiry notification");
    const replay = await sweepExpiredOffers({ db: world.db });
    assert(replay.expired === 0, "expiry sweep idempotent");

    // ── 4. Telegram parity: TG buyer offer + TG merchant card + callback ──
    await ensureTelegramConfig(world);
    const buyerPhone = world.newPhone("j346t");
    const buyerChat = "660346";
    const adminChat = "990346";
    await world.db.insert(schema.telegramIdentities).values([
      { tenantId: TENANT_ID, chatId: buyerChat, phoneE164: buyerPhone },
      { tenantId: TENANT_ID, chatId: adminChat, phoneE164: merchant },
    ]).onConflictDoNothing();
    const curSettings = await world.tenantSettings();
    await world.patchTenantSettings({ telegram: { ...((curSettings as any)?.telegram ?? {}), adminChatId: adminChat } });
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${buyerChat}`, channel: "telegram", granted: true });
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${adminChat}`, channel: "telegram", granted: true });

    const tgProd = await seedPreorderProduct(world, "j346tg", { price: "5000.00" });
    const { tg } = await import("../metaMock");
    const sendBefore = tg.callsFor("sendMessage").length;
    const upRes = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(960346, buyerChat, 770346, `I'll pay 4200 for ${tgProd.name}`));
    assert(upRes.status === 200, "TG webhook acks");
    await world.waitFor(async () => {
      const o = await latestOffer(world, `telegram:${buyerChat}`);
      return o?.status === "pending";
    }, 10000, "TG offer parked as pending");
    const offerT = await latestOffer(world, `telegram:${buyerChat}`);
    // Wait for BOTH specific messages (see J336): the buyer reply and the merchant card race each other.
    const findBuyerReply = () => tg.callsFor("sendMessage").find((c) => String(c.body?.chat_id) === buyerChat && (c.body?.text ?? "").includes("is with the store"));
    const findCardT = () => tg.callsFor("sendMessage").find((c) => String(c.body?.chat_id) === adminChat && JSON.stringify(c.body ?? {}).includes(`offer:accept:${offerT!.id}`));
    await world.waitFor(() => !!findBuyerReply() && !!findCardT(), 10000, "TG buyer reply and merchant card sent");
    const buyerReply = findBuyerReply();
    assert(buyerReply, "TG buyer pending confirmation");
    const cardT = findCardT();
    assert(cardT, "TG merchant card with inline keyboard (same id grammar)");

    // TG merchant rejects from the inline keyboard callback.
    const cbRes = await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 960347,
      callback_query: {
        id: "cbq-960347",
        from: { id: 770347, first_name: "Boss", username: "tgboss346" },
        message: { message_id: 556, chat: { id: Number(adminChat), type: "private" }, date: 1788000000 },
        data: `offer:reject:${offerT!.id}`,
      },
    });
    assert(cbRes.status === 200, "TG callback acks");
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.customOffers).where(eq(schema.customOffers.id, offerT!.id));
      return o?.status === "rejected";
    }, 10000, "TG callback rejects");
    await world.waitFor(() =>
      tg.callsFor("sendMessage").some((c) => String(c.body?.chat_id) === buyerChat && (c.body?.text ?? "").includes("declined")),
    10000, "TG customer reject notification");
  },
};
