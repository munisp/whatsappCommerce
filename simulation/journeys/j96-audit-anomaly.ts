/**
 * J96 — W20 ML/statistical anomaly detection over the SOC2 audit stream.
 *
 * Scenario (fully deterministic — scan clock injected via the `now` input):
 *   1. Cold start: scanning a fresh tenant returns baselineBuilding=true and
 *      writes no alerts.
 *   2. Baseline: two weeks of normal business-hours order traffic builds the
 *      EWMA baselines; a scan over normal traffic produces NO alerts.
 *   3. Attack: an off-hours (03:00 UTC) burst of sensitive events
 *      (retention purges + customer data exports) from one actor trips the
 *      detector — alerts land in anomaly_alerts and a critical incident is
 *      auto-opened (score ≥ 0.95).
 *   4. Idempotency: re-scanning the same window bucket creates no duplicates.
 *   5. Workflow: acknowledge / dismiss transitions; cross-tenant callers are
 *      FORBIDDEN on scan, list, and update; the intruder tenant's own stream
 *      is unaffected (still cold-start).
 */
import { assert } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";
import {
  GENESIS_HASH, canonicalEventFields, computeAuditHash,
} from "../../server/services/auditChain";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** UTC timestamp for `daysAgo` days before `ref`, at hour `hod`. */
function at(ref: Date, daysAgo: number, hod: number, minute = 0): Date {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hod, minute));
  return new Date(d.getTime() - daysAgo * DAY_MS);
}

