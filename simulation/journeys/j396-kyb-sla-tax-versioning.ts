// === W46 privacy-consent (Coder B) ===
/**
 * J396 — TEN-22 KYB review-queue SLA sweep + TEN-18 versioned tax profiles:
 *   TEN-22:
 *   - The /api/scheduled/kyb-sla-sweep cron (cron-only; scheduler allowlist)
 *     escalates an overdue application exactly once (claim-first), records
 *     slaBreachedAt, and is idempotent on a second run.
 *   - kyc.submit stamps slaDueAt (source contract).
 *   TEN-18:
 *   - upsertSupplierTaxProfile appends an immutable version row per change
 *     (v1, v2) with effectiveFrom + audit event.
 *   - resolveTaxProfileAsOf returns the withholding rate IN FORCE at the
 *     statement date; statements resolve the profile as-of the period end.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J396",
  name: "KYB SLA sweep cron + versioned supplier tax profiles",
  feature: "TEN-22 SLA escalation + TEN-18 effective dating",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const kybSla = await import("../../server/services/kybSla");

    // ── TEN-22: overdue KYB application escalated + breach recorded ──────
    const overdueDue = new Date(Date.now() - 2 * 3600_000); // due 2h ago
    await world.db.insert(schema.kycApplications).values({
      id: "kyb-j396-overdue",
      tenantId: TENANT_ID,
      type: "kyb",
      status: "pending",
      applicantName: "J396 Late Review",
      submittedAt: new Date(Date.now() - 50 * 3600_000),
      slaDueAt: overdueDue,
    }).onConflictDoNothing();
    // A compliant application (due in the future) must NOT be touched.
    await world.db.insert(schema.kycApplications).values({
      id: "kyb-j396-fresh",
      tenantId: TENANT_ID,
      type: "kyb",
      status: "pending",
      applicantName: "J396 Fresh",
      submittedAt: new Date(),
      slaDueAt: kybSla.kybSlaDueAt(new Date()),
    }).onConflictDoNothing();

    const cron = await world.runCron("/api/scheduled/kyb-sla-sweep");
    assert(cron.status === 200 && cron.json?.ok === true, `kyb-sla-sweep cron 200 (got ${cron.status}: ${JSON.stringify(cron.json)})`);
    assert(cron.json.run.escalated >= 1, "cron escalated the overdue application");
    const [overdue] = await world.db.select().from(schema.kycApplications)
      .where(eq(schema.kycApplications.id, "kyb-j396-overdue"));
    assert(!!overdue.escalatedAt, "escalatedAt stamped");
    assert(!!overdue.slaBreachedAt, "slaBreachedAt recorded");
    const [fresh] = await world.db.select().from(schema.kycApplications)
      .where(eq(schema.kycApplications.id, "kyb-j396-fresh"));
    assert(!fresh.escalatedAt && !fresh.slaBreachedAt, "within-SLA application untouched");

    // Idempotent: a second sweep does not re-escalate or re-alert.
    const second = await kybSla.runKybSlaSweep(world.db);
    assert(second.escalated === 0, "second sweep escalates nothing (claim-first)");

    // Queue stats surface the breach honestly.
    const stats = await kybSla.reviewQueueStats(world.db);
    assert(stats.breachedTotal >= 1, "queue stats count the breach");

    // Scheduler allowlist (J178 contract): the route must be registered.
    const { readFile } = await import("node:fs/promises");
    const sched = await readFile(new URL("../../services/scheduler/scheduler.mjs", import.meta.url), "utf8");
    assert(sched.includes('"/api/scheduled/kyb-sla-sweep"'), "scheduler allowlist registers kyb-sla-sweep");

    // submit() stamps the SLA (source contract).
    const kycRouter = await readFile(new URL("../../server/routers/kyc.ts", import.meta.url), "utf8");
    assert(kycRouter.includes("slaDueAt: kybSlaDueAt("), "kyc.submit stamps slaDueAt");

    // ── TEN-18: versioned, effective-dated supplier tax profiles ─────────
    const tax = await import("../../server/services/supplierTaxStatements");
    const supplierRef = "j396-supplier";
    const t0 = new Date(Date.now() - 3600_000);
    const first = await tax.upsertSupplierTaxProfile(world.db, {
      tenantId: TENANT_ID,
      vendorName: "J396 Plastics Ltd",
      vendorRef: supplierRef,
      taxId: "TIN-1",
      taxIdType: "tin",
      withholdingBps: 500,
      actor: "j396",
      effectiveFrom: t0,
    });
    assert(first.created === true && first.version === 1, `v1 created (got v${first.version})`);

    const t1 = new Date(Date.now() + 3600_000); // v2 effective in an hour
    const second2 = await tax.upsertSupplierTaxProfile(world.db, {
      tenantId: TENANT_ID,
      vendorName: "J396 Plastics Ltd",
      vendorRef: supplierRef,
      withholdingBps: 750,
      actor: "j396",
      effectiveFrom: t1,
    });
    assert(second2.created === false && second2.version === 2, `v2 appended (got v${second2.version})`);

    // As-of resolution: before t1 the 500bps rate is in force; after, 750.
    const asOfNow = await tax.resolveTaxProfileAsOf(world.db, TENANT_ID, supplierRef, new Date());
    assert(asOfNow?.withholdingBps === 500 && asOfNow.version === 1, "as-of now resolves v1 (500bps)");
    const asOfLater = await tax.resolveTaxProfileAsOf(world.db, TENANT_ID, supplierRef, new Date(t1.getTime() + 60_000));
    assert(asOfLater?.withholdingBps === 750 && asOfLater.version === 2, "as-of later resolves v2 (750bps)");

    // Immutable history: both versions persist.
    const versions = await world.db.select().from(schema.supplierTaxProfileVersions)
      .where(eq(schema.supplierTaxProfileVersions.supplierKey, supplierRef));
    assert(versions.length === 2, `two immutable versions persist (got ${versions.length})`);

    // Statements resolve as-of the period end (source contract).
    const svc = await readFile(new URL("../../server/services/supplierTaxStatements.ts", import.meta.url), "utf8");
    assert(svc.includes("resolveTaxProfileAsOf(db, tenantId, totals[0].supplierRef, asOf)"),
      "generateAnnualStatement resolves the profile as-of the statement year");
  },
};
