/**
 * W18 — manufacturer credit programs unit tests.
 *
 * Pure-function coverage (evaluateDraw / buildProgramBook /
 * effectiveScoringConfig) plus db-facing functions driven by an in-memory
 * fake (same decode approach as services/creditFacilities/fakeDb.ts). These
 * tests fail when the implementation is reverted.
 */
import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import { creditLedger, paymentMandates } from "../../drizzle/schema";
import {
  DEFAULT_SCORING_WEIGHTS,
  assignAccountToProgram,
  buildProgramBook,
  checkDrawAllowed,
  createProgram,
  creditAccountsProgram,
  effectiveScoringConfig,
  evaluateDraw,
  generateProgramTape,
  getProgramBook,
  listPrograms,
  manufacturerCreditPrograms,
  ProgramAccountNotFoundError,
  ProgramNameExistsError,
  ProgramNotFoundError,
  setProgramStatus,
  suggestLimitForProgramTx,
  unassignAccountFromProgram,
  updateProgram,
  type ManufacturerCreditProgram,
} from "./manufacturerPrograms";

// ─── Fake db ────────────────────────────────────────────────────────────────

interface ProgramRow {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  maxExposureCents: number;
  programCapCents: number;
  concentrationCapBps: number;
  allowedTenorDays: number[];
  feeBps: number;
  scoringWeights: unknown;
  createdAt: Date;
  updatedAt: Date;
}
interface AccountRow {
  id: string;
  supplierTenantId: string;
  buyerTenantId: string;
  limitCents: number;
  outstandingCents: number;
  status: string;
  score: number | null;
  mandateId: string | null;
  bureauConsentAt: Date | null;
  programId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface LedgerDueRow {
  creditAccountId: string;
  kind: string;
  status: string;
  dueDate: Date | null;
}

function decode(v: unknown): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const walk = (c: unknown): void => {
    if (c == null) return;
    if (Array.isArray(c)) return c.forEach(walk);
    const t = typeof c;
    if (t === "string" || t === "number" || t === "boolean" || c instanceof Date) {
      values.push(c);
      return;
    }
    if (t !== "object") return;
    const o = c as Record<string, any>;
    if (o.constructor?.name === "StringChunk") return;
    if (o.constructor?.name === "Column" || (typeof o.name === "string" && o.table != null)) {
      columns.push(o.name);
      return;
    }
    if (Array.isArray(o.queryChunks)) return walk(o.queryChunks);
    if ("value" in o) values.push(o.value);
  };
  walk((v as { queryChunks?: unknown[] })?.queryChunks ?? v);
  return { columns, values };
}

function tableName(table: unknown): string {
  for (const [name, t] of Object.entries({
    manufacturer_credit_programs: manufacturerCreditPrograms,
    credit_accounts: creditAccountsProgram,
    credit_ledger: creditLedger,
    payment_mandates: paymentMandates,
  })) {
    if (t === table) return name;
  }
  throw new Error("manufacturerPrograms fakeDb: unknown table");
}

