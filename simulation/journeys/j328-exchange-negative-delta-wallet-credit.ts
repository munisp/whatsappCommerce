/**
 * === W43 exchanges (Coder B) ===
 * J328 — Exchange with NEGATIVE price delta → REAL W41 customerWallet credit
 * (creditWallet contract, idempotent ref `exchange_refund:<id>`). Swap
 * 2 × Origin (₦2,000) → Basic (₦500): delta −₦3,000 → wallet +300000 kobo.
 *
 * Asserts: wallet balance credited exactly once (a replayed decide is a
 * CONFLICT and moves NO money), the wallet ledger row exists with the
 * exchange ref, walletEntryRef recorded on the exchange, and a cancel after
 * the credit is refused (fail-closed money).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedExchangeOrder } from "./w43-exchange-seed";

export const journey: Journey = {
  id: "J328",
  name: "exchange negative delta → wallet credit (W41 creditWallet)",
  feature: "exchange price-delta refund via customer wallet",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { requestExchange, decideExchange, transitionExchange } =
      await import("../../server/services/exchanges");
    const { walletBalance } = await import("../../server/services/customerWallet");
    const phone = world.newPhone("j328");
    const seed = await seedExchangeOrder(world, "j328", phone);
    const notify = async () => {};

    const ex = await requestExchange(world.db, {
      tenantId: TENANT_ID, orderId: seed.orderId, fromOrderLineId: seed.orderLineId,
      toProductId: seed.cheapProductId, qty: 2, requestedBy: phone, requestedVia: "telegram", notify,
    });
    // (500.00 − 2000.00) × 2 = −3000.00 NGN = −300000 kobo.
    assert(ex.priceDeltaCents === -300_000, `delta −300000 kobo (got ${ex.priceDeltaCents})`);

    const before = await walletBalance(TENANT_ID, phone, world.db as any);
    const decided = await decideExchange(world.db, {
      exchangeId: ex.id, tenantId: TENANT_ID, approve: true, notify,
    });
    assert(decided.exchange.status === "approved", "approved");
    assert(decided.paymentUrl === null, "no payment link for negative delta");
    assert(decided.exchange.walletEntryRef === `exchange_refund:${ex.id}`, "wallet ref recorded");

    const after = await walletBalance(TENANT_ID, phone, world.db as any);
    assert(after - before === 300_000, `wallet credited +300000 kobo (${before} → ${after})`);

    const ledger = await world.db.select().from(schema.customerWalletEntries)
      .where(and(
        eq(schema.customerWalletEntries.tenantId, TENANT_ID),
        eq(schema.customerWalletEntries.refId, `exchange_refund:${ex.id}`),
        eq(schema.customerWalletEntries.direction, "credit"),
      ));
    assert(ledger.length === 1, `exactly one wallet ledger credit (got ${ledger.length})`);
    assert(ledger[0]!.amountCents === 300_000 && ledger[0]!.reason === "refund_to_wallet", "ledger amount/reason");

    // A replayed decide is a CONFLICT and moves NO money (idempotent).
    let dupThrew = false;
    try {
      await decideExchange(world.db, { exchangeId: ex.id, tenantId: TENANT_ID, approve: true, notify });
    } catch (e: any) { dupThrew = e?.code === "CONFLICT"; }
    assert(dupThrew, "replayed decide rejected");
    const replayBalance = await walletBalance(TENANT_ID, phone, world.db as any);
    assert(replayBalance === after, "no double credit on replay");

    // Fail-closed: cancel AFTER a wallet credit is refused (money moved).
    let cancelThrew = false;
    try {
      await transitionExchange(world.db, { exchangeId: ex.id, tenantId: TENANT_ID, to: "cancelled", notify });
    } catch (e: any) { cancelThrew = e?.code === "CONFLICT"; }
    assert(cancelThrew, "cancel after wallet credit refused");
    const [row] = await world.db.select().from(schema.exchangeRequests)
      .where(eq(schema.exchangeRequests.id, ex.id));
    assert(row.status === "approved", `still approved (got ${row.status})`);
  },
};
