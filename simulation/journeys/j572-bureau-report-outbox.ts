// === W56 credit ===
/**
 * J572 — Bureau repayment report-back outbox: idempotent enqueue (unique
 * idempotencyKey — replays are no-ops), claim-first sweep with bounded
 * backoff on provider failure, deterministic accept on the sandbox
 * provider, and a no-op re-sweep once sent. Extends J69/W14 bureau-retry
 * semantics to subject-level repayment performance.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J572",
  name: "bureau report-back outbox idempotent retry with backoff",
  feature: "W56 bureau: reportRepayment + runBureauReportSweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const bureau = await import("../../server/services/bureau");

    const subjectId = `cust-j572-${world.newPhone("572").slice(-6)}`;
    const events = [
      { tenantId: TENANT_ID, subjectType: "buyer" as const, subjectId, eventType: "paid_on_time" as const, amountCents: 500_000, ref: "repay:j572:1" },
      { tenantId: TENANT_ID, subjectType: "buyer" as const, subjectId, eventType: "late" as const, amountCents: 250_000, ref: "repay:j572:2" },
    ];

    // ── 1. Idempotent enqueue ────────────────────────────────────────────
    const n1 = await bureau.reportRepayment(world.db as any, events);
    assert(n1 === 2, "two events enqueued");
    const n2 = await bureau.reportRepayment(world.db as any, events);
    assert(n2 === 0, "replay enqueues nothing (idempotency keys)");
    const rows0 = await world.db
      .select()
      .from(schema.bureauReportOutbox)
      .where(eq(schema.bureauReportOutbox.subjectId, subjectId));
    assert(rows0.length === 2 && rows0.every((r) => r.status === "pending"), "exactly two pending rows");

    // ── 2. Failing provider → failed + bounded backoff, retryable ────────
    const failing = {
      env: { BUREAU_W56_PROVIDER: "firstcentral", FIRSTCENTRAL_BUREAU_URL: "http://bureau.sim.local/report", FIRSTCENTRAL_BUREAU_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetcher: (async () => ({ ok: false, status: 500, data: null })) as any,
    };
    const failRun = await bureau.runBureauReportSweep(world.db as any, { tenantId: TENANT_ID }, failing);
    assert(failRun.failed === 2 && failRun.sent === 0, `provider outage marks failures (${JSON.stringify(failRun)})`);
    const rowsFailed = await world.db
      .select()
      .from(schema.bureauReportOutbox)
      .where(eq(schema.bureauReportOutbox.subjectId, subjectId));
    assert(rowsFailed.every((r) => r.status === "failed" && r.attempts === 1 && r.nextRetryAt), "failed rows carry attempts + nextRetryAt backoff");
    assert(rowsFailed.every((r) => new Date(r.nextRetryAt!).getTime() > Date.now()), "backoff defers the retry");

    // ── 3. Not-yet-due rows are skipped by an immediate re-sweep ─────────
    const early = await bureau.runBureauReportSweep(world.db as any, { tenantId: TENANT_ID }, {
      env: { BUREAU_W56_PROVIDER: "sandbox" } as NodeJS.ProcessEnv,
    });
    assert(early.sent === 0 && early.attempted === 0, "backoff horizon respected (no early retry)");

    // ── 4. Provider recovers → due rows send deterministically ───────────
    await world.backdate(
      `UPDATE bureau_report_outbox SET "nextRetryAt" = now() - interval '1 minute' WHERE "subjectId" = $1`,
      [subjectId],
    );
    const okRun = await bureau.runBureauReportSweep(world.db as any, { tenantId: TENANT_ID }, {
      env: { BUREAU_W56_PROVIDER: "sandbox" } as NodeJS.ProcessEnv,
    });
    assert(okRun.sent === 2 && okRun.failed === 0, `sandbox sweep sends the due rows (${JSON.stringify(okRun)})`);
    const rowsSent = await world.db
      .select()
      .from(schema.bureauReportOutbox)
      .where(eq(schema.bureauReportOutbox.subjectId, subjectId));
    assert(rowsSent.every((r) => r.status === "sent" && r.reportedAt), "rows marked sent with reportedAt");

    // ── 5. Re-sweep is a no-op (nothing eligible) ────────────────────────
    const again = await bureau.runBureauReportSweep(world.db as any, { tenantId: TENANT_ID }, {
      env: { BUREAU_W56_PROVIDER: "sandbox" } as NodeJS.ProcessEnv,
    });
    assert(again.sent === 0 && again.failed === 0 && again.attempted === 0, "re-sweep is a no-op once sent");

    // ── 6. New event for the same subject still enqueues (key differs) ───
    const n3 = await bureau.reportRepayment(world.db as any, [
      { tenantId: TENANT_ID, subjectType: "buyer", subjectId, eventType: "settled", amountCents: 750_000, ref: "repay:j572:3" },
    ]);
    assert(n3 === 1, "distinct event enqueues normally");
  },
};
