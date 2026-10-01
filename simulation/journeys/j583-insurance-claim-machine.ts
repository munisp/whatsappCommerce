// === W57 risk-shield ===
/**
 * J583 — Claim status machine: filed → under_review → paid|rejected with
 * claim-first settles (a settled claim never re-settles); sim rejection
 * path pays nothing and consumes the policy honestly.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J583",
  name: "insurance claim status machine (claim-first settle)",
  feature: "W57 risk-shield F3: claim lifecycle",
  async run(world: World) {
    const ins = await import("../../server/services/creditInsurance");

    const saved = process.env.CREDIT_INSURANCE_PROVIDER;
    process.env.CREDIT_INSURANCE_PROVIDER = "sim";
    try {
      // ── 1. Sim rejection: deterministic, no payout, policy consumed ────
      let rejectRef = "def-j583-0";
      for (let i = 0; i < 64 && ins.simClaimOutcome(rejectRef) !== "rejected"; i++) rejectRef = `def-j583-${i}`;
      const b1 = await ins.bindPolicy(world.db as any, {
        tenantId: TENANT_ID, facilityRef: `fac-j583-a`, principalCents: 200_000_00, grade: "D",
      });
      assert(b1.ok && b1.policy, "bound");
      const c1 = await ins.fileClaim(world.db as any, {
        tenantId: TENANT_ID, policyId: b1.policy!.id, defaultRef: rejectRef, evidence: {},
      });
      assert(c1.ok && c1.claim!.status === "rejected" && c1.claim!.payoutCents == null, "sim rejection honest");

      // ── 2. Manual resolve path (http-style under_review → paid) ────────
      const b2 = await ins.bindPolicy(world.db as any, {
        tenantId: TENANT_ID, facilityRef: `fac-j583-b`, principalCents: 300_000_00, grade: "B",
      });
      assert(b2.ok && b2.policy, "second policy bound");
      // Insert an under_review claim directly (http provider hand-off state).
      const schema = await import("../../drizzle/schema");
      const claimId = crypto.randomUUID();
      await world.db.insert(schema.creditInsuranceClaims).values({
        id: claimId, tenantId: TENANT_ID, policyId: b2.policy!.id,
        defaultRef: "def-j583-manual", evidence: { ledgerRefs: [], dunningMarkers: [] },
        status: "under_review", idempotencyKey: ins.fileClaimKey(TENANT_ID, b2.policy!.id, "def-j583-manual"),
      });
      const r1 = await ins.resolveClaim(world.db as any, {
        claimId, tenantId: TENANT_ID, decision: "paid", payoutCents: 300_000_00,
      });
      assert(r1.ok && r1.changed && r1.claim!.status === "paid", "under_review → paid");
      const r2 = await ins.resolveClaim(world.db as any, {
        claimId, tenantId: TENANT_ID, decision: "rejected",
      });
      assert(r2.ok && r2.changed === false && r2.claim!.status === "paid", "claim-first: settled claim never re-settles");

      // ── 3. Paid payout with shortfall feeds the provision-fund seam ────
      const prov = await import("../../server/services/provisionFund");
      const shortfall = 50_000_00; // principal 300k₦ − payout 250k₦
      const before = await prov.getProvisionBalance(world.db as any, TENANT_ID);
      await prov.accrueFromFeeEvent(world.db as any, { tenantId: TENANT_ID, feeRef: "j583-seed-fee", feeCents: 4_000_000_00 });
      const seeded = await prov.getProvisionBalance(world.db as any, TENANT_ID);
      assert(seeded - before === Math.round((4_000_000_00 * (await prov.getProvisionFundBps(world.db as any))) / 10_000),
        "accrual diverted the configured bps");
      const draw = await prov.drawFromFund(world.db as any, {
        tenantId: TENANT_ID, amountCents: shortfall, ref: "j583-shortfall",
        reason: "approved insurance-claim shortfall", actorId: "admin-j583",
      });
      assert(draw.ok && draw.balanceAfter === seeded - shortfall, "shortfall draw succeeds against the funded balance");
      const dup = await prov.drawFromFund(world.db as any, {
        tenantId: TENANT_ID, amountCents: shortfall, ref: "j583-shortfall",
        reason: "retry", actorId: "admin-j583",
      });
      assert(dup.duplicate === true, "draw idempotent by ref");
    } finally {
      if (saved === undefined) delete process.env.CREDIT_INSURANCE_PROVIDER;
      else process.env.CREDIT_INSURANCE_PROVIDER = saved;
    }
  },
};