export function makeFakeDb(seed?: {
  programs?: ProgramRow[];
  accounts?: AccountRow[];
  ledger?: LedgerDueRow[];
  mandates?: { id: string; status: string }[];
}) {
  const store = {
    programs: (seed?.programs ?? []).map((r) => ({ ...r })),
    accounts: (seed?.accounts ?? []).map((r) => ({ ...r })),
    ledger: (seed?.ledger ?? []).map((r) => ({ ...r })),
    mandates: (seed?.mandates ?? []).map((r) => ({ ...r })),
  };
  const rowsOf = (t: string): any[] =>
    t === "manufacturer_credit_programs"
      ? store.programs
      : t === "credit_accounts"
        ? store.accounts
        : t === "credit_ledger"
          ? store.ledger
          : store.mandates;

  function runSelect(t: string, fields: Record<string, unknown> | undefined, cond: unknown): any[] {
    let rows = rowsOf(t);
    if (cond != null) {
      const { columns, values } = decode(cond);
      const sig = columns.join(",");
      if (t === "manufacturer_credit_programs") {
        if (sig === "id") rows = rows.filter((r) => r.id === values[0]);
        else if (sig === "tenant_id,name") rows = rows.filter((r) => r.tenantId === values[0] && r.name === values[1]);
        else if (sig === "tenant_id") rows = rows.filter((r) => r.tenantId === values[0]);
        else throw new Error(`fakeDb select programs: unhandled ${sig}`);
      } else if (t === "credit_accounts") {
        if (sig === "id") rows = rows.filter((r) => r.id === values[0]);
        else if (sig === "program_id") rows = rows.filter((r) => r.programId === values[0]);
        else throw new Error(`fakeDb select credit_accounts: unhandled ${sig}`);
      } else if (t === "credit_ledger") {
        if (sig === "credit_account_id,kind,status") {
          const status = values[values.length - 1];
          const kind = values[values.length - 2];
          const ids = values.slice(0, -2) as string[];
          rows = rows.filter((r) => ids.includes(r.creditAccountId) && r.kind === kind && r.status === status);
        } else throw new Error(`fakeDb select credit_ledger: unhandled ${sig}`);
      } else if (t === "payment_mandates") {
        if (sig === "id") rows = rows.filter((r) => (values as string[]).includes(r.id));
        else throw new Error(`fakeDb select payment_mandates: unhandled ${sig}`);
      }
    }
    if (fields) {
      const keys = Object.keys(fields);
      rows = rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
    } else {
      rows = rows.map((r) => ({ ...r }));
    }
    return rows;
  }

  const db: any = {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const t = tableName(table);
          const chain: any = {
            where(cond: unknown) {
              const rows = runSelect(t, fields, cond);
              return {
                limit: async (n: number) => rows.slice(0, n),
                then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
              };
            },
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      const t = tableName(table);
      return {
        values(v: any) {
          return {
            returning: async () => {
              if (t !== "manufacturer_credit_programs") throw new Error(`fakeDb insert: unhandled ${t}`);
              const row: ProgramRow = {
                id: v.id ?? randomUUID(),
                tenantId: v.tenantId,
                name: v.name,
                status: v.status ?? "draft",
                maxExposureCents: v.maxExposureCents,
                programCapCents: v.programCapCents,
                concentrationCapBps: v.concentrationCapBps ?? 10000,
                allowedTenorDays: v.allowedTenorDays ?? [],
                feeBps: v.feeBps ?? 0,
                scoringWeights: v.scoringWeights ?? null,
                createdAt: v.createdAt ?? new Date(),
                updatedAt: v.updatedAt ?? new Date(),
              };
              store.programs.push(row);
              return [{ ...row }];
            },
          };
        },
      };
    },
    update(table: unknown) {
      const t = tableName(table);
      return {
        set(patch: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              const { columns, values } = decode(cond);
              const sig = columns.join(",");
              const matched: any[] = [];
              const match = (r: any): boolean => {
                if (t === "manufacturer_credit_programs" && sig === "id,tenant_id")
                  return r.id === values[0] && r.tenantId === values[1];
                if (t === "credit_accounts" && sig === "id") return r.id === values[0];
                throw new Error(`fakeDb update: unhandled ${t} ${sig}`);
              };
              for (const r of rowsOf(t)) {
                if (!match(r)) continue;
                for (const [k, v] of Object.entries(patch)) (r as any)[k] = v;
                matched.push({ ...r });
              }
              return {
                returning: async () => matched,
                then: (res: any, rej: any) => Promise.resolve(matched).then(res, rej),
              };
            },
          };
        },
      };
    },
  };
  return { db: db as any, store };
}

