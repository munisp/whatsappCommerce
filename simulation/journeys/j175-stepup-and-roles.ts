/**
 * J175 — W30 withdrawal kill chain (V2#2) + membership role cap (V2#12):
 *   1. A withdrawal above the step-up threshold requires a fresh OTP
 *      challenge (PRECONDITION_FAILED without one).
 *   2. Changing payout bank details is a separate audited procedure gated by
 *      step-up OTP — challenges are single-use.
 *   3. membership.add can no longer grant owner: an operator is FORBIDDEN;
 *      an owner needs step-up; with a valid challenge the grant succeeds.
 *   4. moneyProcedure: an analyst-membership caller cannot withdraw.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, expectTrpcError, tenantCaller } from "./helpers";

const TID = "j175-tenant";

async function seedChallenge(
  world: World,
  opts: { userId: string; purpose: string; otp: string },
): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const { hashOtp } = await import("../../server/routers/phoneAuth");
  const id = randomUUID();
  await world.db.insert(schema.stepUpChallenges).values({
    id,
    tenantId: TID,
    userId: opts.userId,
    purpose: opts.purpose,
    otpHash: hashOtp(opts.otp),
    phone: "+2348000000000",
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return id;
}

export const journey: Journey = {
  id: "J175",
  name: "step-up OTP on payout change + withdrawal; owner grant gated; analyst blocked",
  feature: "stepUp challenges + updatePayoutBankDetails + moneyProcedure + membership role cap",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    await world.db.insert(schema.tenants).values({
      id: TID, name: "J175 StepUp", slug: TID, status: "active",
    }).onConflictDoNothing();
    await approveKyb(world, TID);
    await world.db.insert(schema.tenantMemberships).values([
      { tenantId: TID, userId: "1751", role: "owner" },
      { tenantId: TID, userId: "1752", role: "operator" },
      { tenantId: TID, userId: "1753", role: "analyst" },
    ]).onConflictDoNothing();
    const owner = await tenantCaller(TID, { userId: 1751 });
    const operator = await tenantCaller(TID, { userId: 1752 });
    const analyst = await tenantCaller(TID, { userId: 1753 });

    // ── 1. Withdrawal above threshold requires step-up ──────────────────
    const prevThreshold = process.env.WITHDRAWAL_STEPUP_THRESHOLD;
    process.env.WITHDRAWAL_STEPUP_THRESHOLD = "50";
    try {
      const err = await expectTrpcError(
        owner.wallet.requestWithdrawal({ tenantId: TID, amount: 100 }),
        "PRECONDITION_FAILED",
        "withdrawal above threshold without step-up",
      );
      assert(/step-up/i.test(err.message), `rejection cites step-up (${err.message})`);
    } finally {
      if (prevThreshold === undefined) delete process.env.WITHDRAWAL_STEPUP_THRESHOLD;
      else process.env.WITHDRAWAL_STEPUP_THRESHOLD = prevThreshold;
    }

    // ── 2. Payout-destination change: step-up gated, single-use ─────────
    const challengeId = await seedChallenge(world, { userId: "1751", purpose: "payout_change", otp: "123456" });
    const res = await owner.wallet.updatePayoutBankDetails({
      tenantId: TID,
      bankAccountName: "J175 Merchant",
      bankAccountNumber: "0123456789",
      bankCode: "058",
      stepUpChallengeId: challengeId,
      stepUpOtp: "123456",
    });
    assert(res.ok === true, "payout bank details updated with valid step-up");
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(wallet?.bankAccountNumber === "0123456789", "wallet payout account persisted");
    // Replay of the consumed challenge fails.
    await expectTrpcError(
      owner.wallet.updatePayoutBankDetails({
        tenantId: TID,
        bankAccountName: "Attacker",
        bankAccountNumber: "9999999999",
        bankCode: "058",
        stepUpChallengeId: challengeId,
        stepUpOtp: "123456",
      }),
      "UNAUTHORIZED",
      "consumed step-up challenge cannot be replayed",
    );
    const [wallet2] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(wallet2?.bankAccountNumber === "0123456789", "replayed challenge changed nothing");

    // ── 3. Owner grant: operator forbidden; owner needs step-up ─────────
    await expectTrpcError(
      operator.membership.add({ tenantId: TID, userId: 1752, role: "owner" }),
      "FORBIDDEN",
      "operator cannot self-escalate to owner",
    );
    await expectTrpcError(
      owner.membership.add({ tenantId: TID, userId: 1752, role: "owner" }),
      "PRECONDITION_FAILED",
      "owner grant without step-up is rejected",
    );
    const grantChallenge = await seedChallenge(world, { userId: "1751", purpose: "owner_grant", otp: "654321" });
    await owner.membership.add({
      tenantId: TID, userId: 1752, role: "owner",
      stepUpChallengeId: grantChallenge, stepUpOtp: "654321",
    });
    const [m] = await world.db.select().from(schema.tenantMemberships)
      .where(eq(schema.tenantMemberships.tenantId, TID));
    const roles = await world.db.select().from(schema.tenantMemberships)
      .where(eq(schema.tenantMemberships.tenantId, TID));
    assert(roles.some((r) => r.userId === "1752" && r.role === "owner"), "owner grant persisted after step-up");
    assert(m, "membership rows present");

    // ── 4. Analyst membership cannot touch money mutations ──────────────
    const analystErr = await expectTrpcError(
      analyst.wallet.requestWithdrawal({ tenantId: TID, amount: 10 }),
      "FORBIDDEN",
      "analyst membership cannot withdraw",
    );
    assert(/role/i.test(analystErr.message), `analyst rejection cites role (${analystErr.message})`);
  },
};
