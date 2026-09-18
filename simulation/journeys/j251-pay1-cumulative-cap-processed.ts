/**
 * === W38 money-integrity (Coder A) ===
 * J251 — PAY-1 residual: the cumulative over-refund guard counts 'processed'
 * refunds (provider-executed money), and processRefund re-checks the cap
 * claim-first at approval time so a refund created against a stale base can
 * never push the order past its total.
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller, expectTrpcError } from "./helpers";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J251",
  name: "PAY-1: cumulative refund cap includes processed + approval re-check",
  feature: "W38 orderCrud refund cap hardening",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("pay1-cap");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const payRes = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(payRes.status === 200, "webhook accepted");

    const total = order.total;
    const part = Math.round(total * 0.6 * 100) / 100; // 60%
    const tenant = await tenantCaller(TENANT_ID);

    // ── 60% refund → approved → CONFIRMED processed (money returned) ─────
    const r1 = await tenant.orderCrud.refund({ orderId: order.orderId, amount: part, reason: "J251 part 1" });
    const ok1 = await tenant.orderCrud.processRefund({ refundId: r1.refundId, action: "approved" });
    assert(ok1.ok === true, "first refund approved");
    const conf = await tenant.orderCrud.confirmRefundProcessed({ refundId: r1.refundId, evidence: "paystack refund.processed webhook sim", providerReference: "RFND_sim_j251" });
    assert(conf.status === "processed", "first refund confirmed processed");
    const [row1] = await world.db.select().from(schema.refunds).where(eq(schema.refunds.id, r1.refundId));
    assert(row1.status === "processed", `refund 1 processed (got ${row1.status})`);

    // ── Creation guard: another 60% must be rejected — the SUM includes
    //    'processed' (60% + 60% > 100%); pre-fix the processed leg was
    //    invisible and this would have been allowed.
    const err = await expectTrpcError(
      tenant.orderCrud.refund({ orderId: order.orderId, amount: part, reason: "J251 over-refund" }),
      "BAD_REQUEST",
      "over-refund rejected",
    );
    assert(/exceed the order total/.test(String(err?.message ?? err)), `cap message honest (got ${err?.message})`);

    // ── Approval-path cap: a 30% refund is legal at creation (60+30<=100),
    //    then a legacy 50% 'approved' row appears (stale base). Approving the
    //    30% must now FAIL the in-tx cumulative re-check (60+50+30 > 100) and
    //    move NO money.
    const r3 = await tenant.orderCrud.refund({ orderId: order.orderId, amount: Math.round(total * 0.3 * 100) / 100, reason: "J251 part 3" });
    const legacyId = crypto.randomUUID();
    await world.db.insert(schema.refunds).values({
      id: legacyId, orderId: order.orderId, tenantId: TENANT_ID,
      amount: (Math.round(total * 0.5 * 100) / 100).toFixed(2), currency: "NGN",
      reason: "legacy stale-base refund", status: "approved", createdAt: new Date(), updatedAt: new Date(),
    });
    const postsBefore = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund")).length;
    const capErr = await expectTrpcError(
      tenant.orderCrud.processRefund({ refundId: r3.refundId, action: "approved" }),
      "BAD_REQUEST",
      "approval cap re-check rejects",
    );
    assert(/exceed the order total/.test(String(capErr?.message ?? capErr)), "approval cap message honest");
    const postsAfter = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund")).length;
    assert(postsAfter === postsBefore, "NO provider refund issued when the cap re-check fails");
    const [row3] = await world.db.select().from(schema.refunds).where(eq(schema.refunds.id, r3.refundId));
    assert(row3.status === "pending", `rejected refund stays pending (got ${row3.status})`);
  },
};
