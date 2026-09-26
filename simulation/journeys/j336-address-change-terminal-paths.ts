// === W43 dispatch (Coder C) ===
/**
 * J336 — Address-change terminal paths + Telegram parity:
 *  1. Tenant flag OFF → request refused honestly.
 *  2. Reject path (typed merchant command) → customer notified.
 *  3. Expiry: pending past expires_at flips to `expired` on next touch and
 *     the customer is notified.
 *  4. Fee: approve with addressChangeFeeCents → claim-first wallet debit.
 *  5. Telegram parity: buyer requests on TG (same NLP engine), merchant
 *     card lands as a TG inline keyboard, the callback id approves.
 */
import { and, desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { addStaffUser, seedDispatchOrder, setAllowAddressChange } from "./w43-dispatch-seed";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

async function latestReq(world: World, orderId: string) {
  const schema = await import("../../drizzle/schema");
  const [req] = await world.db.select().from(schema.addressChangeRequests)
    .where(and(
      eq(schema.addressChangeRequests.tenantId, TENANT_ID),
      eq(schema.addressChangeRequests.orderId, orderId),
    ))
    .orderBy(desc(schema.addressChangeRequests.createdAt))
    .limit(1);
  return req;
}

export const journey: Journey = {
  id: "J336",
  name: "address change reject/expiry/fee + telegram parity",
  feature: "terminal-path notifications, tenant flag, wallet fee, TG inline keyboard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // ── 1. Flag OFF → honest refusal ──
    const phone0 = world.newPhone("j336a");
    await world.grantConsent(phone0);
    await seedDispatchOrder(world, "j336a", phone0);
    await setAllowAddressChange(world, false);
    try {
      await world.text(phone0, "change my address to 5 Nowhere St, Lagos");
      // The reply is sent by the async pipeline after world.text() returns; wait for THIS message instead of
      // reading whatever is latest (an intermittent empty read otherwise).
      await world.waitFor(() => bodyText(world.outbound.lastOfType("text", phone0)).includes("doesn't allow address changes"), 10000, "flag-off refusal sent");
      const off = bodyText(world.outbound.lastOfType("text", phone0));
      assertIncludes(off, "doesn't allow address changes", "flag-off refusal is honest");
    } finally {
      await setAllowAddressChange(world, true);
    }

    const merchant = world.newPhone("j336m");
    await world.grantConsent(merchant);
    await addStaffUser(world, "j336", merchant);
    await world.patchTenantSettings({ adminPhone: merchant });

    // ── 2. Reject path (typed command) ──
    const phoneR = world.newPhone("j336r");
    await world.grantConsent(phoneR);
    const seedR = await seedDispatchOrder(world, "j336r", phoneR);
    await world.text(phoneR, "change my address to 8 Reject Rd, Lagos");
    const reqR = await latestReq(world, seedR.orderId);
    assert(reqR?.status === "pending", "reject-leg request pending");
    await world.text(merchant, `ADDR REJECT ${reqR.id} rider already at the gate`);
    const mReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(mReply, "rejected", "merchant gets reject confirmation");
    const [rej] = await world.db.select().from(schema.addressChangeRequests).where(eq(schema.addressChangeRequests.id, reqR.id));
    assert(rej.status === "rejected", `rejected (got ${rej.status})`);
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phoneR);
      return !!t && bodyText(t).includes("was rejected");
    }, 10000, "customer reject notification");
    const rejNotif = bodyText(world.outbound.lastOfType("text", phoneR));
    assertIncludes(rejNotif, "rider already at the gate", "reject note surfaces to customer");

    // ── 3. Expiry path ──
    const phoneX = world.newPhone("j336x");
    await world.grantConsent(phoneX);
    const seedX = await seedDispatchOrder(world, "j336x", phoneX);
    await world.text(phoneX, "change my address to 1 Expire Ln, Lagos");
    const reqX = await latestReq(world, seedX.orderId);
    assert(reqX?.status === "pending", "expiry-leg request pending");
    // Backdate expiry into the past; the next decision touch expires it.
    await world.backdate(
      `UPDATE address_change_requests SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [reqX.id],
    );
    await world.text(merchant, `ADDR APPROVE ${reqX.id}`);
    const expReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(expReply, "expired", "stale request decides as expired");
    const [exp] = await world.db.select().from(schema.addressChangeRequests).where(eq(schema.addressChangeRequests.id, reqX.id));
    assert(exp.status === "expired", `expired (got ${exp.status})`);
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phoneX);
      return !!t && bodyText(t).includes("expired");
    }, 10000, "customer expiry notification");

    // ── 4. Fee on approve: claim-first wallet debit ──
    const phoneF = world.newPhone("j336f");
    await world.grantConsent(phoneF);
    const seedF = await seedDispatchOrder(world, "j336f", phoneF);
    await world.patchTenantSettings({ dispatch: { addressChangeFeeCents: 5000 } });
    try {
      const { creditWallet, walletBalance } = await import("../../server/services/customerWallet");
      const top = await creditWallet(TENANT_ID, phoneF, 20000, "topup", `topup-j336-${seedF.orderId}`);
      assert(top.ok === true, "wallet topped up");
      await world.text(phoneF, "change my address to 4 Fee Ave, Lagos");
      const reqF = await latestReq(world, seedF.orderId);
      assert(reqF?.feeCents === 5000, `fee captured on request (got ${reqF?.feeCents})`);
      await world.text(merchant, `ADDR APPROVE ${reqF.id}`);
      await world.waitFor(async () => {
        const [r] = await world.db.select().from(schema.addressChangeRequests).where(eq(schema.addressChangeRequests.id, reqF.id));
        return r?.status === "applied" && r?.feeStatus === "charged";
      }, 10000, "fee charged on approve");
      const bal = await walletBalance(TENANT_ID, phoneF);
      assert(bal === 15000, `wallet debited 5000 kobo (balance ${bal})`);
      const feeNotif = bodyText(world.outbound.lastOfType("text", phoneF));
      assertIncludes(feeNotif, "wallet", "fee note in customer notification");

      // Idempotent fee: a replayed charge moves nothing.
      const { debitWallet } = await import("../../server/services/customerWallet");
      const again = await debitWallet(TENANT_ID, phoneF, 5000, "address_change_fee", `addrchg-fee:${reqF.id}`);
      assert(again.duplicate === true, "fee debit idempotent on refId");
      assert((await walletBalance(TENANT_ID, phoneF)) === 15000, "no double fee");
    } finally {
      await world.patchTenantSettings({ dispatch: {} });
    }

    // ── 5. Telegram parity: TG buyer request + TG merchant card/callback ──
    await ensureTelegramConfig(world);
    const buyerPhone = world.newPhone("j336t");
    const buyerChat = "660336";
    const adminChat = "990336";
    const adminPhone = merchant; // merchant is staff already
    await world.db.insert(schema.telegramIdentities).values([
      { tenantId: TENANT_ID, chatId: buyerChat, phoneE164: buyerPhone },
      { tenantId: TENANT_ID, chatId: adminChat, phoneE164: adminPhone },
    ]).onConflictDoNothing();
    // patchTenantSettings merges shallowly — preserve the telegram block
    // ensureTelegramConfig just wrote (botToken/webhookSecret) and ADD the
    // admin chat id.
    const curSettings = await world.tenantSettings();
    await world.patchTenantSettings({ telegram: { ...((curSettings as any)?.telegram ?? {}), adminChatId: adminChat } });
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${buyerChat}`, channel: "telegram", granted: true });
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${adminChat}`, channel: "telegram", granted: true });

    const seedT = await seedDispatchOrder(world, "j336t", buyerPhone);
    const { tg } = await import("../metaMock");
    const sendBefore = tg.callsFor("sendMessage").length;
    const upRes = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(960336, buyerChat, 770336, "change my address to 21 Telegram Blvd, Abuja"));
    assert(upRes.status === 200, "TG webhook acks");
    await world.waitFor(async () => {
      const r = await latestReq(world, seedT.orderId);
      return r?.status === "pending";
    }, 10000, "TG request parked as pending");
    const reqT = await latestReq(world, seedT.orderId);
    // Buyer got a TG reply; merchant got a TG inline-keyboard card.
    // Wait for BOTH specific messages, not merely "some message was sent": the buyer's reply and the
    // merchant's card go out back to back in either order, and waiting for the first one raced the second
    // (intermittent "TG buyer pending confirmation" failure, ~3 runs in 8 before this).
    const findBuyerReply = () => tg.callsFor("sendMessage").find((c) => String(c.body?.chat_id) === buyerChat && (c.body?.text ?? "").includes("pending merchant approval"));
    const findCard = () => tg.callsFor("sendMessage").find((c) => String(c.body?.chat_id) === adminChat && JSON.stringify(c.body ?? {}).includes(`addrchg:approve:${reqT.id}`));
    await world.waitFor(() => !!findBuyerReply() && !!findCard(), 10000, "TG buyer reply and merchant card sent");
    const buyerReply = findBuyerReply();
    assert(buyerReply, "TG buyer pending confirmation");
    const card = findCard();
    assert(card, "TG merchant card with inline keyboard (same id grammar)");

    // Merchant approves from the TG card callback.
    const cbRes = await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 960337,
      callback_query: {
        id: "cbq-960337",
        from: { id: 770337, first_name: "Boss", username: "tgboss336" },
        message: { message_id: 555, chat: { id: Number(adminChat), type: "private" }, date: 1788000000 },
        data: `addrchg:approve:${reqT.id}`,
      },
    });
    assert(cbRes.status === 200, "TG callback acks");
    await world.waitFor(async () => {
      const [r] = await world.db.select().from(schema.addressChangeRequests).where(eq(schema.addressChangeRequests.id, reqT.id));
      return r?.status === "applied";
    }, 10000, "TG callback approves (applied)");
    const [ordT] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seedT.orderId));
    assertIncludes((ordT.shippingAddress as any).line1, "Telegram Blvd", "TG-approved address applied");
    await world.waitFor(() =>
      tg.callsFor("sendMessage").some((c) => String(c.body?.chat_id) === buyerChat && (c.body?.text ?? "").includes("updated to")),
    10000, "TG customer applied notification");
  },
};
