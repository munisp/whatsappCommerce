/**
 * J63 — Mandate charge failure fallback (W13). With an active mandate, the
 * paystack mock DECLINES the off-session charge → initiateRepayment degrades
 * gracefully: a dunning notice is queued to the buyer's admin phone, NO
 * settlement happens, the exactly-once claim is released, the mandate stays
 * active (a single decline does not revoke it), and the caller gets a
 * payment link instead. Paying that link later settles the balance EXACTLY
 * once (replay-safe).
 */
import { eq } from "drizzle-orm";
import { assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { setMandateChargeStatus } from "../metaMock";
import { ADMIN_PHONE, CREDIT_ACCOUNT_ID, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { creditAccount, creditLedgerRows, linkActiveMandate, paystackChargeSuccess, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J63",
  name: "mandate charge failure fallback",
  feature: "declined mandate charge → dunning + payment-link fallback",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // Seed ₦80,000 outstanding via the real draw path.
    const { drawOnCredit } = await import("../../server/services/tradeCredit");
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 8_000_000,
      poId: "po-j63-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");

    const mandate = await linkActiveMandate(world, { buyerTenantId: TENANT_ID, accountId: CREDIT_ACCOUNT_ID });
    const buyer = await tenantCaller(TENANT_ID, { userId: 263 });

    // ── Provider declines the mandate charge ──────────────────────────────
    setMandateChargeStatus(402);
    const res = await buyer.tradeCredit.initiateRepayment({
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 8_000_000,
      customerPhone: ADMIN_PHONE,
    });
    setMandateChargeStatus(null);

    // Graceful fallback: a payment link is returned, the decline is surfaced.
    assert((res as any).mode === "payment_link", `falls back to a payment link (${JSON.stringify(res)})`);
    assert((res as any).reason === "charge_failed", "fallback reason charge_failed");
    const linkRef = (res as any).reference as string;
    assert(typeof (res as any).paymentUrl === "string" && (res as any).paymentUrl.includes("checkout.paystack.com/sim/"),
      "payment link issued for the fallback");

    // The decline attempt WAS recorded against the mock (exactly once).
    const charges = world.outbound.all().filter((c) => c.url.includes("api.paystack.co/transaction/charge_authorization"));
    assert(charges.length === 1, `one declined charge attempt (got ${charges.length})`);
    const mandateRef = new RegExp(`^cr-${CREDIT_ACCOUNT_ID}-`);
    assert(mandateRef.test(charges[0].body?.reference ?? ""), "declined charge carried the cr-{accountId}-* reference");

    // NO settlement: outstanding + ledger untouched.
    assert(Number((await creditAccount(world)).outstandingCents) === 8_000_000, "no settlement on charge failure");
    assert((await creditLedgerRows(world, "repayment")).length === 0, "no repayment ledger row");

    // The exactly-once claim was RELEASED (a later retry can re-claim).
    const [claim] = await world.db
      .select()
      .from(schema.processedWebhookEvents)
      .where(eq(schema.processedWebhookEvents.id, charges[0].body.reference))
      .limit(1);
    assert(!claim, "failed-charge claim released");

    // Dunning notice queued to the buyer tenant's admin phone.
    const notice = world.outbound.findByBody("couldn't collect", ADMIN_PHONE).pop();
    assert(notice, "dunning notice sent to the buyer admin");
    assert(bodyText(notice).includes("payment mandate"), "notice names the mandate");
    assert(bodyText(notice).includes("₦80,000"), "notice carries the amount");

    // Mandate marked appropriately: still ACTIVE (a decline is not a revoke).
    const [mandateRow] = await world.db
      .select()
      .from(schema.paymentMandates)
      .where(eq(schema.paymentMandates.id, mandate.mandateId))
      .limit(1);
    assert(mandateRow?.status === "active", "mandate stays active after a single decline");

    // ── Later successful link payment settles EXACTLY once ────────────────
    const pay = await paystackChargeSuccess(world, { reference: linkRef, amountMajor: 80_000 });
    assert(pay.status === 200, `fallback link payment confirmed (got ${pay.status})`);
    assert(Number((await creditAccount(world)).outstandingCents) === 0, "link payment settles the balance");
    const repayRows = (await creditLedgerRows(world, "repayment")).filter((r: any) => r.ref === linkRef);
    assert(repayRows.length === 1 && Number(repayRows[0].amountCents) === 8_000_000, "one repayment row for the link payment");
    const drawsDone = await creditLedgerRows(world, "invoice_draw");
    assert(drawsDone.length === 1 && drawsDone[0].status === "settled", "draw settled via the fallback link");

    const replay = await paystackChargeSuccess(world, { reference: linkRef, amountMajor: 80_000 });
    assert(replay.status === 200, "replay accepted");
    assert(Number((await creditAccount(world)).outstandingCents) === 0, "replay does not double-settle");
    assert((await creditLedgerRows(world, "repayment")).length === 1, "still one repayment row after replay");
  },
};
