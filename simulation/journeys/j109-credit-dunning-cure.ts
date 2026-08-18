/**
 * J109 — S3: credit account goes late → dunning sequence ([dun:*] markers) →
 * score drops → default (freeze at +7d) → cure via repayment → score recovery
 * + terms improve.
 *
 * Uses the REAL services end-to-end: drawOnCredit (account backdated past the
 * tenure gate), runDunningCheck sweeps (late-fee + reminder markers claimed
 * atomically, idempotent re-sweep), applyRepayment (FIFO settle, outstanding
 * to zero), setCreditAccountStatusTx cure, and suggestLimitTx/termsForScore
 * for the score + terms trajectory.
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const journey: Journey = {
  id: "J109",
  name: "credit dunning → default → cure → recovery",
  feature: "[dun:*] marker sequence, score drop on default, repayment cure, score recovery + terms improve",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const tc = await import("../../server/services/tradeCredit");
    const { setCreditAccountStatusTx } = await import("../../server/services/tradeCredit/accounts");
    const admin = await adminCaller();
    const sup = (await admin.onboarding.start({ name: "J109 Supplier" })).tenantId;
    const buy = (await admin.onboarding.start({ name: "J109 Buyer" })).tenantId;
    const now = Date.now();

    // ── Buyer platform history (baseline score signal) ────────────────────
    for (const [k, daysAgo] of [[0, 150], [1, 10]] as const) {
      await world.db.insert(schema.orders).values({
        id: `j109-ord-${k}`, tenantId: buy, customerId: "j109-cust",
        orderNumber: `J109-${k}`, status: "delivered",
        totalAmount: "500000.00", currency: "NGN",
        createdAt: new Date(now - daysAgo * DAY_MS), updatedAt: new Date(now - daysAgo * DAY_MS),
      }).onConflictDoNothing();
    }
    const payCreated = new Date(now - 10 * DAY_MS);
    await world.db.insert(schema.paymentTransactions).values({
      id: "j109-pay-0", tenantId: buy, provider: "paystack", providerRef: "J109PAY-0",
      amount: "5000.00", currency: "NGN", status: "completed",
      createdAt: payCreated, paidAt: new Date(payCreated.getTime() + HOUR_MS),
    }).onConflictDoNothing();

    // ── Credit account (aged past the tenure gate) + baseline score ───────
    const accountId = crypto.randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId, supplierTenantId: sup, buyerTenantId: buy,
      limitCents: 100_000_000, outstandingCents: 0, termsDays: 14, status: "active",
      createdAt: new Date(now - 30 * DAY_MS),
    });
    const s0 = (await tc.suggestLimitTx(world.db, buy, sup)).score;
    const terms0 = tc.termsForScore(s0);
    assert(s0 > 10, `baseline score above cold start (got ${s0})`);

    // ── Draw via the real service (account aged → tenure gate passes) ─────
    const draw = await tc.drawOnCredit({
      supplierTenantId: sup, buyerTenantId: buy, amountCents: 20_000_000, poId: "po-j109-1", termsDays: 14,
    });
    assert(draw.ok === true, `draw succeeds (got ${JSON.stringify(draw)})`);
    const drawId = (draw as any).ledgerId as string;
    // Backdate the due date to 4 days ago → next sweep is the +3d milestone.
    const dueAt = new Date(now - 4 * DAY_MS);
    await world.backdate(`UPDATE credit_ledger SET due_date = $1 WHERE id = $2`, [dueAt, drawId]);

    // ── Sweep 1 (+4d): late fee + [dun:fee]/[dun:r+3] markers ─────────────
    const r1 = await tc.runDunningCheck(new Date(now));
    assert(r1.feesApplied >= 1, `late fee applied (got ${JSON.stringify(r1)})`);
    let [drawRow] = await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, drawId)).limit(1);
    assert(drawRow.note?.includes("[dun:fee]"), `fee marker claimed (note=${drawRow.note})`);
    assert(drawRow.note?.includes("[dun:r+3]"), `+3d reminder marker claimed`);
    const [acctAfterFee] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(acctAfterFee.outstandingCents === 20_400_000, `outstanding = draw + 2% fee (got ${acctAfterFee.outstandingCents})`);

    // Idempotent re-sweep: markers already claimed → no second fee.
    const r2 = await tc.runDunningCheck(new Date(now));
    const [acctAfterResweep] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(acctAfterResweep.outstandingCents === 20_400_000, "re-sweep applies no second fee");
    void r2;

    // Score drops once the draw carries late markers.
    const s1 = (await tc.suggestLimitTx(world.db, buy, sup)).score;
    assert(s1 < s0, `score drops after late markers (${s0} → ${s1})`);

    // ── Default: +7d sweep freezes the facility ([dun:r+7]) ───────────────
    const r3 = await tc.runDunningCheck(new Date(now + 4 * DAY_MS)); // offset +8d
    assert(r3.frozen >= 1, `facility frozen at +7d (got ${JSON.stringify(r3)})`);
    const [frozen] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(frozen.status === "frozen", "account frozen = default");
    [drawRow] = (await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, drawId)).limit(1)) as any;
    assert(drawRow.note?.includes("[dun:r+7]"), "+7d reminder marker claimed");

    // New draws refused while frozen.
    const refused = await tc.drawOnCredit({
      supplierTenantId: sup, buyerTenantId: buy, amountCents: 1_000_000, poId: "po-j109-2",
    });
    assert(refused.ok === false && (refused as any).reason === "frozen", "draw refused while frozen");

    const s2 = (await tc.suggestLimitTx(world.db, buy, sup)).score;
    const terms2 = tc.termsForScore(s2);
    assert(s2 < s1, `score drops further on default (${s1} → ${s2})`);

    // ── Cure: full repayment (draw + fee) settles FIFO, outstanding → 0 ───
    const repay = await tc.applyRepayment({ accountId, amountCents: 20_400_000, ref: "repay:j109-1" });
    assert(repay.ok === true && repay.outstandingAfter === 0, `cure repayment applied (got ${JSON.stringify(repay)})`);
    const repayReplay = await tc.applyRepayment({ accountId, amountCents: 20_400_000, ref: "repay:j109-1" });
    assert(repayReplay.alreadySettled === true || repayReplay.outstandingAfter === 0, "repayment replay is idempotent");
    [drawRow] = (await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, drawId)).limit(1)) as any;
    assert(drawRow.status === "settled", "draw settled by cure repayment");

    // Supplier cures the account back to active.
    const cured = await setCreditAccountStatusTx(world.db, { accountId, supplierTenantId: sup, status: "active" });
    assert(cured?.status === "active", "account cured to active");

    // ── Score recovery + terms improve vs default ─────────────────────────
    const s3 = (await tc.suggestLimitTx(world.db, buy, sup)).score;
    const terms3 = tc.termsForScore(s3);
    assert(s3 > s2, `score recovers after cure (${s2} → ${s3})`);
    assert(terms3.decline === false, "cured buyer back inside an approval band");
    assert(
      terms3.feeBps <= terms2.feeBps && terms3.tenorDays >= terms2.tenorDays,
      `terms improve vs default (fee ${terms2.feeBps}→${terms3.feeBps}bps, tenor ${terms2.tenorDays}→${terms3.tenorDays}d)`,
    );

    // Post-cure draws work again.
    const redraw = await tc.drawOnCredit({
      supplierTenantId: sup, buyerTenantId: buy, amountCents: 1_000_000, poId: "po-j109-3", termsDays: 14,
    });
    assert(redraw.ok === true, "post-cure draw succeeds");
    const [finalAcct] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1);
    assert(finalAcct.outstandingCents === 1_000_000, "outstanding reflects only the new draw");
  },
};
