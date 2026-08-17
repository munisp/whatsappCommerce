/**
 * J71 — Facility utilization & covenants (W14 F4). Lender warehouse-line
 * servicing, all behind adminProcedure:
 *   - createFacility: facility_ref UNIQUE → duplicate rejected CONFLICT;
 *   - assignAccountToFacility: claim-first, unknown facility/account → NOT_FOUND;
 *   - utilization math exact: outstanding/commitment in bps, advance-rate
 *     headroom floored at 0;
 *   - covenant checks: utilization / 90+ NPL / single-buyer concentration
 *     breaches reported with exact percentages; compliant when under limits;
 *   - non-admin callers are FORBIDDEN on every one of the six procedures.
 */
import { randomUUID } from "crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J71",
  name: "facility utilization & covenants",
  feature: "utilizationBps/advance math, covenant breaches, admin gating",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    const sup = (await admin.onboarding.start({ name: "J71 Supplier" })).tenantId;
    const buyX = (await admin.onboarding.start({ name: "J71 Buyer X" })).tenantId;
    const buyY = (await admin.onboarding.start({ name: "J71 Buyer Y" })).tenantId;
    const mkAccount = async (buy: string, outstanding: number, dpdDays: number) => {
      const accountId = randomUUID();
      await world.db.insert(schema.creditAccounts).values({
        id: accountId, supplierTenantId: sup, buyerTenantId: buy,
        limitCents: 20_000_000, outstandingCents: outstanding, termsDays: 14, status: "active",
      });
      await world.db.insert(schema.creditLedger).values({
        creditAccountId: accountId, kind: "invoice_draw", amountCents: outstanding,
        poId: `po-j71-${accountId.slice(0, 8)}`, dueDate: new Date(Date.now() - dpdDays * DAY_MS),
        ref: `draw:po-j71-${accountId.slice(0, 8)}`,
      });
      return accountId;
    };
    // X: ₦100,000 current; Y: ₦60,000 at 100+ dpd (90+ NPL).
    const acctX = await mkAccount(buyX, 10_000_000, -10);
    const acctY = await mkAccount(buyY, 6_000_000, 100);

    // ── createFacility + UNIQUE ref ──────────────────────────────────────
    const facility = await admin.creditFacilities.createFacility({
      lenderName: "J71 Lender",
      facilityRef: "W14-J71-FAC",
      commitmentCents: 40_000_000, // ₦400,000
      advanceRateBps: 7500, // advance capacity = 30_000_000
    });
    assert(facility.status === "active" && facility.currency === "NGN", "facility defaults");
    const dup = await expectTrpcError(
      admin.creditFacilities.createFacility({ lenderName: "Dupe", facilityRef: "W14-J71-FAC", commitmentCents: 1 }),
      "CONFLICT", "duplicate facility_ref rejected",
    );
    assert(dup.message.includes("W14-J71-FAC"), "conflict names the ref");

    // ── assignAccount: claim-first, NOT_FOUNDs ───────────────────────────
    await expectTrpcError(
      admin.creditFacilities.assignAccount({ accountId: acctX, facilityId: randomUUID() }),
      "NOT_FOUND", "unknown facility",
    );
    await expectTrpcError(
      admin.creditFacilities.assignAccount({ accountId: randomUUID(), facilityId: facility.id }),
      "NOT_FOUND", "unknown account",
    );
    const asg = await admin.creditFacilities.assignAccount({ accountId: acctX, facilityId: facility.id });
    assert(asg.accountId === acctX && asg.facilityId === facility.id, "assignment returns the claim");
    await admin.creditFacilities.assignAccount({ accountId: acctY, facilityId: facility.id });

    // ── Utilization math (exact) ─────────────────────────────────────────
    const list = await admin.creditFacilities.listFacilities();
    const row = list.find((f: any) => f.id === facility.id) as any;
    assert(row, "facility listed");
    const u = row.utilization;
    assert(u.accountCount === 2, "two assigned accounts");
    assert(u.outstandingCents === 16_000_000, "outstanding = X + Y");
    assert(u.commitmentCents === 40_000_000, "commitment echoed");
    assert(u.utilizationBps === 4000, `utilization 40% = 4000bps (got ${u.utilizationBps})`);
    // floor(40M × 7500/10000) − 16M = 30M − 16M = 14M
    assert(u.availableToAdvanceCents === 14_000_000, `advance headroom (got ${u.availableToAdvanceCents})`);

    // ── Covenants: compliant under generous thresholds ───────────────────
    const generous = await admin.creditFacilities.createFacility({
      lenderName: "J71 Generous", facilityRef: "W14-J71-GEN",
      commitmentCents: 40_000_000,
      covenants: { maxUtilizationPct: 50, maxNplPct: 50, maxSingleBuyerPct: 100 },
    });
    await admin.creditFacilities.assignAccount({ accountId: acctX, facilityId: generous.id });
    const okCheck = await admin.creditFacilities.covenantCheck({ facilityId: generous.id });
    assert(okCheck.compliant === true && okCheck.breaches.length === 0, "compliant under generous thresholds");

    // ── Covenants: all three breach on the tight facility ────────────────
    const tight = await admin.creditFacilities.createFacility({
      lenderName: "J71 Tight", facilityRef: "W14-J71-TIGHT",
      commitmentCents: 40_000_000,
      covenants: { maxUtilizationPct: 30, maxNplPct: 10, maxSingleBuyerPct: 50 },
    });
    await admin.creditFacilities.assignAccount({ accountId: acctX, facilityId: tight.id });
    await admin.creditFacilities.assignAccount({ accountId: acctY, facilityId: tight.id });
    const check = await admin.creditFacilities.covenantCheck({ facilityId: tight.id });
    assert(check.compliant === false, "tight facility breaches");
    const byCovenant = new Map(check.breaches.map((b: any) => [b.covenant, b]));
    const ub = byCovenant.get("utilization") as any;
    assert(ub && ub.limitPct === 30 && Math.abs(ub.actualPct - 40) < 1e-9, `utilization breach 40 > 30 (${JSON.stringify(ub)})`);
    const nb = byCovenant.get("npl") as any;
    assert(nb && nb.limitPct === 10 && Math.abs(nb.actualPct - 37.5) < 1e-9, `NPL breach 37.5 > 10 (${JSON.stringify(nb)})`);
    const cb = byCovenant.get("singleBuyerConcentration") as any;
    assert(cb && cb.limitPct === 50 && Math.abs(cb.actualPct - 62.5) < 1e-9, `concentration breach 62.5 > 50 (${JSON.stringify(cb)})`);

    // asOf before Y went delinquent → no NPL breach.
    const before = await admin.creditFacilities.covenantCheck({
      facilityId: tight.id, asOf: new Date(Date.now() - 120 * DAY_MS),
    });
    assert(!before.breaches.some((b: any) => b.covenant === "npl"), "historical asOf: no NPL yet");

    // tapeEmailPreview renders the lender summary text.
    const preview = await admin.creditFacilities.tapeEmailPreview({ facilityId: tight.id });
    assert(preview.text.includes("J71 Tight") && preview.text.includes("W14-J71-TIGHT"), "preview names the facility");
    assert(preview.text.includes("37.50%"), "preview carries the NPL ratio");

    // ── Admin gating: every procedure FORBIDDEN for a tenant caller ──────
    const tenant = await tenantCaller(sup, { userId: 711 });
    await expectTrpcError(tenant.creditFacilities.createFacility({ lenderName: "x", facilityRef: "x", commitmentCents: 1 }), "FORBIDDEN", "createFacility admin-only");
    await expectTrpcError(tenant.creditFacilities.listFacilities(), "FORBIDDEN", "listFacilities admin-only");
    await expectTrpcError(tenant.creditFacilities.assignAccount({ accountId: acctX, facilityId: tight.id }), "FORBIDDEN", "assignAccount admin-only");
    await expectTrpcError(tenant.creditFacilities.generateTape({}), "FORBIDDEN", "generateTape admin-only");
    await expectTrpcError(tenant.creditFacilities.covenantCheck({ facilityId: tight.id }), "FORBIDDEN", "covenantCheck admin-only");
    await expectTrpcError(tenant.creditFacilities.tapeEmailPreview({ facilityId: tight.id }), "FORBIDDEN", "tapeEmailPreview admin-only");
  },
};
