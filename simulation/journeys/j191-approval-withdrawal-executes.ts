/**
 * J191 — W31 approvals: threshold policy parks a withdrawal; owner approval
 * executes it exactly once (wallet asserted); concurrent/second approve →
 * CONFLICT; step-up OTP still composes for above-step-up-threshold approvals;
 * below-threshold withdrawals keep pre-W31 behavior (no approval row).
 *
 * Uses the withdrawal path (exists on master) as the end-to-end proof; the
 * vendor_bill_payment / scheduled_payment executors are registration hooks
 * wired by the W31 A/B branches (contract in server/services/approvals.ts).
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, expectTrpcError, tenantCaller } from "./helpers";

const TID = "j191-tenant";
const OWNER_PHONE = "+2348019100001";

async function seedStepUp(world: World, userId: number, otp: string): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const { hashOtp } = await import("../../server/routers/phoneAuth");
  const id = crypto.randomUUID();
  await world.db.insert(schema.stepUpChallenges).values({
    id,
    tenantId: TID,
    userId: String(userId),
    purpose: "withdrawal",
    otpHash: hashOtp(otp),
    phone: OWNER_PHONE,
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return id;
}

export const journey: Journey = {
  id: "J191",
  name: "approval policy parks withdrawal; approve executes once; second approve CONFLICT; step-up composes",
  feature: "W31 approvals: requireApprovalIfNeeded + decideApproval + withdrawal executor",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    await world.db.insert(schema.tenants).values({
      id: TID, name: "J191 Approvals", slug: TID, status: "active",
    }).onConflictDoNothing();
    await approveKyb(world, TID);
    const [ownerUser] = await world.db.insert(schema.users).values({
      openId: "j191-owner", email: "j191-owner@sim.local", name: "J191 Owner",
      loginMethod: "keycloak", role: "user", tenantId: TID, phone: OWNER_PHONE, lastSignedIn: new Date(),
    }).returning();
    const [opUser] = await world.db.insert(schema.users).values({
      openId: "j191-op", email: "j191-op@sim.local", name: "J191 Operator",
      loginMethod: "keycloak", role: "user", tenantId: TID, phone: "+2348019100002", lastSignedIn: new Date(),
    }).returning();
    await world.db.insert(schema.tenantMemberships).values([
      { tenantId: TID, userId: String(ownerUser.id), role: "owner" },
      { tenantId: TID, userId: String(opUser.id), role: "operator" },
    ]).onConflictDoNothing();
    const owner = await tenantCaller(TID, { userId: ownerUser.id });
    const operator = await tenantCaller(TID, { userId: opUser.id });

    // PSP custody + funded wallet with payout details on file.
    await world.db.update(schema.escrowConfig).set({ custodyMode: "psp" })
      .where(eq(schema.escrowConfig.id, 1));
    await world.db.insert(schema.merchantWallets).values({
      tenantId: TID,
      custodyMode: "psp",
      availableBalance: "100000.00",
      bankAccountName: "J191 Merchant",
      bankAccountNumber: "0123456789",
      bankCode: "058",
    }).onConflictDoNothing();

    // ── 1. setPolicy is owner-only ──────────────────────────────────────
    await expectTrpcError(
      operator.approvals.setPolicy({ tenantId: TID, thresholdCents: 10_000, kinds: ["withdrawal"] }),
      "FORBIDDEN",
      "operator cannot set the approval policy",
    );
    const pol = await owner.approvals.setPolicy({
      tenantId: TID, thresholdCents: 10_000, kinds: ["withdrawal"], approverRole: "owner", expiryHours: 72,
    });
    assert(pol.ok === true && pol.enabled === true, "owner set the approval policy");

    // ── 2. Above-threshold withdrawal parks as pending_approval ─────────
    const parked = await owner.wallet.requestWithdrawal({ tenantId: TID, amount: 500 });
    assert(parked.status === "pending_approval", `withdrawal parked (got ${parked.status})`);
    assert(typeof parked.approvalId === "string", "parked withdrawal carries approvalId");
    const [walletAfterPark] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletAfterPark.availableBalance === "100000.00", "nothing debited while pending approval");

    // ── 3. Operator cannot decide an owner-role approval ────────────────
    await expectTrpcError(
      operator.approvals.approve({ tenantId: TID, approvalId: parked.approvalId }),
      "FORBIDDEN",
      "operator cannot approve an owner-role request",
    );

    // ── 4. Owner approves → withdrawal executes exactly once ────────────
    const approved = await owner.approvals.approve({ tenantId: TID, approvalId: parked.approvalId });
    assert(approved.ok === true && approved.executed === true, `approval executed (${JSON.stringify(approved.execution)})`);
    assert(approved.status === "executed", `approval row executed (got ${approved.status})`);
    const [walletAfterApprove] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletAfterApprove.availableBalance === "99500.00", `wallet debited once (got ${walletAfterApprove.availableBalance})`);
    const [wdTx] = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, parked.reference)));
    assert(wdTx?.type === "withdrawal", "withdrawal ledger row written by the existing escrow path");

    // ── 5. Second approve → CONFLICT (single-consumption) ───────────────
    await expectTrpcError(
      owner.approvals.approve({ tenantId: TID, approvalId: parked.approvalId }),
      "CONFLICT",
      "second approve is single-consumption CONFLICT",
    );

    // Replay of the same withdrawal reference is idempotent — no 2nd debit.
    const replay = await owner.wallet.requestWithdrawal({
      tenantId: TID, amount: 500, reference: parked.reference, approvalId: parked.approvalId,
    });
    assert(replay.duplicate === true, "approved-withdrawal replay is idempotent");
    const [walletAfterReplay] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletAfterReplay.availableBalance === "99500.00", "replay did not debit again");

    // ── 6. Step-up still composes above WITHDRAWAL_STEPUP_THRESHOLD ─────
    const prevThreshold = process.env.WITHDRAWAL_STEPUP_THRESHOLD;
    process.env.WITHDRAWAL_STEPUP_THRESHOLD = "400";
    try {
      const parked2 = await owner.wallet.requestWithdrawal({ tenantId: TID, amount: 500 });
      assert(parked2.status === "pending_approval", "second withdrawal parked");
      await expectTrpcError(
        owner.approvals.approve({ tenantId: TID, approvalId: parked2.approvalId }),
        "PRECONDITION_FAILED",
        "approve above step-up threshold without OTP is rejected",
      );
      const challengeId = await seedStepUp(world, ownerUser.id, "123456");
      const approved2 = await owner.approvals.approve({
        tenantId: TID, approvalId: parked2.approvalId,
        stepUpChallengeId: challengeId, stepUpOtp: "123456",
      });
      assert(approved2.executed === true, "step-up-composed approval executed");
      const [walletAfterStepUp] = await world.db.select().from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.tenantId, TID));
      assert(walletAfterStepUp.availableBalance === "99000.00", `second execution debited once (got ${walletAfterStepUp.availableBalance})`);
    } finally {
      if (prevThreshold === undefined) delete process.env.WITHDRAWAL_STEPUP_THRESHOLD;
      else process.env.WITHDRAWAL_STEPUP_THRESHOLD = prevThreshold;
    }

    // ── 7. Below-threshold withdrawal: pre-W31 behavior, no approval ────
    const direct = await owner.wallet.requestWithdrawal({ tenantId: TID, amount: 50 });
    assert(direct.status !== "pending_approval" && direct.success === true, "below-threshold withdrawal executes directly");
    const pendingRows = await world.db.select().from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.tenantId, TID), eq(schema.approvalRequests.status, "pending")));
    assert(pendingRows.length === 0, "no stray pending approvals remain");
    const [walletFinal] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletFinal.availableBalance === "98950.00", `final balance 98950 (got ${walletFinal.availableBalance})`);
  },
};
