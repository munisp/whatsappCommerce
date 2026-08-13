/**
 * J58 — KYB-gated trade credit. A pending buyer credit facility cannot be
 * approved while EITHER side lacks an approved KYB:
 *   1. supplier + buyer both unverified → approveAccount 403
 *   2. buyer verified only              → still 403
 *   3. both verified                    → approved (active)
 * Then a draw on the facility succeeds via the REAL wave-8 credit-draw path
 * (claim-first atomic guard + ledger row in one transaction).
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J58",
  name: "KYB-gated credit",
  feature: "tradeCredit.approveAccount dual-KYB gate",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    const sup = (await admin.onboarding.start({ name: "Credit Supplier Co" })).tenantId;
    const buy = (await admin.onboarding.start({ name: "Credit Buyer Co" })).tenantId;
    const supCaller = await tenantCaller(sup, { userId: 92 });
    const buyCaller = await tenantCaller(buy, { userId: 93 });

    // Buyer-requested facility, pending supplier approval (₦250,000, net-14).
    const accountId = randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId,
      supplierTenantId: sup,
      buyerTenantId: buy,
      limitCents: 25_000_000,
      outstandingCents: 0,
      termsDays: 14,
      status: "pending",
    });

    const approve = () =>
      supCaller.tradeCredit.approveAccount({ supplierTenantId: sup, accountId });

    // ── 1. Both sides unverified → 403 ────────────────────────────────────
    const e1 = await expectTrpcError(approve(), "FORBIDDEN", "approve with both sides unverified");
    assert(e1.message.includes("KYB"), "refusal names the KYB gate");

    // ── 2. Buyer verified only → still 403 (supplier side unverified) ─────
    const buyApp = await buyCaller.kyc.getOrCreateApplication({ tenantId: buy, type: "kyb" });
    await admin.kyc.review({ applicationId: buyApp.id, decision: "approved" });
    const e2 = await expectTrpcError(approve(), "FORBIDDEN", "approve with only buyer verified");
    assert(e2.message.includes(sup), "refusal identifies the unverified supplier");

    // ── 3. Both verified → approved ────────────────────────────────────────
    const supApp = await supCaller.kyc.getOrCreateApplication({ tenantId: sup, type: "kyb" });
    await admin.kyc.review({ applicationId: supApp.id, decision: "approved" });
    // W13: the ₦250k facility is above the ₦50k micro-credit floor, so the
    // buyer needs an active repayment mandate before approval (dev fake).
    await world.db.insert(schema.paymentMandates).values({
      tenantId: buy,
      provider: "fake",
      mandateRef: `fake-j58-${accountId.slice(0, 8)}`,
      status: "active",
      metadata: { devFakeMandate: true },
    });
    const approved = await approve();
    assert(approved.status === "active", `facility approved → active (got ${approved.status})`);
    const [acct] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(acct.status === "active", "account row active in DB");

    // ── Draw works through the REAL wave-8 credit path ─────────────────────
    const { drawOnCreditTx } = await import("../../server/services/tradeCredit/draw");
    const draw = await drawOnCreditTx(world.db, {
      supplierTenantId: sup,
      buyerTenantId: buy,
      amountCents: 2_900_000, // ₦29,000 — the wave-8 PO subtotal
      poId: randomUUID(),
    });
    assert(draw.ok === true, `draw succeeded (${JSON.stringify(draw)})`);
    if (draw.ok) assert(draw.outstandingAfter === 2_900_000, "outstanding = draw amount");
    const [acctAfter] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(acctAfter.outstandingCents === 2_900_000, "outstanding persisted");
    const ledger = await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.creditAccountId, accountId));
    assert(ledger.length === 1 && ledger[0].kind === "invoice_draw", "invoice_draw ledger row written");

    // Cross-tenant control: the BUYER cannot approve its own facility.
    await expectTrpcError(
      buyCaller.tradeCredit.approveAccount({ supplierTenantId: sup, accountId }),
      "FORBIDDEN",
      "buyer approving supplier-owned facility",
    );
  },
};