function programRow(partial: Partial<ProgramRow> & Pick<ProgramRow, "tenantId" | "name">): ProgramRow {
  return {
    id: randomUUID(),
    status: "active",
    maxExposureCents: 10_000_000,
    programCapCents: 100_000_000,
    concentrationCapBps: 6000,
    allowedTenorDays: [30, 60],
    feeBps: 150,
    scoringWeights: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}
function accountRow(partial: Partial<AccountRow> & Pick<AccountRow, "supplierTenantId" | "buyerTenantId">): AccountRow {
  return {
    id: randomUUID(),
    limitCents: 10_000_000,
    outstandingCents: 0,
    status: "active",
    score: null,
    mandateId: null,
    bureauConsentAt: null,
    programId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

// ─── effectiveScoringConfig ─────────────────────────────────────────────────

describe("effectiveScoringConfig", () => {
  it("returns platform defaults without a program or overrides", () => {
    expect(effectiveScoringConfig().weights).toEqual(DEFAULT_SCORING_WEIGHTS);
    expect(effectiveScoringConfig(null).overridden).toEqual([]);
    expect(effectiveScoringConfig({ scoringWeights: null }).overridden).toEqual([]);
  });
  it("merges valid overrides and reports them", () => {
    const cfg = effectiveScoringConfig({ scoringWeights: { onTime: 0.7 } });
    expect(cfg.weights).toEqual({ onTime: 0.7, volume: 0.3, tenure: 0.2 });
    expect(cfg.overridden).toEqual(["onTime"]);
  });
  it("ignores invalid entries and keeps the valid ones", () => {
    const cfg = effectiveScoringConfig({
      scoringWeights: { onTime: Number.NaN as any, volume: -0.2 as any, tenure: 0.4 },
    });
    expect(cfg.weights).toEqual({ onTime: 0.5, volume: 0.3, tenure: 0.4 });
    expect(cfg.overridden).toEqual(["tenure"]);
  });
});

// ─── evaluateDraw (pure) ────────────────────────────────────────────────────

describe("evaluateDraw", () => {
  const base = {
    programStatus: "active",
    maxExposureCents: 10_000_000,
    programCapCents: 100_000_000,
    concentrationCapBps: 6000,
    buyerOutstandingCents: 0,
    bookOutstandingCents: 5_000_000, // other buyers — keeps a lone draw under 6000bps
  };
  it("allows a draw inside every cap", () => {
    const r = evaluateDraw({ ...base, amountCents: 5_000_000 });
    expect(r).toEqual({ allowed: true, reasons: [] });
  });
  it("declines when the program is not active", () => {
    const r = evaluateDraw({ ...base, programStatus: "suspended", amountCents: 1 });
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]).toContain("suspended");
  });
  it("declines past per-buyer exposure with a reason naming the cap", () => {
    const r = evaluateDraw({ ...base, buyerOutstandingCents: 8_000_000, bookOutstandingCents: 8_000_000, amountCents: 3_000_000 });
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((s) => s.includes("per-buyer exposure"))).toBe(true);
  });
  it("declines past the program cap", () => {
    const r = evaluateDraw({ ...base, bookOutstandingCents: 99_000_000, amountCents: 2_000_000 });
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((s) => s.includes("program cap"))).toBe(true);
  });
  it("declines past the concentration cap (exact integer bps comparison)", () => {
    // Buyer would hold 11 of 21 → 5238bps > 5000bps cap.
    const r = evaluateDraw({
      ...base,
      concentrationCapBps: 5000,
      buyerOutstandingCents: 10_000_000,
      bookOutstandingCents: 20_000_000,
      amountCents: 1_000_000,
      maxExposureCents: 100_000_000,
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((s) => s.includes("concentration cap"))).toBe(true);
  });
  it("boundary: exactly at every cap is allowed", () => {
    const r = evaluateDraw({
      ...base,
      maxExposureCents: 5_000_000,
      programCapCents: 5_000_000,
      concentrationCapBps: 10_000,
      bookOutstandingCents: 0,
      amountCents: 5_000_000,
    });
    expect(r.allowed).toBe(true);
  });
  it("rejects non-positive amounts", () => {
    expect(evaluateDraw({ ...base, amountCents: 0 }).allowed).toBe(false);
    expect(evaluateDraw({ ...base, amountCents: -5 }).allowed).toBe(false);
  });
});

// ─── buildProgramBook (pure) ────────────────────────────────────────────────

describe("buildProgramBook", () => {
  it("aggregates utilization, remaining capacity, and concentration ranking", () => {
    const p = programRow({ tenantId: "mfr", name: "P", programCapCents: 40_000_000, id: "prog-1" }) as unknown as ManufacturerCreditProgram;
    const book = buildProgramBook(p, [
      { id: "a1", buyerTenantId: "b1", limitCents: 10_000_000, outstandingCents: 6_000_000, status: "active", score: 600 },
      { id: "a2", buyerTenantId: "b2", limitCents: 10_000_000, outstandingCents: 4_000_000, status: "active", score: null },
      { id: "a3", buyerTenantId: "b1", limitCents: 5_000_000, outstandingCents: 2_000_000, status: "active", score: 550 },
    ]);
    expect(book.accountCount).toBe(3);
    expect(book.totalOutstandingCents).toBe(12_000_000);
    expect(book.totalLimitCents).toBe(25_000_000);
    expect(book.utilizationBps).toBe(3000); // 12/40 = 30%
    expect(book.remainingCapacityCents).toBe(28_000_000);
    // b1: 8M → 6667bps, b2: 4M → 3333bps, largest first.
    expect(book.concentration.map((c) => c.buyerTenantId)).toEqual(["b1", "b2"]);
    expect(book.concentration[0]).toEqual({ buyerTenantId: "b1", outstandingCents: 8_000_000, shareBps: 6667 });
  });
  it("handles an empty book (zero division safe)", () => {
    const p = programRow({ tenantId: "mfr", name: "P", programCapCents: 0 }) as unknown as ManufacturerCreditProgram;
    const book = buildProgramBook(p, []);
    expect(book.utilizationBps).toBe(0);
    expect(book.concentration).toEqual([]);
    expect(book.remainingCapacityCents).toBe(0);
  });
});

