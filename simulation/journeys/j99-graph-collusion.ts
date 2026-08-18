/**
 * J99 — W22 graph-based collusion detection for the credit/anti-gaming stack.
 *
 * Scenario (fully deterministic — scan clock injected via the `now` input):
 *   1. Collusion ring: three tenants (A, B, C) trade in a circle — A's owner
 *      phone orders from B, B's from C, C's from A (4 orders per direction).
 *      Honest buyers (H1, H2) trade dispersed volume with no cycles.
 *   2. Scan: compliance.scanGraphCollusion builds the tenant trade graph and
 *      flags every ring member (cycle + concentration + cluster) while the
 *      honest buyers stay clean; evidence carries the ring path.
 *   3. Idempotency: re-scanning the same window bucket creates no duplicates.
 *   4. Scoring integration: tradeCredit.suggestLimit for a ring buyer carries
 *      the 'graph-collusion' anti-gaming flag; an honest buyer does not.
 *   5. Workflow + guards: ack/dismiss transitions; cross-tenant callers are
 *      FORBIDDEN on scan, list, and update.
 */
import { assert } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J99",
  name: "graph collusion detection",
  feature: "tenant trade graph, cycle/concentration/cluster signals, idempotent graph_alerts, scoring flag, tenant guards",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

    // ── Tenants: ring A/B/C + honest H1/H2 ──────────────────────────────
    const mk = async (name: string) => (await admin.onboarding.start({ name })).tenantId;
    const ringA = await mk("J99 Ring A");
    const ringB = await mk("J99 Ring B");
    const ringC = await mk("J99 Ring C");
    const honest1 = await mk("J99 Honest 1");
    const honest2 = await mk("J99 Honest 2");
    const intruderTenant = await mk("J99 Intruder");

    const phoneOf = new Map([
      [ringA, "+234990001"],
      [ringB, "+234990002"],
      [ringC, "+234990003"],
      [honest1, "+234990101"],
      [honest2, "+234990102"],
    ]);
    for (const [tenantId, phone] of phoneOf) {
      await world.db.insert(schema.users).values({
        openId: `j99-user-${tenantId}`,
        email: `j99-${tenantId}@sim.local`,
        name: `J99 ${tenantId}`,
        loginMethod: "keycloak",
        role: "user",
        tenantId,
        phone,
        lastSignedIn: new Date(),
      });
    }

    // ── Orders: an order at seller S by buyer-phone P is an edge ────────
    const customersSeen = new Set<string>();
    let orderSeq = 0;
    async function trade(seller: string, buyerPhone: string, major: string, daysBack: number) {
      const cid = `j99-c-${buyerPhone.slice(-6)}-at-${seller.slice(-4)}`;
      if (!customersSeen.has(cid)) {
        customersSeen.add(cid);
        await world.db.insert(schema.customers).values({
          id: cid, tenantId: seller, whatsappPhone: buyerPhone, name: `J99 buyer ${buyerPhone}`,
        }).onConflictDoNothing();
      }
      orderSeq += 1;
      await world.db.insert(schema.orders).values({
        id: `j99-ord-${orderSeq}`,
        tenantId: seller,
        customerId: cid,
        orderNumber: `J99-${orderSeq}`,
        status: "delivered",
        totalAmount: major,
        currency: "NGN",
        createdAt: daysAgo(daysBack),
        updatedAt: daysAgo(daysBack),
      }).onConflictDoNothing();
    }

    // Ring: A→B→C→A, heavy volume, 4 orders per direction (12 orders).
    for (let i = 0; i < 4; i++) {
      await trade(ringB, phoneOf.get(ringA)!, "50000.00", 2 + i); // A buys from B
      await trade(ringC, phoneOf.get(ringB)!, "50000.00", 3 + i); // B buys from C
      await trade(ringA, phoneOf.get(ringC)!, "50000.00", 4 + i); // C buys from A
    }
    // Honest buyers: dispersed trade, no cycle, no concentration (5 orders).
    await trade(ringA, phoneOf.get(honest1)!, "3000.00", 2);
    await trade(ringB, phoneOf.get(honest1)!, "3000.00", 3);
    await trade(ringC, phoneOf.get(honest1)!, "3000.00", 4);
    await trade(ringA, phoneOf.get(honest2)!, "2000.00", 5);
    await trade(ringB, phoneOf.get(honest2)!, "2000.00", 6);

    const callerA = await tenantCaller(ringA, { userId: 990 });
    const callerH1 = await tenantCaller(honest1, { userId: 991 });
    const intruder = await tenantCaller(intruderTenant, { userId: 992 });

    // ── 2. Scan: ring flagged, honest clean ──────────────────────────────
    const scan = await callerA.compliance.scanGraphCollusion({ tenantId: ringA, now: now.toISOString() });
    assert(scan.error === undefined, `scan has no error (got ${scan.error})`);
    assert(scan.insufficient === false, `graph has enough data (got ${JSON.stringify(scan)})`);
    const byBuyer = new Map<string, string[]>();
    for (const a of scan.alerts) {
      byBuyer.set(a.buyerId, [...(byBuyer.get(a.buyerId) ?? []), a.signal]);
    }
    for (const ring of [ringA, ringB, ringC]) {
      const sigs = (byBuyer.get(ring) ?? []).sort();
      assert(sigs.includes("cycle"), `ring member ${ring} has a cycle alert (got ${sigs})`);
      assert(sigs.includes("concentration"), `ring member ${ring} has a concentration alert (got ${sigs})`);
      assert(sigs.includes("cluster"), `ring member ${ring} has a cluster alert (got ${sigs})`);
    }
    assert(!byBuyer.has(honest1) && !byBuyer.has(honest2),
      `honest buyers are not flagged (got ${JSON.stringify(scan.alerts.map((a) => a.buyerId))})`);

    // Evidence: the cycle alert for A carries the ring path.
    const listed = await callerA.compliance.graphAlerts({ tenantId: ringA, status: "open" });
    assert(listed.length === scan.alertsCreated, `all alerts listed open (got ${listed.length} vs ${scan.alertsCreated})`);
    const cycleAlert = listed.find((a: any) => a.buyerId === ringA && a.signal === "cycle") as any;
    const paths = (cycleAlert?.evidence?.cyclePaths ?? []) as string[];
    assert(paths.some((p) => p.includes(ringA) && p.includes(ringB) && p.includes(ringC)),
      `cycle evidence names the ring (got ${JSON.stringify(paths)})`);
    const clusterAlert = listed.find((a: any) => a.buyerId === ringA && a.signal === "cluster") as any;
    assert(clusterAlert?.evidence?.clusterSize === 3, `cluster evidence size 3 (got ${JSON.stringify(clusterAlert?.evidence)})`);

    // ── 3. Idempotent re-scan ────────────────────────────────────────────
    const again = await callerA.compliance.scanGraphCollusion({ tenantId: ringA, now: now.toISOString() });
    assert(again.alertsCreated === 0, `re-scan creates no duplicates (got ${again.alertsCreated})`);
    const afterRescan = await callerA.compliance.graphAlerts({ tenantId: ringA });
    assert(afterRescan.length === scan.alertsCreated,
      `alert count stable across re-scan (got ${afterRescan.length} vs ${scan.alertsCreated})`);

    // ── 4. Scoring integration: ring buyer carries the flag ──────────────
    const scoredRing = await callerA.tradeCredit.suggestLimit({ supplierTenantId: ringA, buyerTenantId: ringA });
    assert(scoredRing.antiGamingFlags.includes("graph-collusion"),
      `ring buyer scoring carries graph-collusion flag (got ${JSON.stringify(scoredRing.antiGamingFlags)})`);
    const scoredHonest = await callerH1.tradeCredit.suggestLimit({ supplierTenantId: honest1, buyerTenantId: honest1 });
    assert(!scoredHonest.antiGamingFlags.includes("graph-collusion"),
      `honest buyer scoring has no graph-collusion flag (got ${JSON.stringify(scoredHonest.antiGamingFlags)})`);

    // ── 5. Workflow + cross-tenant guards ────────────────────────────────
    const ack = await callerA.compliance.updateGraphAlert({ alertId: cycleAlert.id, status: "acknowledged" });
    assert(ack.ok === true, "acknowledge ok");
    const acked = await callerA.compliance.graphAlerts({ tenantId: ringA, status: "acknowledged" });
    assert(acked.length === 1 && acked[0].id === cycleAlert.id, "acknowledged alert filtered");

    await expectTrpcError(
      intruder.compliance.scanGraphCollusion({ tenantId: ringA }),
      "FORBIDDEN", "cross-tenant graph scan rejected",
    );
    await expectTrpcError(
      intruder.compliance.graphAlerts({ tenantId: ringA }),
      "FORBIDDEN", "cross-tenant graph alert list rejected",
    );
    await expectTrpcError(
      intruder.compliance.updateGraphAlert({ alertId: cycleAlert.id, status: "dismissed" }),
      "FORBIDDEN", "cross-tenant graph alert update rejected",
    );

    // Tenant isolation: the intruder's own alert view is empty.
    const intruderAlerts = await intruder.compliance.graphAlerts({ tenantId: intruderTenant });
    assert(intruderAlerts.length === 0, "intruder tenant has no graph alerts");
  },
};
