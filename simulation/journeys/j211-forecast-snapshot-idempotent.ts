/**
 * === W33 ai-qa-forecast (Coder B) ===
 * J211 — forecast snapshots: the weekly cron stores the 30-day projection
 * into cashflow_forecasts (migration 0113) idempotently per
 * (tenant, horizon, day) — a replayed sweep is a no-op — and the dashboard
 * procedure returns the honest "No data yet" empty state for a tenant with
 * no forecast-relevant rows.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-w33-211";
const EMPTY_TID = "sim-w33-211-empty";
const D = 86_400_000;

async function seedTenant(world: World, id: string, name: string, balanceCents: number, uid: number) {
  const schema = await import("../../drizzle/schema");
  const now = new Date();
  await world.db.insert(schema.tenants).values({
    id, name, slug: id, status: "active", createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  const [u] = await world.db.insert(schema.users).values({
    openId: `sim-${id}-owner`, name: `${name} Owner`, tenantId: id, lastSignedIn: now,
  }).onConflictDoNothing().returning({ id: schema.users.id });
  const userId = u?.id ?? uid;
  await world.db.insert(schema.tenantMemberships).values({ tenantId: id, userId: String(userId), role: "owner" }).onConflictDoNothing();
  await world.db.insert(schema.merchantWallets).values({
    id: crypto.randomUUID(), tenantId: id, currency: "NGN",
    availableBalance: fmtMajor(balanceCents), escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
    custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  return userId;
}

export const journey: Journey = {
  id: "J211",
  name: "forecast snapshot stored idempotently + dashboard empty state",
  feature: "W33 cashflow_forecasts: (tenant,horizon,day) idempotency, honest empty state",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    const uid = await seedTenant(world, TID, "J211 Snapshot", 2_000_000, 211001);
    const emptyUid = await seedTenant(world, EMPTY_TID, "J211 Empty", 0, 211002);

    // One real outflow so TID has data.
    await world.db.insert(schema.vendorBills).values({
      tenantId: TID, vendorName: "J211 Packaging Co", amountCents: 500_000,
      paidCents: 0, currency: "NGN", status: "pending", dueDate: new Date(Date.now() + 10 * D),
      captureSource: "manual", createdAt: now, updatedAt: now,
    });

    // Sweep 1: stores a snapshot for TID (and skips the empty tenant).
    const cron1 = await world.runCron("/api/scheduled/cashflow-forecast");
    assert(cron1.status === 200 && cron1.json?.ok === true, `cron ok (${JSON.stringify(cron1.json)})`);
    const rows1 = await world.db.select().from(schema.cashflowForecasts)
      .where(and(eq(schema.cashflowForecasts.tenantId, TID), eq(schema.cashflowForecasts.horizonDays, 30)));
    assert(rows1.length === 1, `exactly one snapshot after first sweep (got ${rows1.length})`);
    assert(cron1.json.stored >= 1, `sweep stored >= 1 (${JSON.stringify(cron1.json)})`);
    // Snapshot totals match the real seeded rows.
    assert(rows1[0].outflowCents === 500_000, `snapshot outflow 500,000 (got ${rows1[0].outflowCents})`);
    assert(rows1[0].netCents === rows1[0].inflowCents - rows1[0].outflowCents, "snapshot net conserves");
    const detail = rows1[0].detail as any;
    assert(Array.isArray(detail?.lines) && detail.lines.length === 1, "detail carries the per-line sources");
    assert(detail.lines[0].kind === "vendor_bill", "detail line names its source");
    // The empty tenant got NO fabricated zero-row.
    const emptyRows = await world.db.select().from(schema.cashflowForecasts)
      .where(eq(schema.cashflowForecasts.tenantId, EMPTY_TID));
    assert(emptyRows.length === 0, "no fabricated snapshot for the empty tenant");

    // Sweep 2 (same day): idempotent — stored stays 0 for TID, row count unchanged.
    const cron2 = await world.runCron("/api/scheduled/cashflow-forecast");
    assert(cron2.status === 200 && cron2.json?.ok === true, "replayed cron ok");
    const rows2 = await world.db.select().from(schema.cashflowForecasts)
      .where(and(eq(schema.cashflowForecasts.tenantId, TID), eq(schema.cashflowForecasts.horizonDays, 30)));
    assert(rows2.length === 1, `replay stored no duplicate (got ${rows2.length})`);
    assert(rows2[0].id === rows1[0].id, "same snapshot row retained");
    assert((cron2.json.stored ?? 0) === 0, `replay stored 0 (${JSON.stringify(cron2.json)})`);

    // Dashboard snapshots procedure returns the stored row.
    const caller = await tenantCaller(TID, { userId: uid });
    const snaps = await caller.cashflow.snapshots({ tenantId: TID });
    assert(snaps.length === 1 && snaps[0].outflowCents === 500_000, "snapshots procedure reads the stored row");

    // Dashboard empty state for the tenant with no data.
    const emptyCaller = await tenantCaller(EMPTY_TID, { userId: emptyUid });
    const empty = await emptyCaller.cashflow.forecast({ tenantId: EMPTY_TID, horizonDays: 30 });
    assert(empty.empty === true && empty.message === "No data yet",
      `honest empty state (${JSON.stringify(empty)})`);
  },
};
// === END W33 ai-qa-forecast ===
