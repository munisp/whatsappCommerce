// === W54 disputes ===
/**
 * J546 — DISP-1: buyer WA/TG notification on dispute resolution (channel
 * parity). Before W54 the review flow notified only the merchant portal +
 * an OPTIONAL Resend email.
 *
 *  WA: a chat-order buyer whose dispute is resolved (full refund) receives a
 *      localized WhatsApp resolution notice on their own number.
 *  TG: a telegram-native buyer (order customerId `telegram:<chat_id>`) whose
 *      dispute is resolved receives the SAME semantic notice as a telegram
 *      sendMessage — routed via channelParity, never WA.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, adminCaller } from "./helpers";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { randomUUID } from "node:crypto";

export const journey: Journey = {
  id: "J546",
  name: "DISP-1: buyer resolution notification on WA and TG (parity)",
  feature: "W54 dispute resolution buyer notify (localized, channel parity, fail-open)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    const { raiseEscrowDispute } = await import("../../server/services/disputes");

    // ── WA path ──────────────────────────────────────────────────────────
    const phone = world.newPhone("j546-buyer");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);
    let escrow: any | null = null;
    await world.waitFor(async () => {
      const [e] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
      escrow = e ?? null;
      return !!escrow && escrow.state === "escrow_held";
    }, 10000, "escrow hold created");
    const waDispute = await raiseEscrowDispute(world.db as any, {
      escrowTxId: escrow!.id, orderId: order.orderId, tenantId: TENANT_ID,
      raisedBy: "buyer", reason: "not_received", description: "J546 never arrived",
    });

    const waBase = world.outbound.toPhone(phone).length;
    const admin = await adminCaller();
    await admin.escrowDispute.review({
      disputeId: waDispute.id,
      resolution: "full_refund_to_buyer",
      resolverNotes: "J546 buyer favoured",
    });
    await world.waitFor(
      () => world.outbound.toPhone(phone).length > waBase,
      10000, "WA buyer resolution notice",
    );
    const waText = world.outbound.toPhone(phone).slice(waBase).map((c) => bodyText(c)).join("\n").toLowerCase();
    assert(waText.includes("dispute"), `WA notice names the dispute (got ${waText.slice(0, 200)})`);
    assert(waText.includes("refund"), `WA notice states the refund outcome (got ${waText.slice(0, 200)})`);
    assert(waText.includes(order.orderNumber.toLowerCase()), "WA notice carries the order number");

    // ── TG path (parity) ─────────────────────────────────────────────────
    await ensureTelegramConfig(world);
    const chatId = "880546";
    const tgOrderId = `ord-j546-tg-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.orders).values({
      id: tgOrderId,
      tenantId: TENANT_ID,
      customerId: `telegram:${chatId}`,
      orderNumber: `J546TG-${tgOrderId.slice(-4)}`,
      status: "confirmed",
      totalAmount: "5000.00",
      currency: "NGN",
      paymentStatus: "completed",
      metadata: {},
    });
    const tgEscrowId = randomUUID();
    await world.db.insert(schema.escrowTransactions).values({
      id: tgEscrowId,
      tenantId: TENANT_ID,
      orderId: tgOrderId,
      customerId: `telegram:${chatId}`,
      amount: "5000.00",
      currency: "NGN",
      state: "escrow_held",
    });
    const tgDispute = await raiseEscrowDispute(world.db as any, {
      escrowTxId: tgEscrowId, orderId: tgOrderId, tenantId: TENANT_ID,
      raisedBy: "buyer", reason: "wrong_item", description: "J546 TG wrong item",
    });
    const tgBase = tg.callsFor("sendMessage").length;
    await admin.escrowDispute.review({
      disputeId: tgDispute.id,
      resolution: "no_action",
      resolverNotes: "J546 TG reviewed",
    });
    await world.waitFor(() =>
      tg.callsFor("sendMessage").slice(tgBase).some((c) => String(c.body?.chat_id) === chatId),
      10000, "TG buyer resolution notice delivered to the TG chat");
    const tgText = String(
      tg.callsFor("sendMessage").slice(tgBase).find((c) => String(c.body?.chat_id) === chatId)?.body?.text ?? "",
    );
    assert(tgText.includes("dispute") && tgText.includes("resolved"),
      `TG notice carries the same semantic content (got ${tgText.slice(0, 200)})`);
    // Parity honesty: the TG buyer got NO WhatsApp message.
    assert(world.outbound.toPhone(chatId).length === 0, "TG buyer must not be messaged on WA");
  },
};
