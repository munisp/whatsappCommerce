/**
 * J113 (S4) — supplier-side collusion scenario: a 3-tenant trading ring is
 * detected by the graph scan and flows into credit-limit scoring.
 *
 *   1. Seed a trading ring (X→Y→Z→X, heavy circular volume, 4 orders per
 *      direction) plus an honest tenant trading dispersed volume.
 *   2. compliance.scanGraphCollusion (clock injected via the `now` input)
 *      raises graph_alerts for every ring member — cycle AND cluster
 *      signals with ring-path / cluster-size evidence; the honest tenant
 *      is untouched.
 *   3. Credit integration: tradeCredit.suggestLimit for a ring buyer
 *      carries the 'graph-collusion' anti-gaming flag with a REDUCED
 *      confidence (score / suggested limit drop vs the same buyer once the
 *      alerts are dismissed — A/B proof that the flag drives the penalty).
 *   4. The honest tenant's suggestLimit stays clean (no flag).
 *   5. Cross-tenant guards on scan / list / update (FORBIDDEN).
 *
 * NOTE: services are imported LAZILY inside run() — loadJourneys() executes
 * before bootWorld() sets the sim env (see j101 header).
 */
import { assert } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J113",
  name: "collusion ring → credit flag (S4)",
  feature: "3-tenant trading ring → scanGraphCollusion cycle+cluster alerts → suggestLimit graph-collusion flag with reduced confidence → honest tenant unaffected",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

    // ── 1. Tenants + owner phones ─────────────────────────────────────────
    const mk = async (name: string) => (await admin.onboarding.start({ name })).tenantId;
    const ringX = await mk("J113 Ring X");
    const ringY = await mk("J113 Ring Y");
    const ringZ = await mk("J113 Ring Z");
    const honest = await mk("J113 Honest");
    const intruderTenant = await mk("J113 Intruder");

    const phoneOf = new Map([
      [ringX, "+234771301"],
      [ringY, "+234771302"],
      [ringZ, "+234771303"],
      [honest, "+234771311"],
    ]);
    for (const [tenantId, phone] of phoneOf) {
      await world.db.insert(schema.users).values({
        openId: `j113-user-${tenantId}`,
        email: `j113-${tenantId}@sim.local`,
        name: `J113 ${tenantId}`,
        loginMethod: "keycloak",
        role: "user",
        tenantId,
        phone,
        lastSignedIn: new Date(),
      });
    }

    // Orders: an order at seller S by buyer-phone P is an edge.
    const customersSeen = new Set<string>();
    let orderSeq = 0;
    async function trade(seller: string, buyerPhone: string, major: string, daysBack: number) {
      const cid = `j113-c-${buyerPhone.slice(-6)}-at-${seller.slice(-4)}`;
      if (!customersSeen.has(cid)) {
        customersSeen.add(cid);
        await world.db.insert(schema.customers).values({
          id: cid, tenantId: seller, whatsappPhone: buyerPhone, name: `J113 buyer ${buyerPhone}`,
        }).onConflictDoNothing();
      }
      orderSeq += 1;
      await world.db.insert(schema.orders).values({
        id: `j113-ord-${orderSeq}`,
        tenantId: seller,
        customerId: cid,
        orderNumber: `J113-${orderSeq}`,
        status: "delivered",
        totalAmount: major,
        currency: "NGN",
        createdAt: daysAgo(daysBack),
        updatedAt: daysAgo(daysBack),
      }).onConflictDoNothing();
    }

    // Ring: X→Y→Z→X, 4 orders per direction, spread over days. Volume is
    // heavy enough that the 30d volume factor saturates the scoring target —
    // the graph-collusion confidence penalty then moves the score visibly
    // (A/B proof in step 3).
    for (let i = 0; i < 4; i++) {
      await trade(ringY, phoneOf.get(ringX)!, "5000000.00", 2 + i); // X buys from Y
      await trade(ringZ, phoneOf.get(ringY)!, "5000000.00", 3 + i); // Y buys from Z
      await trade(ringX, phoneOf.get(ringZ)!, "5000000.00", 4 + i); // Z buys from X
    }
    // Honest tenant: dispersed trade, no cycle, no concentration.
    await trade(ringX, phoneOf.get(honest)!, "3000.00", 2);
    await trade(ringY, phoneOf.get(honest)!, "3000.00", 3);
    await trade(ringZ, phoneOf.get(honest)!, "3000.00", 4);
    // Honest tenant as a seller: small dispersed sales to non-tenant buyers.
    for (const [i, daysBack] of [[0, 2], [1, 3], [2, 4]] as const) {
      await world.db.insert(schema.customers).values({
        id: `j113-hc-${i}`, tenantId: honest, whatsappPhone: world.newPhone(`j113hc${i}`), name: `J113 retail ${i}`,
      }).onConflictDoNothing();
      await world.db.insert(schema.orders).values({
        id: `j113-hord-${i}`, tenantId: honest, customerId: `j113-hc-${i}`,
        orderNumber: `J113-H${i}`, status: "delivered",
        totalAmount: "2500.00", currency: "NGN",
        createdAt: daysAgo(daysBack), updatedAt: daysAgo(daysBack),
      }).onConflictDoNothing();
    }

    const callerX = await tenantCaller(ringX, { userId: 1130 });
    const callerH = await tenantCaller(honest, { userId: 1131 });
    const intruder = await tenantCaller(intruderTenant, { userId: 1132 });

    // ── 2. Scan: ring flagged (cycle + cluster), honest clean ────────────
    const scan = await callerX.compliance.scanGraphCollusion({ tenantId: ringX, now: now.toISOString() });
    assert(scan.error === undefined && scan.insufficient === false, `scan ok (got ${JSON.stringify(scan)})`);
    const byBuyer = new Map<string, string[]>();
    for (const a of scan.alerts) {
      byBuyer.set(a.buyerId, [...(byBuyer.get(a.buyerId) ?? []), a.signal]);
    }
    for (const ring of [ringX, ringY, ringZ]) {
      const sigs = (byBuyer.get(ring) ?? []).sort();
      assert(sigs.includes("cycle"), `ring member ${ring} has a cycle alert (got ${sigs})`);
      assert(sigs.includes("cluster"), `ring member ${ring} has a cluster alert (got ${sigs})`);
    }
    assert(!byBuyer.has(honest), "honest tenant is not flagged");

    const listed = await callerX.compliance.graphAlerts({ tenantId: ringX, status: "open" });
    const mine = listed.filter((a: any) => [ringX, ringY, ringZ].includes(a.buyerId));
    const cycleAlert = mine.find((a: any) => a.buyerId === ringX && a.signal === "cycle") as any;
    assert(cycleAlert, "cycle alert for ring X persisted");
    const paths = (cycleAlert.evidence?.cyclePaths ?? []) as string[];
    assert(paths.some((p) => p.includes(ringX) && p.includes(ringY) && p.includes(ringZ)),
      `cycle evidence names the ring (got ${JSON.stringify(paths)})`);
    const clusterAlert = mine.find((a: any) => a.buyerId === ringX && a.signal === "cluster") as any;
    assert(clusterAlert?.evidence?.clusterSize === 3,
      `cluster evidence size 3 (got ${JSON.stringify(clusterAlert?.evidence)})`);

    // ── 3. suggestLimit: graph-collusion flag + reduced confidence ────────
    const flaggedSug = await callerX.tradeCredit.suggestLimit({ supplierTenantId: ringX, buyerTenantId: ringX });
    assert(flaggedSug.antiGamingFlags.includes("graph-collusion"),
      `ring buyer scoring carries the graph-collusion flag (got ${JSON.stringify(flaggedSug.antiGamingFlags)})`);
    assert(flaggedSug.reasons.some((r: string) => r.includes("graph-collusion")),
      "the flag is explained in the scoring reasons");

    // A/B: dismiss ring X's open graph alerts → the flag disappears and the
    // confidence penalty lifts (score / limit recover). Proves the reduction
    // is driven by the graph signal, not by the buyer's other heuristics.
    for (const a of mine.filter((al: any) => al.buyerId === ringX)) {
      await callerX.compliance.updateGraphAlert({ alertId: (a as any).id, status: "dismissed" });
    }
    const clearedSug = await callerX.tradeCredit.suggestLimit({ supplierTenantId: ringX, buyerTenantId: ringX });
    assert(!clearedSug.antiGamingFlags.includes("graph-collusion"),
      "dismissed alerts remove the flag from scoring");
    assert(clearedSug.score > flaggedSug.score,
      `reduced confidence while flagged: score ${flaggedSug.score} → ${clearedSug.score} once cleared`);
    assert(clearedSug.suggestedLimitCents >= flaggedSug.suggestedLimitCents,
      `suggested limit recovers (${flaggedSug.suggestedLimitCents} → ${clearedSug.suggestedLimitCents})`);
    assert(Number.isInteger(flaggedSug.suggestedLimitCents) && Number.isInteger(clearedSug.suggestedLimitCents),
      "integer cents");

    // ── 4. Honest tenant unaffected ───────────────────────────────────────
    const honestSug = await callerH.tradeCredit.suggestLimit({ supplierTenantId: honest, buyerTenantId: honest });
    assert(!honestSug.antiGamingFlags.includes("graph-collusion"),
      `honest tenant has no graph-collusion flag (got ${JSON.stringify(honestSug.antiGamingFlags)})`);

    // ── 5. Cross-tenant guards ────────────────────────────────────────────
    await expectTrpcError(
      intruder.compliance.scanGraphCollusion({ tenantId: ringX }),
      "FORBIDDEN", "cross-tenant graph scan rejected",
    );
    await expectTrpcError(
      intruder.compliance.graphAlerts({ tenantId: ringX }),
      "FORBIDDEN", "cross-tenant graph alert list rejected",
    );
    await expectTrpcError(
      intruder.compliance.updateGraphAlert({ alertId: cycleAlert.id, status: "acknowledged" }),
      "FORBIDDEN", "cross-tenant graph alert update rejected",
    );
    const intruderAlerts = await intruder.compliance.graphAlerts({ tenantId: intruderTenant });
    assert(intruderAlerts.length === 0, "intruder tenant sees no graph alerts");
  },
};
