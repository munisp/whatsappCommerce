/**
 * J94 — SOC2 compliance controls (W19). Exercises the server-side compliance
 * surface end to end against the real stack:
 *   - incident lifecycle: create → investigating → resolved, rollup counts,
 *     cross-tenant callers are FORBIDDEN;
 *   - tamper-evident audit chain: every incident/retention mutation appends,
 *     verifyAuditChain walks the chain OK; a tampered row breaks verification
 *     at exactly that row;
 *   - retention: policy upsert → purge preview counts an expired order →
 *     legal hold suppresses the purge → hold lifted → execute deletes it.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J94",
  name: "soc2 compliance controls",
  feature: "incident lifecycle, audit-chain verify/tamper detection, retention purge preview/execute, access review",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    const tenant = (await admin.onboarding.start({ name: "J94 Compliance Tenant" })).tenantId;
    const caller = await tenantCaller(tenant, { userId: 940 });
    const intruder = await tenantCaller(
      (await admin.onboarding.start({ name: "J94 Intruder" })).tenantId,
      { userId: 941 },
    );

    // ── Incident lifecycle ────────────────────────────────────────────────
    const inc = await caller.compliance.createIncident({
      tenantId: tenant,
      severity: "high",
      title: "J94 webhook outage",
      description: "Meta webhook deliveries failing",
    });
    assert(inc.status === "open" && inc.severity === "high", "incident opens with severity");

    await expectTrpcError(
      intruder.compliance.listIncidents({ tenantId: tenant }),
      "FORBIDDEN", "cross-tenant incident list rejected",
    );
    await expectTrpcError(
      intruder.compliance.updateIncident({ incidentId: inc.id, status: "resolved" }),
      "FORBIDDEN", "cross-tenant incident update rejected",
    );

    await caller.compliance.updateIncident({ incidentId: inc.id, status: "investigating" });
    await caller.compliance.updateIncident({ incidentId: inc.id, status: "resolved" });
    const listed = await caller.compliance.listIncidents({ tenantId: tenant, status: "resolved" });
    assert(listed.length === 1 && listed[0].id === inc.id, "resolved incident listed");
    assert(listed[0].resolvedAt, "resolvedAt stamped on resolve");

    const rollup = await caller.compliance.incidentStatus({ tenantId: tenant });
    assert(rollup.resolved === 1 && rollup.open === 0 && rollup.investigating === 0 && rollup.mitigated === 0,
      `rollup counts resolved incident (got ${JSON.stringify(rollup)})`);
    assert(rollup.recent.length === 1 && rollup.recent[0].id === inc.id && rollup.recent[0].status === "resolved",
      "rollup recent carries the incident");
    assert(typeof rollup.recent[0].openedAt === "string", "recent openedAt is ISO string");

    // ── Audit chain: mutations appended, chain verifies ──────────────────
    const ok1 = await caller.compliance.verifyAuditChain({ tenantId: tenant });
    assert(ok1.ok === true && ok1.firstBrokenId === null, `chain verifies after incident lifecycle (got ${JSON.stringify(ok1)})`);
    assert(ok1.rowsChecked >= 3, `incident create + 2 updates appended (got ${ok1.rowsChecked})`);
    await expectTrpcError(
      intruder.compliance.verifyAuditChain({ tenantId: tenant }),
      "FORBIDDEN", "cross-tenant chain verify rejected",
    );

    // ── Tamper detection: corrupting a payload breaks exactly that row ────
    const chainRows = await world.db
      .select()
      .from(schema.auditChain)
      .where(eq(schema.auditChain.tenantId, tenant));
    assert(chainRows.length === ok1.rowsChecked, "service and table agree on row count");
    const victim = chainRows[0];
    await world.db
      .update(schema.auditChain)
      .set({ payload: { tampered: true } })
      .where(eq(schema.auditChain.id, victim.id));
    const broken = await caller.compliance.verifyAuditChain({ tenantId: tenant });
    assert(broken.ok === false, "tampered chain fails verification");
    assert(broken.firstBrokenId === victim.id, `first broken row is the tampered one (got ${broken.firstBrokenId})`);

    // ── Retention: policy → preview → legal hold → execute ───────────────
    await expectTrpcError(
      intruder.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30 }),
      "FORBIDDEN", "cross-tenant policy upsert rejected",
    );
    const up = await caller.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30, legalHold: false });
    assert(up.ok === true, "policy upsert ok");
    const policies = await caller.compliance.retentionPolicies({ tenantId: tenant });
    assert(policies.length === 1 && policies[0].entity === "orders" && policies[0].retentionDays === 30 && policies[0].legalHold === false,
      `policy listed (got ${JSON.stringify(policies)})`);
    assert(typeof policies[0].updatedAt === "string", "policy updatedAt is ISO string");

    // An order older than the 30-day window is a purge candidate.
    await world.db.insert(schema.orders).values({
      id: "j94-old-order",
      tenantId: tenant,
      customerId: "j94-customer",
      orderNumber: "J94-OLD-1",
      totalAmount: "100.00",
      createdAt: new Date(Date.now() - 40 * DAY_MS),
      updatedAt: new Date(Date.now() - 40 * DAY_MS),
    });
    // A fresh order is retained.
    await world.db.insert(schema.orders).values({
      id: "j94-new-order",
      tenantId: tenant,
      customerId: "j94-customer",
      orderNumber: "J94-NEW-1",
      totalAmount: "50.00",
    });

    const preview = await caller.compliance.purgePreview({ tenantId: tenant });
    const ordersPreview = preview.find((p: any) => p.entity === "orders")!;
    assert(ordersPreview.candidateRows === 1 && ordersPreview.skipped === false,
      `preview counts the expired order (got ${JSON.stringify(ordersPreview)})`);

    // Legal hold suppresses the purge even past the retention window.
    await caller.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30, legalHold: true });
    const held = await caller.compliance.purgePreview({ tenantId: tenant, entity: "orders" });
    assert(held[0].skipped === true && held[0].candidateRows === 0, "legal hold suppresses purge candidates");
    const heldExec = await caller.compliance.purgeExecute({ tenantId: tenant, entity: "orders" });
    assert(heldExec[0].deleted === 0, "no rows deleted under legal hold");

    // Lift the hold and execute: the expired order is purged, fresh one kept.
    await caller.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30, legalHold: false });
    const exec = await caller.compliance.purgeExecute({ tenantId: tenant });
    const ordersExec = exec.find((r: any) => r.entity === "orders")!;
    assert(ordersExec.deleted === 1, `purge deletes exactly the expired order (got ${ordersExec.deleted})`);
    const remaining = await world.db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(eq(schema.orders.tenantId, tenant));
    const remainingIds = remaining.map((r: any) => r.id);
    assert(!remainingIds.includes("j94-old-order"), "expired order purged");
    assert(remainingIds.includes("j94-new-order"), "fresh order retained");

    // ── Access review: per-tenant users with roles/sessions ───────────────
    await world.db.insert(schema.users).values({
      openId: "j94-reviewer",
      name: "J94 Reviewer",
      phone: "+2349000000094",
      role: "user",
      tenantId: tenant,
      lastSignedIn: new Date(),
    });
    const review = await caller.compliance.accessReview({ tenantId: tenant });
    const reviewer = review.find((r: any) => r.name === "J94 Reviewer");
    assert(reviewer, "access review includes the tenant user");
    assert(reviewer.role === "user" && reviewer.activeSessions === 1 && typeof reviewer.lastLoginAt === "string",
      `reviewer row has role/session/lastLogin (got ${JSON.stringify(reviewer)})`);
    await expectTrpcError(
      intruder.compliance.accessReview({ tenantId: tenant }),
      "FORBIDDEN", "cross-tenant access review rejected",
    );
  },
};
