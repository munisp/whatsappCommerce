/**
 * J221 — W34 otel-sidecars: tenant metric cardinality guard.
 *
 * 1. Non-allowlisted tenants collapse to tenant_class "other"; allowlisted
 *    tenants keep their id (service helper + admin preview procedure).
 * 2. Allowlist admin ops are admin-guarded and AUDITED (audit_logs row
 *    `telemetry.allowlist.set` with before/after).
 * 3. Label cardinality stays bounded: with the allowlist set to K tenants,
 *    the set of possible label values under a simulated multi-tenant load
 *    (many distinct tenant ids) never exceeds K + 1 ("other").
 * 4. getStatus reports allowlist sizes + fail-open exporter status honestly.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J221",
  name: "telemetry cardinality guard: collapse to 'other', audited admin allowlist, bounded labels",
  feature: "W34 otel-sidecars: telemetryCardinality + telemetry admin router",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const {
      tenantMetricClass, getEffectiveAllowlist, TENANT_CLASS_OTHER,
    } = await import("../../server/services/telemetryCardinality");

    // ── 0. Tenant-guard: non-admin callers are rejected ────────────────
    const tenant = await tenantCaller("sim-tenant", { userId: 2211 });
    let rejected = false;
    try { await tenant.telemetry.getStatus(); } catch { rejected = true; }
    assert(rejected, "telemetry.getStatus is admin-guarded (tenant caller rejected)");
    rejected = false;
    try { await tenant.telemetry.setTenantAllowlist({ tenantIds: ["x"] }); } catch { rejected = true; }
    assert(rejected, "telemetry.setTenantAllowlist is admin-guarded");

    const admin = await adminCaller();

    // ── 1. Collapse semantics (pure helper) ────────────────────────────
    assert(tenantMetricClass("anyone", []) === TENANT_CLASS_OTHER,
      "empty allowlist = platform-aggregate only");
    assert(tenantMetricClass("t-allow", ["t-allow"]) === "t-allow",
      "allowlisted tenant keeps its id");
    assert(tenantMetricClass("t-random", ["t-allow"]) === TENANT_CLASS_OTHER,
      "non-allowlisted tenant collapses to 'other'");

    // ── 2. Admin allowlist ops: persisted + audited ────────────────────
    const set1 = await admin.telemetry.setTenantAllowlist({ tenantIds: ["sim-tenant", "sim-supplier"] });
    assert(set1.success === true && set1.count === 2, `allowlist persisted (count=${set1.count})`);
    const status = await admin.telemetry.getStatus();
    assert(status.allowlist.persistedCount === 2, `getStatus persisted count (got ${status.allowlist.persistedCount})`);
    assert(status.allowlist.effective.includes("sim-tenant"), "getStatus lists effective allowlist");
    assert(typeof status.enabled === "boolean" && typeof status.exporter.configured === "boolean",
      "getStatus reports exporter state honestly");

    const audits = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "telemetry.allowlist.set"));
    assert(audits.length === 1, `allowlist op audited (got ${audits.length} rows)`);
    const audit = audits[0];
    assert(audit.actorId === "admin:1" && audit.actorRole === "admin",
      `audit actor is the admin (${audit.actorId}/${audit.actorRole})`);
    assert(JSON.stringify(audit.after).includes("sim-tenant"), "audit after snapshot lists tenants");

    // Second op replaces the first and is audited with before/after.
    await admin.telemetry.setTenantAllowlist({ tenantIds: ["sim-supplier"] });
    const audits2 = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "telemetry.allowlist.set"));
    assert(audits2.length === 2, "second allowlist op audited too");
    const before = JSON.stringify(audits2.map((a: any) => a.before));
    assert(before.includes("sim-tenant"), "before snapshot captured previous allowlist");

    // ── 3. Admin preview procedure reflects the persisted allowlist ────
    const cls1 = await admin.telemetry.tenantClass({ tenantId: "sim-supplier" });
    assert(cls1.tenantClass === "sim-supplier", `allowlisted class (${cls1.tenantClass})`);
    const cls2 = await admin.telemetry.tenantClass({ tenantId: "tenant-not-allowlisted" });
    assert(cls2.tenantClass === TENANT_CLASS_OTHER, `others collapse (${cls2.tenantClass})`);

    // ── 4. Bounded label cardinality under multi-tenant load ───────────
    const allowlist = await getEffectiveAllowlist(world.db);
    assert(allowlist.length === 1, `effective allowlist = persisted ∪ env (got ${allowlist.length})`);
    const labels = new Set<string>();
    // Simulate a /api/metrics scrape's label derivation for many tenants.
    for (let i = 0; i < 500; i++) labels.add(tenantMetricClass(`load-tenant-${i}`, allowlist));
    labels.add(tenantMetricClass("sim-supplier", allowlist));
    assert(labels.size <= allowlist.length + 1,
      `label cardinality bounded: ${labels.size} ≤ allowlist(${allowlist.length}) + 1`);
    assert(labels.has(TENANT_CLASS_OTHER) && labels.has("sim-supplier"),
      "labels = {allowlisted tenants} ∪ {other}");
  },
};
