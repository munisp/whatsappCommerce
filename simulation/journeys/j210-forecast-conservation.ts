/**
 * === W33 ai-qa-forecast (Coder B) ===
 * J210 — cash-flow forecast math conservation: per-line sums equal the
 * reported totals (no fabricated numbers), and a shortfall is detected on
 * exactly the day cumulative (balance + inflows - outflows) goes negative.
 * Sources: scheduled_payments, recurring_rules occurrences, installment
 * due dates, vendor_bills due dates — all real seeded rows.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-w33-210";
const D = 86_400_000;

export const journey: Journey = {
  id: "J210",
  name: "forecast conservation + shortfall detection on real seeded outflows",
  feature: "W33 cashflowForecast: sum(lines)==totals, shortfall day exact",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const t0 = Date.now();
    const now = new Date(t0);
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J210 Forecast", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({
      openId: `sim-${TID}-owner`, name: "Forecast Owner", tenantId: TID, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 210001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    // Starting balance ₦10,000.00 = 1,000,000 cents.
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(1_000_000), escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();

    // Outflow 1: scheduled payment 400,000 at +5d.
    await world.db.insert(schema.scheduledPayments).values({
      tenantId: TID, kind: "adhoc", amountCents: 400_000, currency: "NGN",
      executeAt: new Date(t0 + 5 * D), status: "pending",
      idempotencyKey: `j210-sched-1`, createdAt: now, updatedAt: now,
    });
    // Outflow 2: weekly recurring rule 100,000 starting +2d (5 occurrences ≤ +30d).
    await world.db.insert(schema.recurringRules).values({
      tenantId: TID, kind: "adhoc", amountCents: 100_000, currency: "NGN",
      cadence: "weekly", nextRunAt: new Date(t0 + 2 * D), status: "active",
      createdAt: now, updatedAt: now,
    });
    // Outflow 3: pay-over-time installment 300,000 due +10d.
    const [bill] = await world.db.insert(schema.vendorBills).values({
      tenantId: TID, vendorName: "J210 Financed Vendor", amountCents: 900_000,
      paidCents: 0, currency: "NGN", status: "paid", dueDate: new Date(t0 + 12 * D),
      captureSource: "manual", metadata: { financing: "pay_over_time" },
      createdAt: now, updatedAt: now,
    }).returning({ id: schema.vendorBills.id });
    await world.db.insert(schema.installmentPlans).values({
      tenantId: TID, vendorBillId: bill.id, principalCents: 900_000, installments: 3,
      feeBps: 250, perInstallmentCents: 300_000, currency: "NGN", status: "active",
      schedule: [
        { seq: 1, dueAt: new Date(t0 + 10 * D).toISOString(), amountCents: 300_000, status: "due" },
        { seq: 2, dueAt: new Date(t0 + 40 * D).toISOString(), amountCents: 300_000, status: "due" }, // beyond horizon
      ],
      createdAt: now, updatedAt: now,
    });
    // Outflow 4: open vendor bill 250,000 due +12d (the day balance breaks).
    await world.db.insert(schema.vendorBills).values({
      tenantId: TID, vendorName: "J210 Grain Supplier", amountCents: 250_000,
      paidCents: 0, currency: "NGN", status: "pending", dueDate: new Date(t0 + 12 * D),
      captureSource: "manual", createdAt: now, updatedAt: now,
    });
    const shortfallDay = new Date(t0 + 12 * D).toISOString().slice(0, 10);

    const caller = await tenantCaller(TID, { userId: uid });
    const f = await caller.cashflow.forecast({ tenantId: TID, horizonDays: 30 });
    assert(f.empty === false, "tenant with data is not empty-state");

    // Conservation: sum of detail lines == totals, net == inflow - outflow.
    const inSum = f.lines.filter((l: any) => l.direction === "inflow").reduce((s: number, l: any) => s + l.amountCents, 0);
    const outSum = f.lines.filter((l: any) => l.direction === "outflow").reduce((s: number, l: any) => s + l.amountCents, 0);
    assert(inSum === f.inflowCents, `inflow lines conserve (${inSum} == ${f.inflowCents})`);
    assert(outSum === f.outflowCents, `outflow lines conserve (${outSum} == ${f.outflowCents})`);
    assert(f.netCents === f.inflowCents - f.outflowCents, "net == inflow - outflow");

    // Exact source math: no inflows seeded (no open AR, no paid velocity) …
    assert(f.inflowCents === 0, `zero inflows without AR/velocity rows (got ${f.inflowCents})`);
    // … outflows: 400k + 5×100k + 300k + 250k = 1,450,000.
    assert(f.outflowCents === 1_450_000, `outflow total 1,450,000 (got ${f.outflowCents})`);
    const kinds = new Set(f.lines.map((l: any) => l.kind));
    for (const k of ["scheduled_payment", "recurring_rule", "installment_due", "vendor_bill"]) {
      assert(kinds.has(k as any), `line kind present: ${k}`);
    }
    assert(f.lines.filter((l: any) => l.kind === "recurring_rule").length === 5, "5 weekly occurrences in 30d");
    // The financed bill is NOT double-counted (repaid via installment lines).
    assert(!f.lines.some((l: any) => l.kind === "vendor_bill" && l.note?.includes("Financed")),
      "pay-over-time bill excluded from bill lines (counted via installments)");

    // Shortfall: 1,000,000 + 0 - cumulative outflow first goes negative at +12d.
    assert(f.shortfallAt === shortfallDay, `shortfall on ${shortfallDay} (got ${f.shortfallAt})`);
    assert(f.startingBalanceCents === 1_000_000, "starting balance from the real wallet row");
  },
};
// === END W33 ai-qa-forecast ===
