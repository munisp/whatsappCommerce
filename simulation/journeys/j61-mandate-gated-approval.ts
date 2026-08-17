/**
 * J61 — Mandate-gated credit approval (W13). A facility ABOVE the ₦50,000
 * micro-credit floor cannot be activated without an ACTIVE repayment
 * mandate:
 *   1. approve (₦250k) with NO mandate        → PRECONDITION_FAILED
 *   2. requestMandate → paystack authorization URL, mandate PENDING
 *   3. approve while the mandate is PENDING   → still PRECONDITION_FAILED
 *   4. confirmMandate → active → approve      → succeeds, mandate linked
 *   5. a ≤floor (₦50,000) facility activates mandate-free (frictionless
 *      micro-credit) — no payment_mandates row exists for that buyer.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J61",
  name: "mandate-gated approval",
  feature: "approveAccount mandate gate (₦50k floor)",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    const sup = (await admin.onboarding.start({ name: "Mandate Supplier Co" })).tenantId;
    const buy = (await admin.onboarding.start({ name: "Mandate Buyer Co" })).tenantId;
    const supCaller = await tenantCaller(sup, { userId: 161 });
    const buyCaller = await tenantCaller(buy, { userId: 162 });

    // Dual-KYB gate (W12) must pass first so the mandate gate is what refuses.
    const supApp = await supCaller.kyc.getOrCreateApplication({ tenantId: sup, type: "kyb" });
    await admin.kyc.review({ applicationId: supApp.id, decision: "approved" });
    const buyApp = await buyCaller.kyc.getOrCreateApplication({ tenantId: buy, type: "kyb" });
    await admin.kyc.review({ applicationId: buyApp.id, decision: "approved" });

    // Buyer-requested facility, pending supplier approval.
    const accountId = randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId,
      supplierTenantId: sup,
      buyerTenantId: buy,
      limitCents: 0,
      outstandingCents: 0,
      termsDays: 14,
      status: "pending",
    });

    const approve = () =>
      supCaller.tradeCredit.approveAccount({ supplierTenantId: sup, accountId, limitCents: 25_000_000 });

    // ── 1. Above-floor approval with NO mandate → PRECONDITION_FAILED ─────
    const e1 = await expectTrpcError(approve(), "PRECONDITION_FAILED", "approve above floor without mandate");
    assert(/mandate/i.test(e1.message), "refusal names the mandate requirement");
    const [stillPending] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(stillPending.status === "pending", "account NOT activated by the refused approval");

    // ── 2. requestMandate → provider authorization URL, mandate PENDING ───
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    const up = await upsertTenantProviderConfig({
      tenantId: buy,
      provider: "paystack",
      creds: { secretKey: "sk_sim_j61" },
    });
    assert(up.ok, "buyer paystack config stored");

    const mandate = await buyCaller.tradeCredit.requestMandate({ buyerTenantId: buy, accountId });
    assert(mandate.ok === true, `requestMandate ok (${JSON.stringify(mandate)})`);
    assert(mandate.status === "pending", `mandate pending authorization (got ${mandate.status})`);
    assert(
      typeof mandate.authorizationUrl === "string" && mandate.authorizationUrl.includes("checkout.paystack.com/sim/"),
      `authorization URL from the paystack mock (got ${mandate.authorizationUrl})`);
    const initCall = world.outbound.all().find(
      (c) => c.url.includes("api.paystack.co/transaction/initialize") && c.body?.metadata?.mandate === true,
    );
    assert(initCall, "paystack initialize carried metadata.mandate=true");

    const [mandateRow] = await world.db.select().from(schema.paymentMandates).where(eq(schema.paymentMandates.id, mandate.mandateId)).limit(1);
    assert(mandateRow?.status === "pending", "payment_mandates row pending");
    const [linked] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(linked.mandateId === mandate.mandateId, "pending mandate linked to the facility");

    // ── 3. Approval while the mandate is PENDING → still refused ──────────
    await expectTrpcError(approve(), "PRECONDITION_FAILED", "approve with pending mandate");

    // ── 4. confirmMandate → active → approval succeeds ────────────────────
    const confirmed = await buyCaller.tradeCredit.confirmMandate({ buyerTenantId: buy, mandateId: mandate.mandateId });
    assert(confirmed.status === "active", "mandate active after confirm");
    const approved = await approve();
    assert(approved.status === "active", `facility approved → active (got ${approved.status})`);
    assert(Number(approved.limitCents) === 25_000_000, "limit set at approval");
    const [finalRow] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(finalRow.status === "active" && finalRow.mandateId === mandate.mandateId, "active facility with linked mandate");

    // ── 5. ≤floor facility activates mandate-free ─────────────────────────
    const buy2 = (await admin.onboarding.start({ name: "Micro Buyer Co" })).tenantId;
    const buy2Caller = await tenantCaller(buy2, { userId: 163 });
    const buy2App = await buy2Caller.kyc.getOrCreateApplication({ tenantId: buy2, type: "kyb" });
    await admin.kyc.review({ applicationId: buy2App.id, decision: "approved" });
    const floorAccountId = randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: floorAccountId,
      supplierTenantId: sup,
      buyerTenantId: buy2,
      limitCents: 0,
      outstandingCents: 0,
      termsDays: 14,
      status: "pending",
    });
    const floorApproved = await supCaller.tradeCredit.approveAccount({
      supplierTenantId: sup,
      accountId: floorAccountId,
      limitCents: 5_000_000, // exactly the ₦50,000 micro-credit floor
    });
    assert(floorApproved.status === "active", "floor-level facility activates mandate-free");
    const buy2Mandates = await world.db.select().from(schema.paymentMandates).where(eq(schema.paymentMandates.tenantId, buy2));
    assert(buy2Mandates.length === 0, "no mandate exists for the floor-level buyer");
  },
};