export const journey: Journey = {
  id: "J96",
  name: "audit-stream anomaly detection",
  feature: "EWMA baselines, robust z-score alerts, idempotent scan buckets, auto-incident, ack/dismiss, tenant guards",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    const tenant = (await admin.onboarding.start({ name: "J96 Anomaly Tenant" })).tenantId;
    const caller = await tenantCaller(tenant, { userId: 960 });
    const intruderTenant = (await admin.onboarding.start({ name: "J96 Intruder" })).tenantId;
    const intruder = await tenantCaller(intruderTenant, { userId: 961 });

    // Deterministic "today" reference (real wall clock is fine — all buckets
    // are derived from it and every insert/scan uses the same ref).
    const ref = new Date();
    const scanNormalNow = at(ref, 1, 10, 30); // yesterday 10:30 UTC → bucket 10:00
    const scanBurstNow = at(ref, 0, 3, 30); // today 03:30 UTC → bucket 03:00
    // Keep buckets strictly ordered and baseline inside the 14d window.
    const burstBucket = at(ref, 0, 3, 0);

    // ── Hash-chained direct insert (bypasses append-time clock) ──────────
    let prevHash = GENESIS_HASH;
    async function put(eventType: string, actorId: string, createdAt: Date, payload: unknown = null) {
      const fields = { tenantId: tenant, eventType, actorId, payload, createdAt };
      const hash = computeAuditHash(prevHash, canonicalEventFields(fields));
      await world.db.insert(schema.auditChain).values({
        tenantId: tenant, eventType, actorId, payload: payload as any, prevHash, hash, createdAt,
      });
      prevHash = hash;
    }

    // ── 1. Cold start: no baseline → baselineBuilding, no alerts ─────────
    const cold = await caller.compliance.anomalyScan({ tenantId: tenant, now: scanNormalNow.toISOString() });
    assert(cold.baselineBuilding === true && cold.alertsCreated === 0 && cold.alerts.length === 0,
      `cold start returns baselineBuilding with no alerts (got ${JSON.stringify(cold)})`);

    // ── 2. Two weeks of business-hours order traffic ─────────────────────
    for (let d = 13; d >= 2; d--) {
      await put("order.created", "j96-staff", at(ref, d, 10, 5));
      await put("order.created", "j96-staff", at(ref, d, 11, 5));
    }
    // Normal traffic in the scan window: 2 orders at 10:0x (matches baseline).
    await put("order.created", "j96-staff", at(ref, 1, 10, 2));
    await put("order.created", "j96-staff", at(ref, 1, 10, 20));

    const normal = await caller.compliance.anomalyScan({ tenantId: tenant, now: scanNormalNow.toISOString() });
    assert(normal.baselineBuilding === false, `baseline ready after history (got ${JSON.stringify(normal)})`);
    assert(normal.baselineEvents >= 20, `baseline counts history (got ${normal.baselineEvents})`);
    assert(normal.alertsCreated === 0, `normal traffic raises no alerts (got ${JSON.stringify(normal.alerts)})`);
    const noAlerts = await caller.compliance.anomalyAlerts({ tenantId: tenant });
    assert(noAlerts.length === 0, "alert table empty after clean scan");

    // ── 3. Off-hours sensitive burst → alerts + auto-incident ────────────
    for (let i = 0; i < 5; i++) {
      await put("retention_purge", "j96-attacker", new Date(burstBucket.getTime() + i * 60_000), { entity: "orders", deleted: 500 });
      await put("customer_data_export", "j96-attacker", new Date(burstBucket.getTime() + i * 60_000 + 30_000), { customerId: `c-${i}` });
    }
    const burst = await caller.compliance.anomalyScan({ tenantId: tenant, now: scanBurstNow.toISOString() });
    assert(burst.baselineBuilding === false && burst.windowEvents === 10,
      `burst scan sees the window (got ${JSON.stringify({ b: burst.baselineBuilding, w: burst.windowEvents })})`);
    assert(burst.alertsCreated >= 1, `burst creates alerts (got ${JSON.stringify(burst.alerts)})`);
    const sensitive = burst.alerts.find((a) => a.signal === "sensitive_event_rate");
    assert(sensitive && sensitive.score >= 0.8, `sensitive-event-rate alert over threshold (got ${JSON.stringify(burst.alerts)})`);
    assert(burst.alerts.some((a) => a.score >= 0.95), "extreme burst reaches auto-incident score");
    assert(burst.incidentId, "score ≥ 0.95 auto-opens an incident");
    const incidents = await caller.compliance.listIncidents({ tenantId: tenant, status: "open" });
    assert(incidents.some((i: any) => i.id === burst.incidentId && i.severity === "critical"),
      "auto-opened critical incident listed");

    // ── 4. Idempotent re-scan of the same bucket ─────────────────────────
    const again = await caller.compliance.anomalyScan({ tenantId: tenant, now: scanBurstNow.toISOString() });
    assert(again.alertsCreated === 0, `re-scan creates no duplicates (got ${again.alertsCreated})`);
    const alertsAfterRescan = await caller.compliance.anomalyAlerts({ tenantId: tenant });
    assert(alertsAfterRescan.length === burst.alertsCreated,
      `alert count stable across re-scan (got ${alertsAfterRescan.length} vs ${burst.alertsCreated})`);

    // ── 5. Ack / dismiss workflow + tenant guards ────────────────────────
    const openAlerts = await caller.compliance.anomalyAlerts({ tenantId: tenant, status: "open" });
    assert(openAlerts.length === burst.alertsCreated, "status filter lists open alerts");
    assert(typeof openAlerts[0].score === "number" && openAlerts[0].signal && openAlerts[0].createdAt,
      "alert rows carry signal/score/createdAt");
    const ackTarget = openAlerts[0];
    const ack = await caller.compliance.updateAnomalyAlert({ alertId: ackTarget.id, status: "acknowledged" });
    assert(ack.ok === true, "acknowledge ok");
    const acked = await caller.compliance.anomalyAlerts({ tenantId: tenant, status: "acknowledged" });
    assert(acked.length === 1 && acked[0].id === ackTarget.id, "acknowledged alert filtered");
    if (openAlerts.length > 1) {
      await caller.compliance.updateAnomalyAlert({ alertId: openAlerts[1].id, status: "dismissed" });
      const dismissed = await caller.compliance.anomalyAlerts({ tenantId: tenant, status: "dismissed" });
      assert(dismissed.length === 1, "dismissed alert filtered");
    }

    // Cross-tenant guards: intruder cannot scan, list, or update.
    await expectTrpcError(
      intruder.compliance.anomalyScan({ tenantId: tenant }),
      "FORBIDDEN", "cross-tenant anomaly scan rejected",
    );
    await expectTrpcError(
      intruder.compliance.anomalyAlerts({ tenantId: tenant }),
      "FORBIDDEN", "cross-tenant anomaly alert list rejected",
    );
    await expectTrpcError(
      intruder.compliance.updateAnomalyAlert({ alertId: ackTarget.id, status: "dismissed" }),
      "FORBIDDEN", "cross-tenant anomaly alert update rejected",
    );

    // Tenant isolation: intruder's own stream is still cold-start.
    const intruderScan = await intruder.compliance.anomalyScan({ tenantId: intruderTenant });
    assert(intruderScan.baselineBuilding === true && intruderScan.alertsCreated === 0,
      "intruder tenant unaffected by victim tenant's stream");

    // Audit chain still verifies after all direct inserts (hash-chained).
    const chain = await caller.compliance.verifyAuditChain({ tenantId: tenant });
    assert(chain.ok === true, `audit chain intact after journey inserts (got ${JSON.stringify(chain)})`);
  },
};
