/**
 * J51 — Credit repayment via a NON-paystack provider: the buyer tenant has a
 * flutterwave-led provider chain, so createRepaymentLink's registry-driven
 * initiation is served by flutterwave (credit_repayment metadata rides the
 * flw `meta` field). The flw-signed webhook through the unified route
 * triggers the claim-first applyRepayment (outstanding decreases); a webhook
 * replay does NOT double-apply (processed_webhook_events claim).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID, TENANT_ID, CREDIT_ACCOUNT_ID } from "../world";
import { creditAccount, creditLedgerRows, flutterwaveChargeSuccess } from "./helpers";

const FLW_SECRET_KEY = "flw_sk_sim_repay";
const FLW_SECRET_HASH = "flw_hash_sim_repay";

export const journey: Journey = {
  id: "J51",
  name: "credit repayment via flutterwave",
  feature: "creditRepayLink → registry chain → applyRepayment",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    const phone = world.newPhone("a");

    // Buyer tenant chain leads with flutterwave (priority above seeded paystack).
    const up = await upsertTenantProviderConfig({
      tenantId: TENANT_ID,
      provider: "flutterwave",
      creds: { secretKey: FLW_SECRET_KEY, secretHash: FLW_SECRET_HASH },
      priority: 10,
    });
    assert(up.ok, "flutterwave config upserted for the buyer tenant");

    // Seed ₦100,000 outstanding via the real draw path (J36 pattern).
    const { drawOnCredit } = await import("../../server/services/tradeCredit");
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 10_000_000,
      poId: "po-j51-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");
    assert((await creditAccount(world)).outstandingCents === 10_000_000, "outstanding ₦100,000");

    // ── Repayment link → served by flutterwave ────────────────────────────
    const { createRepaymentLink } = await import("../../server/services/creditRepayLink");
    const link = await createRepaymentLink(world.db, {
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 4_000_000,
      customerPhone: phone,
    });
    assert(link.provider === "flutterwave", `flutterwave served the repayment link (got ${link.provider})`);
    assert(
      link.paymentUrl?.startsWith("https://checkout.flutterwave.com/sim/"),
      `flw link (got ${link.paymentUrl})`,
    );
    const flwInit = world.outbound.all().find(
      (c) => c.url.includes("api.flutterwave.com/v3/payments") && JSON.stringify(c.body ?? {}).includes(link.reference),
    );
    assert(flwInit, "flutterwave init intercepted for the repayment reference");
    assert(flwInit.body?.meta?.kind === "credit_repayment", "credit_repayment metadata rides the flw meta field");
    assert(flwInit.body?.meta?.accountId === CREDIT_ACCOUNT_ID, "account id rides the flw meta field");

    const [intent] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.providerPaymentId, link.reference)).limit(1);
    assert(intent, "repayment intent persisted");
    assert((intent.metadata as any)?.kind === "credit_repayment", "intent metadata kind credit_repayment");
    assert((intent.metadata as any)?.servedProvider === "flutterwave", "servedProvider=flutterwave on the intent");

    // ── flw webhook (credit_repayment) → claim-first applyRepayment ────────
    const confirm = await flutterwaveChargeSuccess(world, {
      reference: link.reference,
      amountMajor: 40_000,
      secretHash: FLW_SECRET_HASH,
      metadata: { tenant_id: TENANT_ID, kind: "credit_repayment", accountId: CREDIT_ACCOUNT_ID },
    });
    assert(confirm.status === 200, `flw webhook accepted (got ${confirm.status}: ${JSON.stringify(confirm.json)})`);

    const account = await creditAccount(world);
    assert(Number(account.outstandingCents) === 6_000_000, `outstanding drops to ₦60,000 (got ${account.outstandingCents})`);
    const repayments = (await creditLedgerRows(world, "repayment")).filter((r: any) => r.ref === link.reference);
    assert(repayments.length === 1, `one repayment ledger row (got ${repayments.length})`);
    assert(Number(repayments[0].amountCents) === 4_000_000, "repayment amount ₦40,000");

    // ── Replay: no double-apply (processed_webhook_events claim) ───────────
    const replay = await flutterwaveChargeSuccess(world, {
      reference: link.reference,
      amountMajor: 40_000,
      secretHash: FLW_SECRET_HASH,
      metadata: { tenant_id: TENANT_ID, kind: "credit_repayment", accountId: CREDIT_ACCOUNT_ID },
    });
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
