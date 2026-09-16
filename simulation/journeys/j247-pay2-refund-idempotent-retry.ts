/**
 * === W38 money-integrity (Coder A) ===
 * J247 — PAY-2 idempotent refund retry: a failed provider refund keeps the
 * refund "pending" with the attempt journaled in refund_attempts; the retry
 * carries the SAME deterministic idempotency key and succeeds exactly once.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller, expectTrpcError } from "./helpers";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J247",
  name: "PAY-2: refund retry is idempotent (attempt journal + stable key)",
  feature: "W38 refund_attempts + deterministic idempotency key",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("pay2-idem");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const payRes = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(payRes.status === 200, `paystack webhook accepted (got ${payRes.status})`);

    const tenant = await tenantCaller(TENANT_ID);
    const { refundId } = await tenant.orderCrud.refund({ orderId: order.orderId, amount: order.total, reason: "J247 idempotency" });

    // ── Attempt 1: provider down → honest failure, row stays pending ─────
    pay.refundPostStatus = 500;
    await expectTrpcError(tenant.orderCrud.processRefund({ refundId, action: "approved" }), "PRECONDITION_FAILED", "provider refund fails honestly");
    pay.refundPostStatus = null;

    let [row] = await world.db.select().from(schema.refunds).where(eq(schema.refunds.id, refundId));
    assert(row.status === "pending", `failed attempt keeps refund pending (got ${row.status})`);

    const attempts1 = await world.db.select().from(schema.refundAttempts).where(eq(schema.refundAttempts.refundId, refundId));
    assert(attempts1.length === 1, `one attempt journaled (got ${attempts1.length})`);
    assert(attempts1[0].status === "failed", `attempt status failed (got ${attempts1[0].status})`);
    assert(attempts1[0].idempotencyKey.startsWith("ref:"), "deterministic idempotency key recorded");

    // ── Attempt 2 (retry): same idempotency key, succeeds exactly once ───
    const ok = await tenant.orderCrud.processRefund({ refundId, action: "approved" });
    assert(ok.ok === true, "retry succeeded");
    const attempts2 = await world.db.select().from(schema.refundAttempts).where(eq(schema.refundAttempts.refundId, refundId));
    assert(attempts2.length === 2, `two attempts journaled (got ${attempts2.length})`);
    const keys = new Set(attempts2.map((a) => a.idempotencyKey));
    assert(keys.size === 1, "retry reuses the SAME deterministic idempotency key");
    [row] = await world.db.select().from(schema.refunds).where(eq(schema.refunds.id, refundId));
    assert(row.status === "approved", `refund approved after retry (got ${row.status})`);

    // ── Claim-first: a second approval can never re-issue the refund ─────
    await expectTrpcError(tenant.orderCrud.processRefund({ refundId, action: "approved" }), "CONFLICT", "re-approval refused");
    const attempts3 = await world.db.select().from(schema.refundAttempts).where(eq(schema.refundAttempts.refundId, refundId));
    assert(attempts3.length === 2, "no third provider attempt after refused re-approval");
    const posts = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund"));
    assert(posts.length === 2, `exactly two provider POSTs total (got ${posts.length})`);
  },
};
