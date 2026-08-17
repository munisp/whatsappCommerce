/**
 * J93 — Manufacturer credit program (W18, part 2). A manufacturer tenant
 * runs a capped credit program for its merchant buyers:
 *   - create draft → activate; cross-tenant callers are FORBIDDEN;
 *   - buyer requests credit (tradeCredit.requestAccount), the account is
 *     approved and assigned into the program book;
 *   - a draw inside every cap is allowed and posted;
 *   - a draw past the per-buyer exposure cap is DECLINED with reasons;
 *   - program-capped limit suggestion: min(platform, maxExposure, capacity);
 *   - repayment cures the account and the program book reflects it
 *     (utilization back to zero, concentration cleared).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J93",
  name: "manufacturer credit program",
  feature: "program CRUD/caps, checkDrawAllowed, program-capped suggestLimit, book cure",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    const mfr = (await admin.onboarding.start({ name: "J93 Manufacturer" })).tenantId;
    const buy = (await admin.onboarding.start({ name: "J93 Buyer" })).tenantId;
    const mfrCaller = await tenantCaller(mfr, { userId: 930 });
    const buyCaller = await tenantCaller(buy, { userId: 931 });
    const intruder = await tenantCaller((await admin.onboarding.start({ name: "J93 Intruder" })).tenantId, { userId: 932 });

    // ── Create draft → activate; tenant isolation ─────────────────────────
    const program = await mfrCaller.manufacturerPrograms.create({
      tenantId: mfr,
      name: "J93 Distributor Terms",
      maxExposureCents: 10_000_000, // ₦100,000 per buyer
      programCapCents: 50_000_000, // ₦500,000 book cap
      concentrationCapBps: 10000, // single-buyer book — concentration math covered by unit tests
      allowedTenorDays: [30, 60],
      feeBps: 150,
      scoringWeights: { onTime: 0.6 },
    });
    assert(program.status === "draft", "program starts as draft");
    assert(program.concentrationCapBps === 10000 && program.feeBps === 150, "program fields persisted");

    await expectTrpcError(
      intruder.manufacturerPrograms.list({ tenantId: mfr }),
      "FORBIDDEN", "cross-tenant list rejected",
    );
    await expectTrpcError(
      intruder.manufacturerPrograms.setStatus({ tenantId: mfr, programId: program.id, status: "active" }),
      "FORBIDDEN", "cross-tenant status change rejected",
    );
    const dup = await expectTrpcError(
      mfrCaller.manufacturerPrograms.create({
        tenantId: mfr, name: "J93 Distributor Terms", maxExposureCents: 1, programCapCents: 1,
      }),
      "CONFLICT", "duplicate (tenant,name) rejected",
    );
    assert(dup.message.includes("J93 Distributor Terms"), "conflict names the program");

    const got = await mfrCaller.manufacturerPrograms.get({ tenantId: mfr, programId: program.id });
    assert(got.effectiveScoring.weights.onTime === 0.6, "scoring override resolved");
    assert(got.effectiveScoring.weights.volume === 0.3, "default weight kept");

    await mfrCaller.manufacturerPrograms.setStatus({ tenantId: mfr, programId: program.id, status: "active" });

    // ── Buyer requests credit under the manufacturer ──────────────────────
    const requested = await buyCaller.tradeCredit.requestAccount({
      buyerTenantId: buy,
      supplierTenantId: mfr,
      note: "J93 program account",
    });
    const accountId = (requested as any).id ?? (requested as any).accountId;
    assert(typeof accountId === "string", "requestAccount returns an account id");
    // Approve out-of-band (KYB/mandate gates are covered by J58/J72): activate
    // with a ₦100k limit and a 30-day tenor.
    await world.db
      .update(schema.creditAccounts)
      .set({ limitCents: 10_000_000, termsDays: 30, status: "active" })
      .where(eq(schema.creditAccounts.id, accountId));
    const asg = await mfrCaller.manufacturerPrograms.assignAccount({
      tenantId: mfr, programId: program.id, accountId,
    });
    assert(asg.programId === program.id, "account assigned into the program");

    // ── Draw inside caps → allowed; post the draw ─────────────────────────
    const ok = await mfrCaller.manufacturerPrograms.checkDrawAllowed({
      tenantId: mfr, programId: program.id, buyerTenantId: buy, amountCents: 6_000_000,
    });
    assert(ok.allowed === true && ok.reasons.length === 0, `draw within caps allowed (got ${JSON.stringify(ok)})`);
    await world.db.insert(schema.creditLedger).values({
      creditAccountId: accountId, kind: "invoice_draw", amountCents: 6_000_000,
      poId: "po-j93-1", dueDate: new Date(Date.now() + 30 * DAY_MS), ref: "draw:po-j93-1",
    });
    await world.db
      .update(schema.creditAccounts)
      .set({ outstandingCents: 6_000_000 })
      .where(eq(schema.creditAccounts.id, accountId));

    // ── Draw past per-buyer exposure → declined with reasons ──────────────
    const declined = await mfrCaller.manufacturerPrograms.checkDrawAllowed({
      tenantId: mfr, programId: program.id, buyerTenantId: buy, amountCents: 5_000_000,
    });
    assert(declined.allowed === false, "draw beyond per-buyer exposure declined");
    assert(
      declined.reasons.some((r: string) => r.includes("per-buyer exposure")),
      `decline reason names per-buyer exposure (got ${JSON.stringify(declined.reasons)})`,
    );

    // ── Program-capped limit suggestion ───────────────────────────────────
    // Cold-start platform floor is ₦50k (5_000_000); a tight twin program
    // with maxExposure ₦30k must clamp the suggestion to 3_000_000.
    const tight = await mfrCaller.manufacturerPrograms.create({
      tenantId: mfr, name: "J93 Tight", maxExposureCents: 3_000_000, programCapCents: 50_000_000,
    });
    const suggestion = await mfrCaller.manufacturerPrograms.suggestLimitForProgram({
      tenantId: mfr, programId: tight.id, buyerTenantId: buy,
    });
    assert(suggestion.suggestedLimitCents === 3_000_000, `suggestion clamped to program maxExposure (got ${suggestion.suggestedLimitCents})`);
    assert(suggestion.baseSuggestedLimitCents >= 5_000_000, "base platform suggestion preserved");
    assert(suggestion.reasons.some((r: string) => r.includes("capped by program")), "cap reason attached");

    // ── Repayment cures the account; the book reflects the cure ───────────
    const before = await mfrCaller.manufacturerPrograms.programBook({ tenantId: mfr, programId: program.id });
    assert(before.totalOutstandingCents === 6_000_000, "book shows the draw");
    assert(before.utilizationBps === 1200, `utilization 6/50 = 1200bps (got ${before.utilizationBps})`);
    assert(before.concentration[0]?.buyerTenantId === buy && before.concentration[0]?.shareBps === 10000, "single buyer = 100% of book");

    await world.db.insert(schema.creditLedger).values({
      creditAccountId: accountId, kind: "repayment", amountCents: -6_000_000,
      ref: "repay:j93-1", note: "J93 full repayment",
    });
    await world.db
      .update(schema.creditAccounts)
      .set({ outstandingCents: 0 })
      .where(eq(schema.creditAccounts.id, accountId));

    const after = await mfrCaller.manufacturerPrograms.programBook({ tenantId: mfr, programId: program.id });
    assert(after.totalOutstandingCents === 0, "book reflects the cure");
    assert(after.utilizationBps === 0, "utilization back to zero");
    assert(after.remainingCapacityCents === 50_000_000, "full capacity restored");

    // ── Program tape: rows + summary + CSV ────────────────────────────────
    const tape = await mfrCaller.manufacturerPrograms.programTape({ tenantId: mfr, programId: program.id, format: "json" });
    assert(tape.format === "json" && tape.rows.length === 1, "tape has the one assigned account");
    const row = tape.rows[0] as any;
    assert(row.accountId === accountId && row.bucket === "current", "account current after repayment window");
    assert(row.outstandingCents === 0, "tape row shows zero outstanding");
    const csv = await mfrCaller.manufacturerPrograms.programTape({ tenantId: mfr, programId: program.id, format: "csv" });
    assert(csv.format === "csv" && csv.content.includes(accountId), "csv export carries the account row");
    assert(csv.filename.endsWith(".csv"), "csv filename");
  },
};
