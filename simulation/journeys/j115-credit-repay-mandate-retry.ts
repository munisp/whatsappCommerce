/**
 * J115 — C2 stakeholder journey: customer buys on credit → repayment link
 * (IDEMPOTENT reference — a repeated request returns the same link) →
 * provider webhook applies the partial repayment exactly-once → mandate
 * auto-charge for the balance is DECLINED → graceful fallback → retry with
 * the provider recovered charges at source → balance cleared.
 *
 * Gap fixed this wave: creditRepayLink.createRepaymentLink now accepts an
 * idempotencyKey (additive) — repeated link requests reuse the open intent
 * instead of minting duplicate references.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { setMandateChargeStatus } from "../metaMock";
import { ADMIN_PHONE, CREDIT_ACCOUNT_ID, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import {
  creditAccount, creditLedgerRows, linkActiveMandate, paystackChargeSuccess, tenantCaller,
} from "./helpers";

const chargeAuthCalls = (world: World) =>
  world.outbound.all().filter((c) => c.url.includes("api.paystack.co/transaction/charge_authorization"));

export const journey: Journey = {
  id: "J115",
  name: "credit buy → repay link (idempotent) → webhook → mandate retry → cleared",
  feature: "C2 credit repayment lifecycle end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // ── 1. Buy on credit: ₦60,000 drawn via the real draw path ───────────
    const { drawOnCredit } = await import("../../server/services/tradeCredit");
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 6_000_000,
      poId: "po-j115-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "credit purchase (draw) succeeds");
    assert(Number((await creditAccount(world)).outstandingCents) === 6_000_000, "outstanding ₦60,000");

    // ── 2. Repayment link with an idempotent reference ───────────────────
    const buyer = await tenantCaller(TENANT_ID, { userId: 2115 });
    const phone = world.newPhone("c2");
    const link1 = await buyer.creditRepay.requestRepaymentLink({
      tenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 2_000_000,
      customerPhone: phone,
      idempotencyKey: "j115-repay-partial",
    });
    assert(link1.reference && link1.paymentUrl, "repayment link created");
    // Retry-safe: the same key returns the SAME reference + intent, no dup.
    const link2 = await buyer.creditRepay.requestRepaymentLink({
      tenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 2_000_000,
      customerPhone: phone,
      idempotencyKey: "j115-repay-partial",
    });
    assert(link2.reference === link1.reference && link2.paymentIntentId === link1.paymentIntentId,
      `idempotent retry reuses the link (got ${link2.reference} vs ${link1.reference})`);
    const intents = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, link1.reference));
    assert(intents.length === 1, "exactly one intent for the idempotent key");

    // ── 3. Provider webhook applies the partial repayment exactly-once ───
    const pay1 = await paystackChargeSuccess(world, { reference: link1.reference, amountMajor: 20_000 });
    assert(pay1.status === 200, `repayment webhook accepted (got ${pay1.status})`);
    assert(Number((await creditAccount(world)).outstandingCents) === 4_000_000, "outstanding drops to ₦40,000");
    const repayRows = (await creditLedgerRows(world, "repayment")).filter((r: any) => r.ref === link1.reference);
    assert(repayRows.length === 1 && Number(repayRows[0].amountCents) === 2_000_000, "one ₦20,000 repayment row");
    const replay = await paystackChargeSuccess(world, { reference: link1.reference, amountMajor: 20_000 });
    assert(replay.status === 200, "replay accepted");
    assert(Number((await creditAccount(world)).outstandingCents) === 4_000_000, "replay does not double-apply");

    // ── 4. Mandate auto-charge for the balance FAILS → graceful fallback ─
    const mandate = await linkActiveMandate(world, { buyerTenantId: TENANT_ID, accountId: CREDIT_ACCOUNT_ID });
    const chargesBefore = chargeAuthCalls(world).length;
    setMandateChargeStatus(402);
    const failed = await buyer.tradeCredit.initiateRepayment({
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 4_000_000,
      customerPhone: ADMIN_PHONE,
    });
    setMandateChargeStatus(null);
    assert((failed as any).mode === "payment_link" && (failed as any).reason === "charge_failed",
      `declined mandate charge falls back to a payment link (${JSON.stringify(failed)})`);
    assert(chargeAuthCalls(world).length === chargesBefore + 1, "one declined charge attempt recorded");
    assert(Number((await creditAccount(world)).outstandingCents) === 4_000_000, "no settlement on charge failure");
    const [mandateRow] = await world.db.select().from(schema.paymentMandates)
      .where(eq(schema.paymentMandates.id, mandate.mandateId)).limit(1);
    assert(mandateRow?.status === "active", "mandate stays active after a single decline");

    // ── 5. Retry with the provider recovered → balance cleared ───────────
    const retry = await buyer.tradeCredit.initiateRepayment({
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 4_000_000,
      customerPhone: ADMIN_PHONE,
    });
    assert(retry.ok === true && retry.mode === "mandate", `retry charges the mandate at source (${JSON.stringify(retry)})`);
    assert(Number((await creditAccount(world)).outstandingCents) === 0, "balance cleared after the retry");
    const draws = await creditLedgerRows(world, "invoice_draw");
    assert(draws.length === 1 && draws[0].status === "settled", "the credit purchase is fully settled");

    // Double-submit after full settlement is refused BEFORE any provider charge.
    const chargesAfter = chargeAuthCalls(world).length;
    let refused: Error | null = null;
    try {
      await buyer.tradeCredit.initiateRepayment({
        buyerTenantId: TENANT_ID,
        accountId: CREDIT_ACCOUNT_ID,
        amountCents: 4_000_000,
        customerPhone: ADMIN_PHONE,
      });
    } catch (e: any) {
      refused = e;
    }
    assert(refused, "repayment with nothing outstanding is refused");
    assert(chargeAuthCalls(world).length === chargesAfter, "refusal happens before any provider charge");
  },
};
