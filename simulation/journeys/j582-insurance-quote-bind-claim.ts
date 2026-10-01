// === W57 risk-shield ===
/**
 * J582 — Credit insurance (sim provider): deterministic premium quotes
 * (grade band table — same input, same premium), idempotent bind, claim
 * file → deterministic sim adjudication → PAID payout equals the principal,
 * and the policy is consumed (bound → claimed, claim-first).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J582",
  name: "insurance quote determinism + bind + claim file + paid payout (sim)",
  feature: "W57 risk-shield F3: credit insurance adapter",
  async run(world: World) {
    const ins = await import("../../server/services/creditInsurance");
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");

    const saved = process.env.CREDIT_INSURANCE_PROVIDER;
    process.env.CREDIT_INSURANCE_PROVIDER = "sim";
    try {
      // ── 1. Quote determinism across the grade band table ───────────────
      const principal = 500_000_00;
      for (const grade of ["A", "B", "C", "D", "E"] as const) {
        const q1 = ins.quotePremium(principal, grade);
        const q2 = ins.quotePremium(principal, grade);
        assert(q1.premiumCents === q2.premiumCents, `quote deterministic for grade ${grade}`);
        assert(q1.premiumCents === Math.round((principal * ins.PREMIUM_BPS_BY_GRADE[grade]) / 10_000),
          `premium matches the documented bps table for ${grade}`);
      }
      assert(ins.quotePremium(principal, "A").premiumCents < ins.quotePremium(principal, "E").premiumCents,
        "premium rises with risk grade");

      // ── 2. Bind (idempotent) ───────────────────────────────────────────
      const facilityRef = `fac-j582-${world.newPhone("582").slice(-6)}`;
      const b1 = await ins.bindPolicy(world.db as any, {
        tenantId: TENANT_ID, facilityRef, principalCents: principal, grade: "C",
      });
      assert(b1.ok && b1.policy && b1.policy.status === "bound", "policy bound");
      assert(b1.policy!.premiumCents === ins.quotePremium(principal, "C").premiumCents, "premium persisted");
      const b2 = await ins.bindPolicy(world.db as any, {
        tenantId: TENANT_ID, facilityRef, principalCents: principal, grade: "C",
      });
      assert(b2.ok && b2.duplicate === true && b2.policy!.id === b1.policy!.id, "bind idempotent");

      // ── 3. Claim → sim adjudication → PAID payout = principal ──────────
      // Choose a defaultRef the deterministic sim adjudicator pays.
      let defaultRef = "def-j582-0";
      for (let i = 0; i < 64 && ins.simClaimOutcome(defaultRef) !== "paid"; i++) defaultRef = `def-j582-${i}`;
      assert(ins.simClaimOutcome(defaultRef) === "paid", "found a sim-paid default ref");
      const c1 = await ins.fileClaim(world.db as any, {
        tenantId: TENANT_ID, policyId: b1.policy!.id, defaultRef,
        evidence: { ledgerRefs: ["ledger-1"], dunningMarkers: ["[dun:r+7]"] },
      });
      assert(c1.ok && c1.claim, "claim filed");
      assert(c1.claim!.status === "paid", `sim adjudicated paid (got ${c1.claim!.status})`);
      assert(c1.claim!.payoutCents === principal, "payout equals the insured principal");
      const c2 = await ins.fileClaim(world.db as any, {
        tenantId: TENANT_ID, policyId: b1.policy!.id, defaultRef, evidence: {},
      });
      assert(c2.ok && c2.duplicate === true, "claim file idempotent");
      const [pol] = await world.db.select().from(schema.creditInsurancePolicies)
        .where(eq(schema.creditInsurancePolicies.id, b1.policy!.id));
      assert(pol.status === "claimed", "policy consumed (bound → claimed, claim-first)");

      // ── 4. Fail-open: provider disabled never throws, honest error ─────
      process.env.CREDIT_INSURANCE_PROVIDER = "disabled";
      const off = await ins.bindPolicy(world.db as any, {
        tenantId: TENANT_ID, facilityRef: `${facilityRef}-x`, principalCents: principal, grade: "A",
      });
      assert(off.ok === false && off.error === "provider_disabled", "disabled provider fails open honestly");
    } finally {
      if (saved === undefined) delete process.env.CREDIT_INSURANCE_PROVIDER;
      else process.env.CREDIT_INSURANCE_PROVIDER = saved;
    }
  },
};
