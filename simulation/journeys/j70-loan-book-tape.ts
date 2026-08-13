/**
 * J70 — Loan-book tape (W14 F4). A seeded portfolio spanning every DPD
 * bucket produces a correct lender tape:
 *   - JSON rows: per-account limit/outstanding/score/dpd/bucket/consent/
 *     mandate/facilityRef, sorted worst-delinquency-first;
 *   - summary: account count, total outstanding, outstanding-weighted score,
 *     90+ NPL ratio;
 *   - CSV rendering: header + one line per row;
 *   - asOf historical view re-buckets against the requested date;
 *   - facility-scoped tapes include only assigned accounts; the book-wide
 *     tape includes unassigned accounts (and the W8 seed account).
 */
import { randomUUID } from "crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";
import { TENANT_ID } from "../world";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J70",
  name: "loan-book tape",
  feature: "generateLoanBookTape JSON/CSV, DPD buckets, asOf",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const { TAPE_CSV_HEADER } = await import("../../server/services/creditFacilities/tape");

    // ── Seed a five-account portfolio across every bucket ────────────────
    // dpd derives from the oldest still-posted draw's due_date.
    const sup = (await admin.onboarding.start({ name: "J70 Supplier" })).tenantId;
    const mk = async (tag: string, opts: { outstanding: number; score: number | null; dpdDays: number; consent?: boolean }) => {
      const buy = (await admin.onboarding.start({ name: `J70 Buyer ${tag}` })).tenantId;
      const accountId = randomUUID();
      await world.db.insert(schema.creditAccounts).values({
        id: accountId,
        supplierTenantId: sup,
        buyerTenantId: buy,
        limitCents: 10_000_000,
        outstandingCents: opts.outstanding,
        termsDays: 14,
        status: "active",
        score: opts.score,
        ...(opts.consent ? { bureauConsentAt: new Date(), bureauConsentRef: `bcr:${accountId}` } : {}),
      });
      const due = new Date(Date.now() - opts.dpdDays * DAY_MS);
      await world.db.insert(schema.creditLedger).values({
        creditAccountId: accountId,
        kind: "invoice_draw",
        amountCents: opts.outstanding,
        poId: `po-j70-${tag}`,
        dueDate: due,
        ref: `draw:po-j70-${tag}`,
      });
      return { accountId, buy, ...opts };
    };
    const aCurrent = await mk("cur", { outstanding: 1_000_000, score: 700, dpdDays: -10 }); // due in the future
    const a130 = await mk("b130", { outstanding: 2_000_000, score: 620, dpdDays: 15, consent: true });
    const a3160 = await mk("b3160", { outstanding: 3_000_000, score: 540, dpdDays: 45 });
    const a6190 = await mk("b6190", { outstanding: 4_000_000, score: null, dpdDays: 75 });
    const a90 = await mk("b90", { outstanding: 5_000_000, score: 300, dpdDays: 100 });

    // ── Facility with four of the five accounts assigned ─────────────────
    const facility = await admin.creditFacilities.createFacility({
      lenderName: "J70 Lender",
      facilityRef: "W14-J70-FAC",
      commitmentCents: 100_000_000,
      advanceRateBps: 8000,
    });
    for (const a of [aCurrent, a130, a3160, a90]) {
      await admin.creditFacilities.assignAccount({ accountId: a.accountId, facilityId: facility.id });
    }

    // ── Facility-scoped tape (JSON) ──────────────────────────────────────
    const tape = await admin.creditFacilities.generateTape({ facilityId: facility.id, format: "json" });
    assert(tape.format === "json" && tape.facilityRef === "W14-J70-FAC", "tape keyed by facility ref");
    assert(tape.rows.length === 4, "facility tape includes only the four assigned accounts");
    const byBucket = new Map(tape.rows.map((r: any) => [r.accountId, r.bucket]));
    assert(byBucket.get(aCurrent.accountId) === "current", "future-due draw → current");
    assert(byBucket.get(a130.accountId) === "1-30", `15d → 1-30 (got ${byBucket.get(a130.accountId)})`);
    assert(byBucket.get(a3160.accountId) === "31-60", "45d → 31-60");
    assert(byBucket.get(a90.accountId) === "90+", "100d → 90+");
    // Worst delinquency first.
    assert(tape.rows[0].accountId === a90.accountId, "tape sorted worst-first");
    const row130 = tape.rows.find((r: any) => r.accountId === a130.accountId) as any;
    assert(row130.bureauConsent === true, "consent flag on the tape row");
    assert(row130.mandateStatus === "none", "no mandate → 'none'");
    assert(row130.facilityRef === "W14-J70-FAC", "row carries the facility ref");
    const rowCur = tape.rows.find((r: any) => r.accountId === aCurrent.accountId) as any;
    assert(rowCur.bureauConsent === false, "consentless account flagged false");

    // Summary: outstanding 1+2+3+5 = 11_000_000; weighted score over scored
    // accounts = (700×1M + 620×2M + 540×3M + 300×5M) / 11M = 5060/11 ≈ 460.
    assert(tape.summary.accountCount === 4, "summary account count");
    assert(tape.summary.totalOutstandingCents === 11_000_000, `summary total outstanding (got ${tape.summary.totalOutstandingCents})`);
    const expectedWeighted = Math.round(((700 * 1_000_000 + 620 * 2_000_000 + 540 * 3_000_000 + 300 * 5_000_000) / 11_000_000) * 100) / 100;
    assert(tape.summary.weightedScore === expectedWeighted, `weighted score ${tape.summary.weightedScore} === ${expectedWeighted}`);
    assert(Math.abs(tape.summary.nplRatio - 5_000_000 / 11_000_000) < 1e-9, "NPL ratio = 90+ share");

    // ── CSV rendering ────────────────────────────────────────────────────
    const csv = await admin.creditFacilities.generateTape({ facilityId: facility.id, format: "csv" });
    assert(csv.format === "csv" && csv.contentType === "text/csv", "csv envelope");
    const lines = csv.content.trimEnd().split("\n");
    assert(lines[0] === TAPE_CSV_HEADER, "csv header");
    assert(lines.length === 5, "header + four rows");
    assert(lines.some((l: string) => l.includes(",90+,") && l.includes(a90.accountId)), "csv carries the 90+ row");
    assert(csv.filename.endsWith(".csv"), "csv filename");

    // ── asOf historical view: 80 days ago every draw is younger ──────────
    const asOf = new Date(Date.now() - 80 * DAY_MS);
    const historical = await admin.creditFacilities.generateTape({ facilityId: facility.id, format: "json", asOf });
    const histByBucket = new Map(historical.rows.map((r: any) => [r.accountId, r.bucket]));
    assert(histByBucket.get(a90.accountId) === "1-30", `100d draw is 20d old at asOf-80d → 1-30 (got ${histByBucket.get(a90.accountId)})`);
    assert(histByBucket.get(a3160.accountId) === "current", "45d draw is not yet due at asOf-80d → current");
    assert(historical.asOf === asOf.toISOString(), "asOf echoed in the tape");

    // ── Book-wide tape: includes the unassigned account + W8 seed ────────
    const book = await admin.creditFacilities.generateTape({ format: "json" });
    const ids = book.rows.map((r: any) => r.accountId);
    assert(ids.includes(a6190.accountId), "book-wide tape includes the unassigned 61-90 account");
    assert(ids.length === 6, `book-wide = 5 seeded + W8 seed account (got ${ids.length})`);
    const unassigned = book.rows.find((r: any) => r.accountId === a6190.accountId) as any;
    assert(unassigned.bucket === "61-90", "75d → 61-90");
    assert(unassigned.facilityRef === null, "unassigned account has null facilityRef");
    assert(book.facilityRef === null, "book-wide tape has null facilityRef");
    const seedRow = book.rows.find((r: any) => r.buyerTenantId === TENANT_ID) as any;
    assert(seedRow && seedRow.bucket === "current" && seedRow.outstandingCents === 0, "W8 seed account current/zero");
    assert(book.summary.totalOutstandingCents === 15_000_000, `book-wide total (got ${book.summary.totalOutstandingCents})`);
  },
};
