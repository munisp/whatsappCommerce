/**
 * W33 ai-qa-forecast (Coder B) — migration 0113 shape + journal/snapshot
 * consistency (hand-maintained per the 0051–0110 pattern; drizzle-kit
 * generate is unavailable offline) + pure projection/shortfall math.
 * DB-backed conservation is covered by journeys J210/J211.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectOccurrences, summarizeLines, type ForecastLine } from "./cashflowForecast";

const DRIZZLE = join(__dirname, "../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0113_cashflow_forecasts.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0113_cashflow_forecasts_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0112_annual_statements_snapshot.json"), "utf8")); // W33 merger: re-chained 111→112→113→114 cumulative
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0113_cashflow_forecasts.sql", () => {
  it("creates cashflow_forecasts additively and idempotently", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "cashflow_forecasts"');
    expect(sql).toContain('"inflow_cents" bigint NOT NULL');
    expect(sql).toContain('"outflow_cents" bigint NOT NULL');
    expect(sql).toContain('"net_cents" bigint NOT NULL');
    expect(sql).toContain('"shortfall_at" date');
    expect(sql).toContain('"detail" jsonb');
    expect(sql).not.toMatch(/DROP/i);
  });

  it("has the (tenant, horizon, day) unique expression index for idempotent snapshots", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_forecasts_tenant_horizon_day_uniq"');
    expect(sql).toContain(`(("generated_at" AT TIME ZONE 'UTC')::date)`);
  });

  it("is registered as journal idx 113 chaining from the 0112 snapshot (merged chain)", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0113_cashflow_forecasts");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(113);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot is cumulative (all 0112 tables + cashflow_forecasts) and matches schema.ts", () => {
    expect(Object.keys(snapshot.tables).length).toBe(Object.keys(prevSnapshot.tables).length + 1);
    const t = snapshot.tables["public.cashflow_forecasts"];
    expect(t).toBeDefined();
    expect(t.columns.horizon_days).toMatchObject({ type: "integer", notNull: true });
    expect(t.columns.net_cents).toMatchObject({ type: "bigint", notNull: true });
    expect(t.indexes.cashflow_forecasts_tenant_horizon_day_uniq.isUnique).toBe(true);
    expect(schemaTs).toContain("=== W33 ai-qa-forecast (Coder B) ===");
    expect(schemaTs).toContain('export const cashflowForecasts = pgTable("cashflow_forecasts"');
  });
});

describe("projectOccurrences (weekly/monthly, clamped, deterministic)", () => {
  const from = new Date("2026-02-01T00:00:00Z");
  const until = new Date("2026-03-03T00:00:00Z"); // 30-day horizon

  it("weekly rule projects one occurrence per 7 days from next_run_at", () => {
    const occ = projectOccurrences(
      { id: "r1", amountCents: 100_00, cadence: "weekly", dayOfMonth: null, nextRunAt: new Date("2026-02-03T00:00:00Z") },
      from, until,
    );
    expect(occ.map((o) => o.date.toISOString().slice(0, 10))).toEqual([
      "2026-02-03", "2026-02-10", "2026-02-17", "2026-02-24", "2026-03-03",
    ]);
    expect(occ.every((o) => o.amountCents === 100_00)).toBe(true);
  });

  it("monthly rule clamps day_of_month to the month's last day", () => {
    const occ = projectOccurrences(
      { id: "r2", amountCents: 50_00, cadence: "monthly", dayOfMonth: 31, nextRunAt: new Date("2026-01-31T00:00:00Z") },
      from, new Date("2026-04-30T00:00:00Z"),
    );
    const days = occ.map((o) => o.date.toISOString().slice(0, 10));
    expect(days).toContain("2026-02-28"); // Feb has no 31st — clamped
    expect(days).toContain("2026-03-31");
  });

  it("past next_run_at advances into the window (one occurrence per period, no duplicates)", () => {
    const occ = projectOccurrences(
      { id: "r3", amountCents: 10_00, cadence: "weekly", dayOfMonth: null, nextRunAt: new Date("2026-01-05T00:00:00Z") },
      from, until,
    );
    expect(occ[0].date >= from).toBe(true);
    const unique = new Set(occ.map((o) => o.date.getTime()));
    expect(unique.size).toBe(occ.length);
  });
});

describe("summarizeLines — conservation + shortfall", () => {
  const L = (direction: "inflow" | "outflow", date: string, amountCents: number): ForecastLine =>
    ({ kind: "vendor_bill", direction, date, amountCents, sourceId: "x" });

  it("totals conserve: sum(lines) == inflow/outflow, net == inflow - outflow", () => {
    const lines = [L("inflow", "2026-02-05", 100_00), L("inflow", "2026-02-06", 50_00), L("outflow", "2026-02-07", 120_00)];
    const s = summarizeLines(lines, 0, "2026-02-01");
    expect(s.inflowCents).toBe(150_00);
    expect(s.outflowCents).toBe(120_00);
    expect(s.netCents).toBe(30_00);
  });

  it("detects shortfall on the first day cumulative balance goes negative", () => {
    const lines = [
      L("outflow", "2026-02-05", 100_00), // 50k balance → -50k on 02-05
      L("inflow", "2026-02-06", 200_00),  // recovers after — still shortfall on 02-05
    ];
    const s = summarizeLines(lines, 50_00, "2026-02-01");
    expect(s.shortfallAt).toBe("2026-02-05");
  });

  it("no shortfall when inflows + balance cover outflows", () => {
    const lines = [L("inflow", "2026-02-04", 100_00), L("outflow", "2026-02-05", 120_00)];
    const s = summarizeLines(lines, 50_00, "2026-02-01");
    expect(s.shortfallAt).toBeNull();
  });

  it("negative starting balance shortfalls today", () => {
    const s = summarizeLines([], -1, "2026-02-01");
    expect(s.shortfallAt).toBe("2026-02-01");
  });

  it("empty lines → zero totals, empty state upstream", () => {
    const s = summarizeLines([], 0, "2026-02-01");
    expect(s).toMatchObject({ inflowCents: 0, outflowCents: 0, netCents: 0, shortfallAt: null });
  });
});
