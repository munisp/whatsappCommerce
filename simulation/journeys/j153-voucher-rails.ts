/**
 * J153 — Government/NGO voucher rails: issue → eligible redeem →
 * double-redeem rejected → issuer settlement report.
 * An NGO program (budget 1,000,000 cents, eligible phones + "food" category
 * only) issues 100,000-cent vouchers deterministically. The eligible
 * recipient redeems against a real chat order (category restriction passes);
 * a second redeem of the same code is rejected (transactional claim);
 * category-mismatched and wrong-phone redemptions are rejected; the issuer
 * report reconciles budget/issued/redeemed/outstanding exactly and exports
 * CSV.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, createChatOrderViaNlp, expectTrpcError, publicCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J153",
  name: "voucher issue → redeem → reconcile",
  feature: "voucher rails + eligibility + double-redeem guard + issuer report",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const recipient = world.newPhone("v1");
    const outsider = world.newPhone("v2");
    await world.grantConsent(recipient);
    await world.grantConsent(outsider);

    const admin = await adminCaller();
    const program = await admin.vouchers.createProgram({
      tenantId: TENANT_ID,
      issuer: "Sim NGO Foundation",
      name: "Food Support 2026",
      budgetCents: 1_000_000,
      eligiblePhones: [recipient],
      eligibleCategories: ["food"],
    });
    assert(program.issuedCents === 0, "program starts unissued");

    // Ineligible recipient is skipped at issuance.
    const issue = await admin.vouchers.issue({
      tenantId: TENANT_ID, programId: program.id,
      recipients: [recipient, outsider], amountCents: 100_000,
    });
    assert(issue.issued.length === 1, "only the eligible recipient gets a voucher");
    assert(issue.skipped.length === 1 && issue.skipped[0] === outsider, "ineligible recipient skipped");
    const voucher = issue.issued[0];
    assert(/^[A-Z0-9]{16}$/.test(voucher.code), "deterministic 16-char code");
    assert(voucher.amountCents === 100_000, "voucher face value");

    // Budget enforcement: 10 × 100,000 more would exceed the budget.
    await expectTrpcError(
      admin.vouchers.issue({
        tenantId: TENANT_ID, programId: program.id,
        recipients: Array(10).fill(recipient), amountCents: 100_000,
      }),
      "BAD_REQUEST", "over-budget issuance rejected",
    );

    // Eligible redemption against a real chat order (food category passes).
    const order = await createChatOrderViaNlp(world, recipient, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    const caller = await tenantCaller(TENANT_ID);
    const redeemed = await caller.vouchers.redeem({
      tenantId: TENANT_ID, code: voucher.code, orderId: order.orderId,
      phone: recipient, purchasedCategories: ["food"],
    });
    assert(redeemed.voucher.status === "redeemed", "voucher redeemed");
    assert(redeemed.voucher.orderId === order.orderId, "redemption linked to the order");
    assert(redeemed.program.redeemedCents === 100_000, "program redeemedCents moved");

    // Double-redeem rejected — transactional claim guard.
    await expectTrpcError(
      caller.vouchers.redeem({
        tenantId: TENANT_ID, code: voucher.code, orderId: order.orderId,
        phone: recipient, purchasedCategories: ["food"],
      }),
      "FORBIDDEN", "double redeem rejected",
    );
    const [vRow] = await world.db.select().from(schema.vouchers)
      .where(eq(schema.vouchers.code, voucher.code));
    assert(vRow.status === "redeemed", "status stays redeemed");
    const [pRow] = await world.db.select().from(schema.voucherPrograms)
      .where(eq(schema.voucherPrograms.id, program.id));
    assert(pRow.redeemedCents === 100_000, "double redeem did not move counters twice");

    // Wrong phone is ineligible even with the right code (fresh voucher).
    const issue2 = await admin.vouchers.issue({
      tenantId: TENANT_ID, programId: program.id, recipients: [recipient], amountCents: 50_000,
    });
    const voucher2 = issue2.issued[0];
    const order2 = await createChatOrderViaNlp(world, outsider, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    await expectTrpcError(
      caller.vouchers.redeem({
        tenantId: TENANT_ID, code: voucher2.code, orderId: order2.orderId,
        phone: outsider, purchasedCategories: ["food"],
      }),
      "FORBIDDEN", "wrong phone rejected",
    );

    // Category restriction enforced.
    await expectTrpcError(
      caller.vouchers.redeem({
        tenantId: TENANT_ID, code: voucher2.code, orderId: order.orderId,
        phone: recipient, purchasedCategories: ["electronics"],
      }),
      "FORBIDDEN", "category mismatch rejected",
    );
    const [v2Row] = await world.db.select().from(schema.vouchers)
      .where(eq(schema.vouchers.code, voucher2.code));
    assert(v2Row.status === "issued", "failed redemptions leave the voucher issued");

    // Public check-by-code: correct phone sees it; wrong phone does not.
    const anon = await publicCaller();
    const check = await anon.vouchers.checkByCode({ code: voucher2.code, phone: recipient });
    assert(check.amountCents === 50_000 && check.status === "issued", "public check returns the voucher");
    await expectTrpcError(
      anon.vouchers.checkByCode({ code: voucher2.code, phone: outsider }),
      "NOT_FOUND", "public check hides other recipients' vouchers",
    );

    // Issuer settlement report + CSV export reconcile exactly.
    const report = await admin.vouchers.report({ tenantId: TENANT_ID, programId: program.id });
    assert(report.budgetCents === 1_000_000, "report budget");
    assert(report.issuedCents === 150_000, `report issued (got ${report.issuedCents})`);
    assert(report.redeemedCents === 100_000, "report redeemed");
    assert(report.outstandingCents === 50_000, "report outstanding = issued − redeemed");
    assert(report.remainingBudgetCents === 850_000, "report remaining budget");
    assert(report.voucherCount === 2 && report.redeemedCount === 1, "report counts");
    const { csv } = await admin.vouchers.reportCsv({ tenantId: TENANT_ID, programId: program.id });
    assertIncludes(csv, "Sim NGO Foundation", "CSV names the issuer");
    assertIncludes(csv, voucher.code, "CSV lists the redeemed voucher");
    assertIncludes(csv, "redeemed", "CSV shows redemption status");

    // Tenant isolation: another tenant cannot read the program report.
    const other = await tenantCaller("sim-supplier");
    await expectTrpcError(
      other.vouchers.report({ tenantId: TENANT_ID, programId: program.id }),
      "FORBIDDEN", "cross-tenant report access rejected",
    );
  },
};
