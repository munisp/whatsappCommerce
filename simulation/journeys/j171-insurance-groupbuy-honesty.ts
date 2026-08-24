/**
 * J171 — W30 (V1#2, V1#10, V3#14): honest statuses + production guards.
 *   1. Insurance: quote is REFUSED in a mock-only production deployment
 *      (fail honestly); in non-prod a filed claim is `pending_payout`,
 *      never auto-"paid"; ops confirm flips it exactly once;
 *      parametricEvent is admin-only.
 *   2. Group buy: fabricated paymentRef join rejected; verified join held.
 *   3. Mobile money: production façade without provider config refuses to
 *      initiate; non-prod stats are honestly labelled simulated.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, seedCompletedPayment, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J171",
  name: "insurance/group-buy/mobile-money honesty + prod guards",
  feature: "V1#2 + V1#10 + V3#14 remediation: pending_payout, prod guards, verified joins",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const tenant = await tenantCaller(TENANT_ID, { userId: 1711 });

    // ── 1a. Insurance prod guard: mock-only deployment fails at quote ────
    await admin.insurance.upsertProduct({
      tenantId: TENANT_ID, id: "j171-cover", name: "J171 Cover",
      flatPremiumCents: 500, coverageCents: 40_000,
    });
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const err = await admin.insurance.quote({
        tenantId: TENANT_ID, productId: "j171-cover", orderAmountCents: 100_000,
      }).catch((e: any) => e);
      assert(err instanceof Error, "mock-only production quote refused");
      assert(String(err?.message).includes("unavailable in this deployment"), `honest refusal (got: ${err?.message})`);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }

    // Non-prod: quote + bind work (dev rail), claim is honestly pending_payout.
    const quote = await admin.insurance.quote({
      tenantId: TENANT_ID, productId: "j171-cover", orderAmountCents: 100_000,
    });
    const { policy } = await admin.insurance.bind({ tenantId: TENANT_ID, quoteId: quote.id });
    const { claim } = await admin.insurance.fileClaim({
      tenantId: TENANT_ID, policyId: policy.id, reason: "delivery failed",
    });
    assert(claim.status === "pending_payout", `claim honestly pending_payout (got ${claim.status})`);
    assert(claim.resolvedAt == null, "claim unresolved until payout lands");
    const confirmed = await admin.insurance.confirmPayout({
      tenantId: TENANT_ID, claimId: claim.id, note: "ops disbursed DISB-171",
    });
    assert(confirmed.status === "paid", "ops confirm pays exactly once");
    const again = await admin.insurance.confirmPayout({
      tenantId: TENANT_ID, claimId: claim.id, note: "duplicate",
    }).catch((e: any) => e);
    assert(again instanceof Error, "duplicate payout confirm rejected");

    // parametricEvent is admin-only (V1#2: was any-tenant-user).
    await expectTrpcError(
      tenant.insurance.parametricEvent({ tenantId: TENANT_ID, event: { type: "delivery_failed" } }),
      "FORBIDDEN", "tenant user cannot fire parametric events",
    );

    // ── 2. Group buy: verified join only ─────────────────────────────────
    const { createGroupDealTx, joinGroupDealTx } = await import("../../server/services/groupBuy");
    const deal = await createGroupDealTx(world.db, {
      tenantId: TENANT_ID, title: "J171 deal", unitPriceCents: 10_000,
      thresholdQty: 100, deadline: new Date(Date.now() + 3600_000),
    });
    const bad = await joinGroupDealTx(world.db, {
      dealId: deal.id, customerPhone: world.newPhone("jb"), quantity: 2, paymentRef: "fake-ref-171",
    });
    assert(!bad.ok && bad.reason === "payment_not_verified", "fabricated ref rejected");
    await seedCompletedPayment(world, { reference: "gb171-ok", amountCents: 20_000 });
    const good = await joinGroupDealTx(world.db, {
      dealId: deal.id, customerPhone: world.newPhone("jg"), quantity: 2, paymentRef: "gb171-ok",
    });
    assert(good.ok && good.participant.status === "held", "verified ref joins");
    const [row] = await world.db.select().from(schema.groupDeals).where(eq(schema.groupDeals.id, deal.id));
    assert(row.currentQty === 2, `rejected join never counted quantity (got ${row.currentQty})`);

    // ── 3. Mobile money prod guard + simulated labelling ─────────────────
    delete process.env.MOBILE_MONEY_LIVE;
    try {
      process.env.NODE_ENV = "production";
      await expectTrpcError(
        tenant.mobileMoney.initiate({
          tenantId: TENANT_ID, provider: "mtn_momo", phoneNumber: "+2348011111111", amount: "100.00",
        }),
        "PRECONDITION_FAILED", "production façade without provider refuses",
      );
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
    const stats = await tenant.mobileMoney.stats({ tenantId: TENANT_ID });
    assert(stats.simulated === true, "stats honestly labelled simulated");
    assert(stats.totalVolume === "0.00", "no fabricated volume presented as real");
  },
};
