/**
 * === W38 money-integrity (Coder A) ===
 * J248 — PAY-2 verify-before-retry: the SLA refund sweep asks the provider
 * FIRST; when the provider already has the refund (the original attempt
 * "timed out" but was accepted), the sweep clears the flag WITHOUT issuing
 * another refund — no double-refund after an ambiguous timeout.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J248",
  name: "PAY-2: sweep verifies provider status before any retry",
  feature: "W38 sla.ts verify-first refund sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("pay2-verify");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const payRes = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(payRes.status === 200, "webhook accepted");

    const [escrow] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    assert(escrow, "escrow exists");

    // Flag the escrow as needing the provider-refund leg (as a failed cancel
    // would) — the ambiguous-timeout scenario.
    await world.db.update(schema.escrowTransactions).set({
      metadata: { ...((escrow.metadata ?? {}) as Record<string, unknown>), refundSweepRequired: true, providerRefundOnly: true },
    }).where(eq(schema.escrowTransactions.id, escrow.id));

    // Provider truth: the refund ALREADY exists provider-side (the "timeout"
    // actually succeeded). The sweep must verify and NOT re-issue.
    pay.refundVerifyState = "exists";
    const postsBefore = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund")).length;

    const { runSlaScan } = await import("../../server/routers/sla");
    await runSlaScan();

    const postsAfter = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund")).length;
    assert(postsAfter === postsBefore, "sweep issued NO blind retry when provider already has the refund");
    const verifies = pay.calls.filter((c) => c.method === "GET" && c.url.includes("/refund"));
    assert(verifies.length >= 1, "sweep queried the provider refund status first");

    const [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    const meta = (esc.metadata ?? {}) as Record<string, unknown>;
    assert(meta.refundSweepRequired === false, "sweep flag cleared after verify");
    assert(meta.providerRefundVerifiedExisting === true, "verified-existing marker recorded");

    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(ord.paymentStatus === "refund_initiated", `order honestly refund_initiated (got ${ord.paymentStatus})`);

    const attempts = await world.db.select().from(schema.refundAttempts)
      .where(eq(schema.refundAttempts.orderId, order.orderId));
    assert(attempts.some((a) => a.status === "verified_existing"), "verified_existing attempt journaled");
  },
};
