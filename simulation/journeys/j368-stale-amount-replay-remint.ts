// === W45 money-intents (Coder B2) ===
/**
 * J368 — PAY-15: stale-amount intent replay after an order edit.
 *
 * An intent minted at the OLD order total must NOT be replayed once the order
 * is edited: payment.initiate compares the existing in-flight intent's
 * amount/currency to the CURRENT order total, CANCELS the stale intent
 * (audit row, idempotency key freed), and REMINTS a fresh intent at the
 * current total. An unchanged replay stays idempotent.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, seedOrderForInitiate } from "./helpers";

export const journey: Journey = {
  id: "J368",
  name: "PAY-15: stale-amount intent replay cancels + remints",
  feature: "W45 routers/payment.ts replay guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    await upsertTenantProviderConfig({
      tenantId: TENANT_ID,
      provider: "paystack",
      creds: { secretKey: "sk_sim_j368" },
      priority: 10,
    });

    const caller = await adminCaller();
    const orderId = `order-j368-${Date.now()}`;
    await seedOrderForInitiate(world, { orderId, tenantId: TENANT_ID, amountMajor: 1_000 });

    // 1. Mint the intent at ₦1,000.
    const first = await caller.payment.initiate({
      tenantId: TENANT_ID,
      orderId,
      amount: 1_000,
      currency: "NGN",
      provider: "paystack",
      customerPhone: world.newPhone("pay15a"),
    });
    assert(first.status === "initiated", "first intent initiated");
    assert(first.paymentUrl, "checkout URL served");

    // 2. Unchanged replay → SAME intent returned idempotently.
    const replay = await caller.payment.initiate({
      tenantId: TENANT_ID,
      orderId,
      amount: 1_000,
      currency: "NGN",
      provider: "paystack",
      customerPhone: world.newPhone("pay15a"),
    });
    assert(replay.idempotentReplay === true, "unchanged replay is idempotent");
    assert(replay.paymentIntentId === first.paymentIntentId, "unchanged replay returns the same intent");

    // 3. Merchant EDITS the order → total ₦1,500.
    await world.db.update(schema.orders)
      .set({ totalAmount: "1500.00" })
      .where(eq(schema.orders.id, orderId));

    // 4. Stale-amount replay → old intent CANCELLED, fresh intent REMINTED.
    const remint = await caller.payment.initiate({
      tenantId: TENANT_ID,
      orderId,
      amount: 1_500,
      currency: "NGN",
      provider: "paystack",
      customerPhone: world.newPhone("pay15a"),
    });
    assert(remint.status === "initiated", "reminted intent initiated");
    assert(remint.paymentIntentId !== first.paymentIntentId, "a FRESH intent was minted");
    assert(remint.reference !== first.reference, "fresh reference minted");

    const intents = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.orderId, orderId));
    const stale = intents.find((i) => i.id === first.paymentIntentId);
    const fresh = intents.find((i) => i.id === remint.paymentIntentId);
    assert(stale, "stale intent row kept for audit");
    assert(stale!.status === "cancelled", `stale intent cancelled (got ${stale!.status})`);
    assert(String(stale!.failureReason).includes("stale_amount_remint"), "cancel reason recorded");
    assert(parseFloat(stale!.amount) === 1000, "stale intent keeps its old amount (audit)");
    assert(fresh, "fresh intent persisted");
    assert(fresh!.status === "initiated", "fresh intent in-flight");
    assert(parseFloat(fresh!.amount) === 1500, `fresh intent at the CURRENT total (got ${fresh!.amount})`);

    // 5. Only ONE live intent for the order.
    const live = intents.filter((i) => i.status === "initiated" || i.status === "completed");
    assert(live.length === 1 && live[0].id === fresh!.id, "exactly one live intent after remint");
  },
};
