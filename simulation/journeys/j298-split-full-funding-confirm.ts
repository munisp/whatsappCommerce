/**
 * === W41 (Coder B, UC-3) ===
 * J298 — Split payment full funding: invites go out on BOTH channels
 * (telegram via channelSender, WA via the normal sender), shares sum to the
 * target exactly, mixed wallet+link contributions tally claim-first, the
 * order confirms ONLY when fully funded, and a concurrent confirm is a
 * no-op (claim-first transition).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J298",
  name: "split session: both-channel invites, full funding → order confirm",
  feature: "W41 UC-3 split_payment_sessions claim-first tally + confirm",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const split = await import("../../server/services/splitPayments");
    const wallet = await import("../../server/services/customerWallet");
    const parity = await import("../../server/services/channelParity");

    const orderId = `j298-${Date.now()}`;
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: `cust-${orderId}`, orderNumber: `ORD-${orderId}`,
      status: "pending", paymentStatus: "unpaid", totalAmount: "3000.00", currency: "NGN",
    }).onConflictDoNothing();

    const tgPhone = world.newPhone("w41tg");
    const waPhone1 = world.newPhone("w41g");
    const waPhone2 = world.newPhone("w41h");
    for (const p of [tgPhone, waPhone1, waPhone2]) {
      await world.db.insert(schema.customers).values({
        id: `cust-${p}`, tenantId: TENANT_ID, whatsappPhone: p, name: `Split ${p}`,
      }).onConflictDoNothing();
      await world.grantConsent(p);
    }
    // Link the telegram participant.
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId: "j298chat", phoneE164: tgPhone.replace(/\D/g, ""),
    }).onConflictDoNothing();

    // Capture telegram deliveries; WA flows through the normal sender.
    const tgSeen: any[] = [];
    parity.__setChannelSenderForTests(async (_t, channel, to, p, opts) => {
      tgSeen.push({ channel, to, ...(p as any), ...(opts as any) });
      return { sent: true, simulated: false };
    });
    let sessionId = "";
    try {
      const created = await split.createSplitSession(TENANT_ID, orderId, 300000, [tgPhone, waPhone1, waPhone2]);
      sessionId = created.sessionId;
      // Σshares === target exactly (300000 / 3 splits evenly here).
      assert(created.participants.reduce((s, p) => s + p.shareCents, 0) === 300000, "shares sum to target");

      // Invites landed on BOTH channels.
      await world.waitFor(() => tgSeen.length >= 1 && world.outbound.toPhone(waPhone1).length >= 1
        && world.outbound.toPhone(waPhone2).length >= 1, 8000, "split invites both channels");
      assert(tgSeen[0].to === "j298chat", "telegram invite to the linked chat_id");
      assertIncludes(String(tgSeen[0].text ?? ""), "your share", "telegram invite carries the share");
    } finally {
      parity.__setChannelSenderForTests(null);
    }

    // Not fully funded → confirm refused.
    const early = await split.confirmSplitIfFunded(sessionId);
    assert(early.confirmed === false, "no confirm before full funding");

    // Participant 1 (telegram) pays their share from a pre-funded wallet.
    await wallet.creditWallet(TENANT_ID, tgPhone, 100000, "merchant_goodwill", "goodwill:j298tg");
    const c1 = await split.contributeSplit(sessionId, tgPhone, 100000, "wallet");
    assert(c1.ok === true && c1.fullyFunded === false, `wallet contribution tallied: ${JSON.stringify(c1)}`);
    assert((await wallet.walletBalance(TENANT_ID, tgPhone)) === 0, "wallet drained by the contribution");

    // Participant 2 pays via PSP payment link (verified reference).
    const c2 = await split.contributeSplit(sessionId, waPhone1, 100000, "link", `paylink-j298-${Date.now()}`);
    assert(c2.ok === true && c2.fullyFunded === false, "link contribution tallied");

    // Over-share payments are rejected (fail-closed on money ambiguity).
    const over = await split.contributeSplit(sessionId, waPhone2, 100001, "link", `paylink-j298-over`);
    assert(over.ok === false && over.error === "exceeds_share", "over-share contribution rejected");

    // Participant 3 completes the funding → session funded.
    const c3 = await split.contributeSplit(sessionId, waPhone2, 100000, "link", `paylink-j298-${Date.now()}-b`);
    assert(c3.ok === true && c3.fullyFunded === true, `fully funded: ${JSON.stringify(c3)}`);
    assert(c3.fundedCents === 300000, "claim-first tally reached the target");

    // Confirm: exactly ONE caller flips funded→confirmed and releases the order.
    const [conf1, conf2] = await Promise.all([
      split.confirmSplitIfFunded(sessionId),
      split.confirmSplitIfFunded(sessionId),
    ]);
    assert(conf1.confirmed !== conf2.confirmed, "claim-first: exactly one confirm wins");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    assert(ord.status === "confirmed" && ord.paymentStatus === "completed",
      `order released on full funding, got ${ord.status}/${ord.paymentStatus}`);
  },
};
