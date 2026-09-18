/**
 * === W38 money-integrity (Coder A) ===
 * J254 — PAY-9 scheduled-payment double-debit guard: executing a scheduled
 * vendor-bill payment whose bill is ALREADY paid skips honestly
 * ("skipped_already_paid") with ZERO wallet movement; a still-pending bill
 * executes exactly once and the bill flips to paid IN THE SAME COMMIT as
 * the debit.
 */
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-sched-254";
const BALANCE_CENTS = 1_000_000;
const PAY_CENTS = 250_000;

async function seed(world: World) {
  const schema = await import("../../drizzle/schema");
  const now = new Date();
  await world.db.insert(schema.tenants).values({
    id: TID, name: "J254 Scheduled", slug: TID, status: "active", createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  const [u] = await world.db.insert(schema.users).values({
    openId: `sim-${TID}-owner`, name: "Sched Owner", tenantId: TID, lastSignedIn: now,
  }).onConflictDoNothing().returning({ id: schema.users.id });
  const uid = u?.id ?? 254001;
  await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
  await world.db.insert(schema.merchantWallets).values({
    id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
    availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00",
    totalEarned: "0.00", totalWithdrawn: "0.00",
    custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  return uid;
}

async function balanceCents(world: World): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
  return Math.round(parseFloat(w.availableBalance) * 100);
}

export const journey: Journey = {
  id: "J254",
  name: "PAY-9: scheduled payment skips already-paid bill (no double debit)",
  feature: "W38 scheduledPayments in-tx bill-state guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const uid = await seed(world);
    const caller = await tenantCaller(TID, { userId: uid });

    // ── Bill A: ALREADY PAID (e.g. paid manually) — must never debit ─────
    const billPaid = crypto.randomUUID();
    await world.db.insert(schema.vendorBills).values({
      id: billPaid, tenantId: TID, vendorName: "J254 Vendor A",
      amountCents: PAY_CENTS, currency: "NGN", status: "paid", paidCents: PAY_CENTS, paymentRef: "manual:cash",
    });
    const s1 = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "vendor_bill", targetId: billPaid,
      amountCents: PAY_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), idempotencyKey: "j254-paid-bill",
    });

    // ── Bill B: still pending — executes once, bill paid in the same commit
    const billOpen = crypto.randomUUID();
    await world.db.insert(schema.vendorBills).values({
      id: billOpen, tenantId: TID, vendorName: "J254 Vendor B",
      amountCents: PAY_CENTS, currency: "NGN", status: "pending",
    });
    const s2 = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "vendor_bill", targetId: billOpen,
      amountCents: PAY_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), idempotencyKey: "j254-open-bill",
    });

    const tick = await world.runCron("/api/scheduled/execute-payments");
    assert(tick.status === 200, `cron accepted (got ${tick.status})`);

    const [row1] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, s1.id));
    assert(row1.status === "skipped_already_paid", `paid-bill payment skipped honestly (got ${row1.status})`);
    const ledger1 = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `sched:${s1.id}`)));
    assert(ledger1.length === 0, "ZERO wallet movement for the already-paid bill");

    const [row2] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, s2.id));
    assert(row2.status === "executed", `open-bill payment executed (got ${row2.status})`);
    const [bill] = await world.db.select().from(schema.vendorBills).where(eq(schema.vendorBills.id, billOpen));
    assert(bill.status === "paid", "bill marked paid in the same commit as the debit");
    assert(bill.paidCents === PAY_CENTS, `paid_cents matches the payment (got ${bill.paidCents})`);
    assert(bill.paymentRef === `sched:${s2.id}`, "bill payment_ref points at the scheduled payment");

    assert(await balanceCents(world) === BALANCE_CENTS - PAY_CENTS, "wallet debited EXACTLY ONCE (only the open bill)");

    // Replay: nothing else moves.
    await world.runCron("/api/scheduled/execute-payments");
    assert(await balanceCents(world) === BALANCE_CENTS - PAY_CENTS, "replay moved nothing");
  },
};
