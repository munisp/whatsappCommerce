/**
 * J108 — S2: manufacturer credit program → draw gating with exact bps math →
 * concentration/exposure caps enforced → program tape CSV.
 *
 *   1. Pure evaluateDraw math: per-buyer exposure, program cap, and the
 *      cross-multiplied concentration comparison (buyer·10000 ≤ capBps·book)
 *      — each violated rule contributes its own reason.
 *   2. End-to-end via the real router: two buyer accounts in the program
 *      book; a draw inside every cap is allowed; draws past the per-buyer
 *      exposure cap AND past the concentration cap are rejected with named
 *      reasons; a draft (non-active) program rejects draws.
 *   3. generateProgramTape (format=csv) returns a parseable CSV with one row
 *      per assigned account plus utilization/concentration summary.
 *   4. Tenant guards: cross-tenant tape + checkDrawAllowed are FORBIDDEN.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J108",
  name: "manufacturer program caps + tape CSV",
  feature: "evaluateDraw bps math, exposure/concentration caps, program tape CSV, tenant guards",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const mfr = await import("../../server/services/manufacturerPrograms");
    const admin = await adminCaller();
    const mfrT = (await admin.onboarding.start({ name: "J108 Manufacturer" })).tenantId;
    const buyA = (await admin.onboarding.start({ name: "J108 Buyer A" })).tenantId;
    const buyB = (await admin.onboarding.start({ name: "J108 Buyer B" })).tenantId;
    const mfrCaller = await tenantCaller(mfrT, { userId: 1080 });
    const intruder = await tenantCaller((await admin.onboarding.start({ name: "J108 Intruder" })).tenantId, { userId: 1082 });

    // ── 1. Pure evaluateDraw bps math ─────────────────────────────────────
    // Within caps: buyer 4M + draw 1M = 5M ≤ 10M exposure; book 4M+1M=5M ≤ 50M;
    // concentration 5M/5M = 10000bps ≤ 10000 → allowed.
    const okPure = mfr.evaluateDraw({
      programStatus: "active", maxExposureCents: 10_000_000, programCapCents: 50_000_000,
      concentrationCapBps: 10_000, buyerOutstandingCents: 4_000_000, bookOutstandingCents: 4_000_000,
      amountCents: 1_000_000,
    });
    assert(okPure.allowed === true && okPure.reasons.length === 0, "pure draw within caps allowed");

    // Concentration cap: book 10M, buyer draws 6M → 6/16 = 3750bps > 3000 cap.
    // Cross-multiplied: 6_000_000·10000 = 6e10 > 3000·16_000_000 = 4.8e10 → violated.
    const concPure = mfr.evaluateDraw({
      programStatus: "active", maxExposureCents: 100_000_000, programCapCents: 100_000_000,
      concentrationCapBps: 3_000, buyerOutstandingCents: 0, bookOutstandingCents: 10_000_000,
      amountCents: 6_000_000,
    });
    assert(concPure.allowed === false, "concentration over-cap rejected");
    assert(concPure.reasons.some((r) => r.includes("concentration cap") && r.includes("3750bps")), `concentration reason carries exact bps (got ${concPure.reasons})`);

    // Exposure + cap + inactive program: three independent reasons.
    const allBad = mfr.evaluateDraw({
      programStatus: "draft", maxExposureCents: 1_000_000, programCapCents: 2_000_000,
      concentrationCapBps: 10_000, buyerOutstandingCents: 900_000, bookOutstandingCents: 1_500_000,
      amountCents: 700_000,
    });
    assert(allBad.reasons.length === 3, `all three violations reported (got ${allBad.reasons.length})`);
    // Zero/negative draws never pass.
    assert(mfr.evaluateDraw({ ...okPureInput(okPure), amountCents: 0 }).allowed === false, "zero draw rejected");

    // ── 2. End-to-end via the real router ─────────────────────────────────
    const program = await mfrCaller.manufacturerPrograms.create({
      tenantId: mfrT, name: "J108 Program",
      maxExposureCents: 10_000_000, programCapCents: 15_000_000,
      concentrationCapBps: 8_000, allowedTenorDays: [30], feeBps: 200,
    });
    assert(program.status === "draft", "program starts draft");
    await mfrCaller.manufacturerPrograms.setStatus({ tenantId: mfrT, programId: program.id, status: "active" });

    // Two buyer accounts, assigned into the book.
    const accountIds: Record<string, string> = {};
    for (const [key, tenant] of [["a", buyA], ["b", buyB]] as const) {
      const buyerCaller = await tenantCaller(tenant, { userId: key === "a" ? 1081 : 1083 });
      const req = await buyerCaller.tradeCredit.requestAccount({
        buyerTenantId: tenant, supplierTenantId: mfrT, note: `J108 ${key}`,
      });
      const id = (req as any).id;
      await world.db.update(schema.creditAccounts)
        .set({ limitCents: 10_000_000, termsDays: 30, status: "active" })
        .where(eq(schema.creditAccounts.id, id));
      await mfrCaller.manufacturerPrograms.assignAccount({ tenantId: mfrT, programId: program.id, accountId: id });
      accountIds[key] = id;
    }

    // Post real draws on the ledger: A 6M (60% of book).
    await world.db.insert(schema.creditLedger).values({
      creditAccountId: accountIds.a, kind: "invoice_draw", amountCents: 6_000_000,
      poId: "po-j108-a1", ref: "draw:po-j108-a1", dueDate: new Date(Date.now() + 30 * DAY_MS),
    });
    await world.db.update(schema.creditAccounts).set({ outstandingCents: 6_000_000 }).where(eq(schema.creditAccounts.id, accountIds.a));

    // A inside every cap: 6M + 2M = 8M ≤ 10M exposure; book 8M ≤ 15M;
    // concentration 8/8 = 10000bps > 8000 → REJECTED by concentration.
    const concReject = await mfrCaller.manufacturerPrograms.checkDrawAllowed({
      tenantId: mfrT, programId: program.id, buyerTenantId: buyA, amountCents: 2_000_000,
    });
    assert(concReject.allowed === false && concReject.reasons.some((r) => r.includes("concentration cap")), "over-concentration draw rejected");

    // A small draw that keeps concentration ≤ 8000bps: book 6M+1M=7M, A 7M →
    // 10000bps still — instead B draws: book 6M+3M=9M, B 3M → 3333bps ≤ 8000 ✓.
    const bOk = await mfrCaller.manufacturerPrograms.checkDrawAllowed({
      tenantId: mfrT, programId: program.id, buyerTenantId: buyB, amountCents: 3_000_000,
    });
    assert(bOk.allowed === true, `B draw within caps allowed (got ${JSON.stringify(bOk)})`);
    await world.db.insert(schema.creditLedger).values({
      creditAccountId: accountIds.b, kind: "invoice_draw", amountCents: 3_000_000,
      poId: "po-j108-b1", ref: "draw:po-j108-b1", dueDate: new Date(Date.now() + 30 * DAY_MS),
    });
    await world.db.update(schema.creditAccounts).set({ outstandingCents: 3_000_000 }).where(eq(schema.creditAccounts.id, accountIds.b));

    // Per-buyer exposure over-cap: A 6M + 5M = 11M > 10M → rejected.
    const expReject = await mfrCaller.manufacturerPrograms.checkDrawAllowed({
      tenantId: mfrT, programId: program.id, buyerTenantId: buyA, amountCents: 5_000_000,
    });
    assert(expReject.allowed === false && expReject.reasons.some((r) => r.includes("per-buyer exposure")), "exposure over-cap rejected");

    // Program cap over-draw: book is 9M, cap 15M — B drawing 7M → 16M > 15M.
    const capReject = await mfrCaller.manufacturerPrograms.checkDrawAllowed({
      tenantId: mfrT, programId: program.id, buyerTenantId: buyB, amountCents: 7_000_000,
    });
    assert(capReject.allowed === false && capReject.reasons.some((r) => r.includes("program cap")), "program-cap over-draw rejected");

    // Suspended program rejects everything.
    await mfrCaller.manufacturerPrograms.setStatus({ tenantId: mfrT, programId: program.id, status: "suspended" });
    const susp = await mfrCaller.manufacturerPrograms.checkDrawAllowed({
      tenantId: mfrT, programId: program.id, buyerTenantId: buyB, amountCents: 100_000,
    });
    assert(susp.allowed === false && susp.reasons.some((r) => r.includes("suspended")), "suspended program rejects draws");
    await mfrCaller.manufacturerPrograms.setStatus({ tenantId: mfrT, programId: program.id, status: "active" });

    // ── 3. Program tape CSV ───────────────────────────────────────────────
    const tapeJson = await mfrCaller.manufacturerPrograms.programTape({ tenantId: mfrT, programId: program.id, format: "json" });
    assert(tapeJson.format === "json" && tapeJson.summary.utilizationBps === 6000, `utilization 9M/15M = 6000bps (got ${tapeJson.summary.utilizationBps})`);
    assert(tapeJson.summary.remainingCapacityCents === 6_000_000, "remaining capacity = cap − book");
    assert(tapeJson.summary.topConcentration[0]?.buyerTenantId === buyA && tapeJson.summary.topConcentration[0]?.shareBps === 6667, "top concentration = A at 6667bps");

    const tapeCsv = await mfrCaller.manufacturerPrograms.programTape({ tenantId: mfrT, programId: program.id, format: "csv" });
    assert(tapeCsv.format === "csv" && tapeCsv.contentType === "text/csv", "csv format returned");
    const lines = tapeCsv.content.trim().split("\n");
    assert(lines.length === 3, `CSV header + 2 account rows (got ${lines.length})`);
    const header = lines[0].split(",");
    assert(header.some((h) => /outstanding/i.test(h)), "csv header carries outstanding column");
    assert(lines.some((l) => l.includes(accountIds.a) && l.includes("6000000")), "csv row for A with 6M outstanding");
    assert(lines.some((l) => l.includes(accountIds.b) && l.includes("3000000")), "csv row for B with 3M outstanding");

    // ── 4. Tenant guards ──────────────────────────────────────────────────
    await expectTrpcError(
      intruder.manufacturerPrograms.programTape({ tenantId: mfrT, programId: program.id }),
      "FORBIDDEN", "cross-tenant tape rejected",
    );
    await expectTrpcError(
      intruder.manufacturerPrograms.checkDrawAllowed({ tenantId: mfrT, programId: program.id, buyerTenantId: buyA, amountCents: 1 }),
      "FORBIDDEN", "cross-tenant draw check rejected",
    );

    function okPureInput(_r: unknown) {
      return {
        programStatus: "active" as const, maxExposureCents: 10_000_000, programCapCents: 50_000_000,
        concentrationCapBps: 10_000, buyerOutstandingCents: 4_000_000, bookOutstandingCents: 4_000_000,
      };
    }
  },
};
