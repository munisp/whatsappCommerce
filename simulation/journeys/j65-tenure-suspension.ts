/**
 * J65 — Tenure gate + order-access suspension (W13).
 *
 * Part 1 (tenure gate, CREDIT_TENURE_GATE_DAYS=7 re-enabled for this
 * journey): a facility younger than the gate has its FIRST draw refused with
 * { reason: 'frozen', blockedBy: 'tenure' }; an explicit supplier
 * tenureOverride draws anyway; and a facility aged ≥7 days draws without any
 * override.
 *
 * Part 2 (credit control plane): a draw 8 days overdue → the dunning sweep
 * freezes the account AND suspends order access (suspended=true,
 * reason 'dunning_freeze_+7d') → the buyer's WhatsApp PO submission to that
 * supplier is REJECTED with repay-guidance copy and no PO row is created →
 * a full repayment auto-lifts the suspension (repayment.ts) → the same PO
 * submission succeeds again.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { CREDIT_ACCOUNT_ID, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import {
  adminCaller,
  buildProcurementPoViaChat,
  catalogItemNumbers,
  creditAccount,
  enableProcurementMenu,
  paystackChargeSuccess,
  restoreMenu,
  tenantCaller,
} from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J65",
  name: "tenure gate + suspension",
  feature: "first-draw tenure gate; dunning freeze → PO-submit suspension",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const { drawOnCredit, runDunningCheck } = await import("../../server/services/tradeCredit");

    // ── Part 1: first-draw tenure gate ────────────────────────────────────
    process.env.CREDIT_TENURE_GATE_DAYS = "7";
    try {
      const sup = (await admin.onboarding.start({ name: "Tenure Supplier Co" })).tenantId;
      const buy = (await admin.onboarding.start({ name: "Tenure Buyer Co" })).tenantId;
      const supCaller = await tenantCaller(sup, { userId: 165 });
      const buyCaller = await tenantCaller(buy, { userId: 166 });
      const supApp = await supCaller.kyc.getOrCreateApplication({ tenantId: sup, type: "kyb" });
      await admin.kyc.review({ applicationId: supApp.id, decision: "approved" });
      const buyApp = await buyCaller.kyc.getOrCreateApplication({ tenantId: buy, type: "kyb" });
      await admin.kyc.review({ applicationId: buyApp.id, decision: "approved" });

      // Fresh floor-level facility (mandate-free), seconds old.
      const youngId = randomUUID();
      await world.db.insert(schema.creditAccounts).values({
        id: youngId,
        supplierTenantId: sup,
        buyerTenantId: buy,
        limitCents: 0,
        outstandingCents: 0,
        termsDays: 14,
        status: "pending",
      });
      await supCaller.tradeCredit.approveAccount({ supplierTenantId: sup, accountId: youngId, limitCents: 5_000_000 });

      // First draw inside the gate → refused with tenure precision.
      const refused = await drawOnCredit({
        supplierTenantId: sup,
        buyerTenantId: buy,
        amountCents: 1_000_000,
        poId: "po-j65-young",
        termsDays: 14,
      });
      assert(refused.ok === false && refused.reason === "frozen" && refused.blockedBy === "tenure",
        `young facility draw refused by the tenure gate (${JSON.stringify(refused)})`);
      const [youngAcct] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, youngId)).limit(1);
      assert(Number(youngAcct.outstandingCents) === 0, "refused draw moved no money");

      // Supplier override bypasses the gate (recorded supplier decision).
      const override = await drawOnCredit({
        supplierTenantId: sup,
        buyerTenantId: buy,
        amountCents: 1_000_000,
        poId: "po-j65-override",
        termsDays: 14,
        tenureOverride: true,
      });
      assert(override.ok === true, `tenure override draws (${JSON.stringify(override)})`);

      // An AGED facility (created 8 days ago) draws with no override.
      const agedId = randomUUID();
      await world.db.insert(schema.creditAccounts).values({
        id: agedId,
        supplierTenantId: sup,
        buyerTenantId: TENANT_ID,
        limitCents: 5_000_000,
        outstandingCents: 0,
        termsDays: 14,
        status: "active",
      });
      await world.backdate(`UPDATE credit_accounts SET created_at = $1 WHERE id = $2`, [new Date(Date.now() - 8 * DAY_MS), agedId]);
      const aged = await drawOnCredit({
        supplierTenantId: sup,
        buyerTenantId: TENANT_ID,
        amountCents: 500_000,
        poId: "po-j65-aged",
        termsDays: 14,
      });
      assert(aged.ok === true, `aged facility draws past the gate (${JSON.stringify(aged)})`);
    } finally {
      process.env.CREDIT_TENURE_GATE_DAYS = "0";
    }

    // ── Part 2: dunning freeze suspends order access ──────────────────────
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 5_000_000,
      poId: "po-j65-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");
    const t0 = new Date();
    await world.backdate(`UPDATE credit_ledger SET due_date = $1 WHERE id = $2`, [new Date(t0.getTime() - 8 * DAY_MS), draw.ledgerId]);
    const sweep = await runDunningCheck(t0);
    assert(sweep.frozen === 1, `sweep froze the facility (got ${sweep.frozen})`);

    let account = await creditAccount(world);
    assert(account.status === "frozen", "account frozen at +7d");
    assert(account.suspended === true, "order access suspended by the freeze");
    assert(account.suspensionReason === "dunning_freeze_+7d", `suspension reason recorded (got ${account.suspensionReason})`);
    assert(account.suspendedAt, "suspension timestamp recorded");

    // Buyer PO submission to that supplier is REJECTED with repay guidance.
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const before = await enableProcurementMenu(world);
    await world.text(phone, "menu");
    await world.text(phone, "4"); // procurement
    await world.text(phone, "1"); // browse suppliers
    await world.text(phone, "1"); // Lagos Plastics Manufacturing
    const catalogText = bodyText(world.outbound.lastOfType("text", phone));
    const numbers = catalogItemNumbers(catalogText);
    await world.text(phone, `add ${numbers.get("PET Preforms 500ml")} 100`);
    await world.text(phone, `add ${numbers.get("Plastic Crates 20L")} 10`);
    await world.text(phone, "done");
    await world.text(phone, "1"); // pay on credit
    await world.text(phone, "2"); // net 14
    await world.text(phone, "CONFIRM");
    const refusal = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(refusal, "Ordering is suspended with this supplier", "PO submit rejected as suspended");
    assertIncludes(refusal, "Repay your outstanding balance", "repay-guidance copy");
    assertIncludes(refusal, "₦51,000", "guidance carries the fee-inclusive outstanding amount (Fix 4: late fee is collectible)");
    const posWhileSuspended = await world.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.buyerPhone, phone));
    assert(posWhileSuspended.length === 0, "no PO row created while suspended");

    // Full repayment lifts the suspension automatically.
    const { createRepaymentLink } = await import("../../server/services/creditRepayLink");
    const link = await createRepaymentLink(world.db, {
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 5_100_000,
      customerPhone: phone,
    });
    const pay = await paystackChargeSuccess(world, { reference: link.reference, amountMajor: 51_000 });
    assert(pay.status === 200, "full repayment confirmed");
    account = await creditAccount(world);
    assert(Number(account.outstandingCents) === 0, "outstanding fully repaid");
    assert(account.suspended === false, "suspension auto-lifted at zero outstanding");
    assert(account.suspensionReason === null && account.suspendedAt === null, "suspension metadata cleared");

    // The same PO submission succeeds again.
    const po = await buildProcurementPoViaChat(world, phone, { paymentMode: "credit" });
    const [row] = await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.poId)).limit(1);
    assert(row.status === "submitted", `PO submits after the suspension lifts (got ${row.status})`);

    await restoreMenu(world, before);
  },
};
