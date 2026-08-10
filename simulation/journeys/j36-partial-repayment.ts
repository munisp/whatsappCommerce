/**
 * J36 — Partial repayment: ₦100,000 drawn on the facility → the buyer pays
 * ₦40,000 via a credit-repayment link (Paystack mock intercept, metadata kind
 * credit_repayment) → outstanding drops to ₦60,000 and a repayment ledger
 * row lands → REPLAYING the same webhook does NOT double-apply
 * (processed_webhook_events claim).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID, TENANT_ID, CREDIT_ACCOUNT_ID } from "../world";
import { creditAccount, creditLedgerRows, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J36",
  name: "partial credit repayment",
  feature: "creditRepayLink → applyRepayment, replay dedupe",
  async run(world) {
    const phone = world.newPhone("a");

    // Seed ₦100,000 outstanding via the real draw path.
    const { drawOnCredit } = await import("../../server/services/tradeCredit");
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 10_000_000,
      poId: "po-j36-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");
    assert((await creditAccount(world)).outstandingCents === 10_000_000, "outstanding ₦100,000");

    // ── Buyer repayment link for a PARTIAL amount (₦40,000) ───────────────
    const { createRepaymentLink } = await import("../../server/services/creditRepayLink");
    const link = await createRepaymentLink(world.db, {
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 4_000_000,
      customerPhone: phone,
    });
    assert(link.amountCents === 4_000_000, "link for the partial amount");
    assert(link.paymentUrl.startsWith("https://checkout.paystack.com/sim/"), `link via Paystack mock (got ${link.paymentUrl})`);
    const psInit = world.outbound.all().find(
      (c) => c.url.includes("api.paystack.co/transaction/initialize") && JSON.stringify(c.body ?? {}).includes(link.reference),
    );
    assert(psInit, "Paystack initialize intercepted for the repayment reference");

    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [intent] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.providerPaymentId, link.reference)).limit(1);
    assert(intent, "repayment intent persisted");
    assert((intent.metadata as any)?.kind === "credit_repayment", "intent metadata kind credit_repayment");
    assert((intent.metadata as any)?.accountId === CREDIT_ACCOUNT_ID, "intent carries the account id");

    // ── Provider confirm webhook applies the repayment ────────────────────
    const confirm = await paystackChargeSuccess(world, { reference: link.reference, amountMajor: 40_000 });
    assert(confirm.status === 200, `webhook accepted (got ${confirm.status})`);

    const account = await creditAccount(world);
    assert(Number(account.outstandingCents) === 6_000_000, `outstanding drops to ₦60,000 (got ${account.outstandingCents})`);

    const repayments = (await creditLedgerRows(world, "repayment")).filter((r: any) => r.ref === link.reference);
    assert(repayments.length === 1, `one repayment ledger row (got ${repayments.length})`);
    assert(Number(repayments[0].amountCents) === 4_000_000, "repayment amount ₦40,000");

    // Partial repayment: the ₦100,000 draw is NOT fully covered → stays posted.
    const draws = await creditLedgerRows(world, "invoice_draw");
    assert(draws.length === 1 && draws[0].status === "posted", "partially-covered draw stays posted");

    // ── Replay: processed_webhook_events claim blocks double-apply ────────
    const replay = await paystackChargeSuccess(world, { reference: link.reference, amountMajor: 40_000 });
    assert(replay.status === 200, "replay accepted");
    const afterReplay = await creditAccount(world);
    assert(Number(afterReplay.outstandingCents) === 6_000_000, `replay does not double-apply (got ${afterReplay.outstandingCents})`);
    const repaymentsAfter = (await creditLedgerRows(world, "repayment")).filter((r: any) => r.ref === link.reference);
    assert(repaymentsAfter.length === 1, "still one repayment ledger row after replay");
    const [claim] = await world.db
      .select()
      .from(schema.processedWebhookEvents)
      .where(eq(schema.processedWebhookEvents.id, `credit-repayment:${link.reference}`))
      .limit(1);
    assert(claim, "dedupe claim recorded in processed_webhook_events");
  },
};