// ─── db-facing CRUD + gating ────────────────────────────────────────────────

describe("manufacturerPrograms service (fake db)", () => {
  it("create/list/get lifecycle with tenant scoping", async () => {
    const { db } = makeFakeDb();
    const p = await createProgram(db, {
      tenantId: "mfr-1",
      name: "B2B Terms",
      maxExposureCents: 5_000_000,
      programCapCents: 50_000_000,
    });
    expect(p.status).toBe("draft");
    expect(p.concentrationCapBps).toBe(10000);
    await expect(
      createProgram(db, { tenantId: "mfr-1", name: "B2B Terms", maxExposureCents: 1, programCapCents: 1 }),
    ).rejects.toBeInstanceOf(ProgramNameExistsError);
    expect(await listPrograms(db, "mfr-1")).toHaveLength(1);
    expect(await listPrograms(db, "mfr-2")).toHaveLength(0);
    await expect(setProgramStatus(db, { programId: p.id, tenantId: "mfr-2", status: "active" })).rejects.toBeInstanceOf(
      ProgramNotFoundError,
    );
    const active = await setProgramStatus(db, { programId: p.id, tenantId: "mfr-1", status: "active" });
    expect(active.status).toBe("active");
  });

  it("update is claim-first and rejects duplicate renames", async () => {
    const { db } = makeFakeDb();
    const p1 = await createProgram(db, { tenantId: "m", name: "A", maxExposureCents: 1, programCapCents: 1 });
    await createProgram(db, { tenantId: "m", name: "B", maxExposureCents: 1, programCapCents: 1 });
    await expect(updateProgram(db, { programId: p1.id, tenantId: "m", name: "B" })).rejects.toBeInstanceOf(
      ProgramNameExistsError,
    );
    const updated = await updateProgram(db, { programId: p1.id, tenantId: "m", maxExposureCents: 9_000_000 });
    expect(updated.maxExposureCents).toBe(9_000_000);
    await expect(updateProgram(db, { programId: p1.id, tenantId: "other", name: "X" })).rejects.toBeInstanceOf(
      ProgramNotFoundError,
    );
  });

  it("assign/unassign enforces manufacturer ownership of the account", async () => {
    const { db } = makeFakeDb();
    const p = await createProgram(db, { tenantId: "mfr", name: "P", maxExposureCents: 1, programCapCents: 1 });
    const mine = accountRow({ supplierTenantId: "mfr", buyerTenantId: "buyer" });
    const foreign = accountRow({ supplierTenantId: "other-supplier", buyerTenantId: "buyer2" });
    const { db: db2 } = makeFakeDb({ accounts: [mine, foreign], programs: [] });
    void db2;
    // Seed via a store-backed db.
    const { db: db3, store } = makeFakeDb();
    store.programs.push(p as any);
    store.accounts.push(mine, foreign);
    const asg = await assignAccountToProgram(db3, { programId: p.id, tenantId: "mfr", accountId: mine.id });
    expect(asg.programId).toBe(p.id);
    expect(store.accounts.find((a) => a.id === mine.id)!.programId).toBe(p.id);
    await expect(
      assignAccountToProgram(db3, { programId: p.id, tenantId: "mfr", accountId: foreign.id }),
    ).rejects.toBeInstanceOf(ProgramAccountNotFoundError);
    const un = await unassignAccountFromProgram(db3, { programId: p.id, tenantId: "mfr", accountId: mine.id });
    expect(un.programId).toBeNull();
    void db;
  });

  it("checkDrawAllowed sums book and buyer outstanding from assigned accounts", async () => {
    const { db, store } = makeFakeDb();
    const p = programRow({ tenantId: "mfr", name: "P", maxExposureCents: 10_000_000, programCapCents: 20_000_000, concentrationCapBps: 10000 });
    store.programs.push(p);
    store.accounts.push(
      accountRow({ supplierTenantId: "mfr", buyerTenantId: "b1", programId: p.id, outstandingCents: 6_000_000 }),
      accountRow({ supplierTenantId: "mfr", buyerTenantId: "b2", programId: p.id, outstandingCents: 6_000_000 }),
    );
    const ok = await checkDrawAllowed(db, { programId: p.id, tenantId: "mfr", buyerTenantId: "b1", amountCents: 4_000_000 });
    expect(ok.allowed).toBe(true);
    const over = await checkDrawAllowed(db, { programId: p.id, tenantId: "mfr", buyerTenantId: "b1", amountCents: 4_000_001 });
    expect(over.allowed).toBe(false);
    expect(over.reasons.some((s) => s.includes("per-buyer exposure"))).toBe(true);
    const capOver = await checkDrawAllowed(db, { programId: p.id, tenantId: "mfr", buyerTenantId: "b2", amountCents: 9_000_000 });
    expect(capOver.allowed).toBe(false);
    await expect(
      checkDrawAllowed(db, { programId: p.id, tenantId: "intruder", buyerTenantId: "b1", amountCents: 1 }),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
  });

  it("suggestLimitForProgramTx post-adjusts by program caps", async () => {
    const { db, store } = makeFakeDb();
    const p = programRow({
      tenantId: "mfr",
      name: "P",
      maxExposureCents: 7_000_000,
      programCapCents: 12_000_000,
    });
    store.programs.push(p);
    store.accounts.push(
      accountRow({ supplierTenantId: "mfr", buyerTenantId: "b9", programId: p.id, outstandingCents: 6_000_000 }),
    );
    const scorer = async () => ({ score: 62, suggestedLimitCents: 50_000_000, reasons: ["platform"] });
    // remaining capacity 6M < maxExposure 7M < platform 50M → 6M.
    const s = await suggestLimitForProgramTx(db, { programId: p.id, tenantId: "mfr", buyerTenantId: "b1" }, scorer as any);
    expect(s.suggestedLimitCents).toBe(6_000_000);
    expect(s.baseSuggestedLimitCents).toBe(50_000_000);
    expect(s.reasons.some((r) => r.includes("capped by program"))).toBe(true);
    // Under the caps the platform suggestion flows through untouched.
    const low = await suggestLimitForProgramTx(
      db,
      { programId: p.id, tenantId: "mfr", buyerTenantId: "b1" },
      (async () => ({ score: 40, suggestedLimitCents: 3_000_000, reasons: [] })) as any,
    );
    expect(low.suggestedLimitCents).toBe(3_000_000);
    expect(low.reasons).toEqual([]);
  });

  it("programBook + programTape reflect assignment and aging", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const { db, store } = makeFakeDb();
    const p = programRow({ tenantId: "mfr", name: "P", programCapCents: 40_000_000 });
    store.programs.push(p);
    const a1 = accountRow({ supplierTenantId: "mfr", buyerTenantId: "b1", programId: p.id, outstandingCents: 8_000_000, score: 610, mandateId: "m1" });
    const a2 = accountRow({ supplierTenantId: "mfr", buyerTenantId: "b2", programId: p.id, outstandingCents: 4_000_000, score: 500 });
    store.accounts.push(a1, a2);
    store.ledger.push(
      { creditAccountId: a1.id, kind: "invoice_draw", status: "posted", dueDate: new Date(Date.now() - 45 * DAY) },
      { creditAccountId: a2.id, kind: "invoice_draw", status: "posted", dueDate: new Date(Date.now() + 5 * DAY) },
    );
    store.mandates.push({ id: "m1", status: "active" });

    const book = await getProgramBook(db, { programId: p.id, tenantId: "mfr" });
    expect(book.totalOutstandingCents).toBe(12_000_000);
    expect(book.concentration[0].buyerTenantId).toBe("b1");

    const tape = await generateProgramTape(db, { programId: p.id, tenantId: "mfr" });
    expect(tape.rows).toHaveLength(2);
    const r1 = tape.rows.find((r) => r.accountId === a1.id)!;
    expect(r1.bucket).toBe("31-60");
    expect(r1.mandateStatus).toBe("active");
    const r2 = tape.rows.find((r) => r.accountId === a2.id)!;
    expect(r2.bucket).toBe("current");
    expect(tape.summary.utilizationBps).toBe(3000);
    expect(tape.summary.topConcentration[0]).toEqual({ buyerTenantId: "b1", outstandingCents: 8_000_000, shareBps: 6667 });
    const lines = tape.csv.trimEnd().split("\n");
    expect(lines[0]).toContain("accountId,buyerTenantId");
    expect(lines).toHaveLength(3);
  });
});
