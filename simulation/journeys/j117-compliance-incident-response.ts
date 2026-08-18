/**
 * J117 — O1 stakeholder journey (compliance officer): verify the tamper-
 * evident audit chain → inject tampering → firstBrokenId pinpoints the row →
 * restore → off-hours sensitive-event burst → anomaly scan raises alerts and
 * auto-opens a critical incident → copilot triages the incident (LLM
 * disabled → deterministic heuristic fallback) → officer resolves it.
 *
 * Exercises: compliance.verifyAuditChain, compliance.anomalyScan /
 * anomalyAlerts, copilot.triageIncident (fallback + runbook + audit log),
 * compliance.updateIncident.
 */
import { eq } from "drizzle-orm";
import { assert } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";
import { GENESIS_HASH, canonicalEventFields, computeAuditHash } from "../../server/services/auditChain";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function at(ref: Date, daysAgo: number, hod: number, minute = 0): Date {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hod, minute));
  return new Date(d.getTime() - daysAgo * DAY_MS);
}

export const journey: Journey = {
  id: "J117",
  name: "compliance officer: chain tamper → anomaly burst → copilot triage → resolve",
  feature: "O1 incident-response lifecycle end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    assert(!process.env.COPILOT_LLM_ENABLED, "J117 requires the LLM disabled (deterministic fallback)");
    const admin = await adminCaller();

    const tenant = (await admin.onboarding.start({ name: "J117 Compliance Tenant" })).tenantId;
    const officer = await tenantCaller(tenant, { userId: 1170 });

    // ── Seed: two weeks of hash-chained business-hours traffic ───────────
    const ref = new Date();
    const scanNormalNow = at(ref, 1, 10, 30);
    const scanBurstNow = at(ref, 0, 3, 30);
    const burstBucket = at(ref, 0, 3, 0);

    let prevHash = GENESIS_HASH;
    async function put(eventType: string, actorId: string, createdAt: Date, payload: unknown = null) {
      const fields = { tenantId: tenant, eventType, actorId, payload, createdAt };
      const hash = computeAuditHash(prevHash, canonicalEventFields(fields));
      await world.db.insert(schema.auditChain).values({
        tenantId: tenant, eventType, actorId, payload: payload as any, prevHash, hash, createdAt,
      });
      prevHash = hash;
    }
    for (let d = 13; d >= 2; d--) {
      await put("order.created", "j117-staff", at(ref, d, 10, 5));
      await put("order.created", "j117-staff", at(ref, d, 11, 5));
    }
    await put("order.created", "j117-staff", at(ref, 1, 10, 2));
    await put("order.created", "j117-staff", at(ref, 1, 10, 20));

    // ── 1. Chain verifies ────────────────────────────────────────────────
    const ok1 = await officer.compliance.verifyAuditChain({ tenantId: tenant });
    assert(ok1.ok === true && ok1.firstBrokenId === null, `chain verifies (got ${JSON.stringify(ok1)})`);
    assert(ok1.rowsChecked >= 26, `all seeded rows checked (got ${ok1.rowsChecked})`);

    // ── 2. Inject tamper → firstBrokenId detected → restore ──────────────
    const chainRows = await world.db.select().from(schema.auditChain).where(eq(schema.auditChain.tenantId, tenant));
    const victim = chainRows[0];
    const originalPayload = victim.payload;
    await world.db.update(schema.auditChain).set({ payload: { tampered: true } }).where(eq(schema.auditChain.id, victim.id));
    const broken = await officer.compliance.verifyAuditChain({ tenantId: tenant });
    assert(broken.ok === false, "tampered chain fails verification");
    assert(broken.firstBrokenId === victim.id, `firstBrokenId pinpoints the tampered row (got ${broken.firstBrokenId})`);
    await world.db.update(schema.auditChain).set({ payload: originalPayload }).where(eq(schema.auditChain.id, victim.id));
    const restored = await officer.compliance.verifyAuditChain({ tenantId: tenant });
    assert(restored.ok === true, "chain verifies again after restore");

    // ── 3. Baseline scan clean, then an off-hours sensitive burst ────────
    const normal = await officer.compliance.anomalyScan({ tenantId: tenant, now: scanNormalNow.toISOString() });
    assert(normal.baselineBuilding === false && normal.alertsCreated === 0,
      `normal traffic raises no alerts (got ${JSON.stringify(normal.alerts)})`);

    for (let i = 0; i < 5; i++) {
      await put("retention_purge", "j117-attacker", new Date(burstBucket.getTime() + i * 60_000), { entity: "messages", deleted: 250 });
      await put("customer_data_export", "j117-attacker", new Date(burstBucket.getTime() + i * 60_000 + 30_000), { customerId: `c-${i}` });
    }
    const burst = await officer.compliance.anomalyScan({ tenantId: tenant, now: scanBurstNow.toISOString() });
    assert(burst.alertsCreated >= 1, `burst creates alerts (got ${JSON.stringify(burst.alerts)})`);
    assert(burst.alerts.some((a) => a.signal === "sensitive_event_rate" && a.score >= 0.8),
      "sensitive-event-rate alert over threshold");
    assert(burst.incidentId, "extreme burst auto-opens an incident");
    const open = await officer.compliance.listIncidents({ tenantId: tenant, status: "open" });
    const incident = open.find((i: any) => i.id === burst.incidentId);
    assert(incident && incident.severity === "critical", "auto-opened critical incident listed");

    // ── 4. Copilot triage (LLM disabled → heuristic fallback) ────────────
    const triage = await officer.copilot.triageIncident({ tenantId: tenant, incidentId: burst.incidentId! });
    assert(triage.fallbackUsed === true, "copilot uses the heuristic fallback");
    assert(triage.severitySuggestion === "critical",
      `triage escalates the anomaly incident to critical (got ${triage.severitySuggestion})`);
    assert(triage.likelyCause.includes("sensitive_event_rate"),
      `likely cause references the anomaly signal (got ${triage.likelyCause})`);
    assert(Array.isArray(triage.runbookSteps) && triage.runbookSteps.length >= 3, "runbook steps returned");

    // Triage is audit-logged (sha256 hashes only).
    const logs = (await world.db.select().from(schema.copilotQueries)).filter((r: any) => r.tenantId === tenant);
    assert(logs.some((r: any) => r.kind === "triage" && /^[0-9a-f]{64}$/.test(r.promptHash)),
      "triage persisted as a hashed copilot_queries row");

    // ── 5. Officer resolves the incident; chain still intact ─────────────
    await officer.compliance.updateIncident({ incidentId: burst.incidentId!, status: "investigating" });
    await officer.compliance.updateIncident({ incidentId: burst.incidentId!, status: "resolved" });
    const resolvedList = await officer.compliance.listIncidents({ tenantId: tenant, status: "resolved" });
    assert(resolvedList.some((i: any) => i.id === burst.incidentId && i.resolvedAt), "incident resolved with resolvedAt");
    const rollup = await officer.compliance.incidentStatus({ tenantId: tenant });
    assert(rollup.resolved === 1 && rollup.open === 0, `rollup shows the resolved incident (got ${JSON.stringify(rollup)})`);
  },
};
