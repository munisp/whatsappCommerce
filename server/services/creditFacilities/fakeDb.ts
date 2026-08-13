/**
 * Test-only in-memory db for creditFacilities unit tests — same decode
 * approach as services/tradeCredit/fakeDb.ts: drizzle eq/and/inArray
 * conditions are walked as queryChunk trees (Columns carry `.name`, bound
 * values are Params), and (table, column-signature) pairs drive filtering.
 * Check-and-apply happens synchronously, mirroring PG row-lock semantics.
 */
import { randomUUID } from "crypto";
import { creditLedger, paymentMandates } from "../../../drizzle/schema";
import { bureauReportLog, creditAccountsExt, creditFacilities } from "./tables";

export interface FacilityRow {
  id: string;
  lenderName: string;
  facilityRef: string;
  commitmentCents: number;
  currency: string;
  advanceRateBps: number;
  covenants: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface AccountExtRow {
  id: string;
  supplierTenantId: string;
  buyerTenantId: string;
  limitCents: number;
  outstandingCents: number;
  status: string;
  score: number | null;
  mandateId: string | null;
  bureauConsentAt: Date | null;
  bureauConsentRef: string | null;
  facilityId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface LedgerDueRow {
  creditAccountId: string;
  kind: string;
  status: string;
  dueDate: Date | null;
}
export interface MandateStatusRow {
  id: string;
  status: string;
}

export interface FakeStore {
  facilities: FacilityRow[];
  accounts: AccountExtRow[];
  ledger: LedgerDueRow[];
  mandates: MandateStatusRow[];
}

interface Decoded {
  columns: string[];
  values: unknown[];
}

function decode(v: unknown): Decoded {
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
    if ("value" in o) {
      values.push(o.value);
      return;
    }
  };
  walk((v as { queryChunks?: unknown[] })?.queryChunks ?? v);
  return { columns, values };
}

function tableName(table: unknown): string {
  for (const [name, t] of Object.entries({
    credit_facilities: creditFacilities,
    bureau_report_log: bureauReportLog,
    credit_accounts: creditAccountsExt,
    credit_ledger: creditLedger,
    payment_mandates: paymentMandates,
  })) {
    if (t === table) return name;
  }
  throw new Error("creditFacilities fakeDb: unknown table");
}

export function makeFakeDb(seed?: Partial<FakeStore>) {
  const store: FakeStore = {
    facilities: (seed?.facilities ?? []).map((r) => ({ ...r })),
    accounts: (seed?.accounts ?? []).map((r) => ({ ...r })),
    ledger: (seed?.ledger ?? []).map((r) => ({ ...r })),
    mandates: (seed?.mandates ?? []).map((r) => ({ ...r })),
  };
  const rowsOf = (t: string): any[] =>
    t === "credit_facilities"
      ? store.facilities
      : t === "credit_accounts"
        ? store.accounts
        : t === "credit_ledger"
          ? store.ledger
          : t === "payment_mandates"
            ? store.mandates
            : [];

  function runSelect(t: string, fields: Record<string, unknown> | undefined, cond: unknown): any[] {
    let rows = rowsOf(t);
    if (cond != null) {
      const { columns, values } = decode(cond);
      const sig = columns.join(",");
      if (t === "credit_facilities") {
        if (sig === "id") {
          // eq(id, v) → 1 value; inArray(id, ids) → N values (column chunk once)
          rows = values.length > 1 ? rows.filter((r) => (values as string[]).includes(r.id)) : rows.filter((r) => r.id === values[0]);
        } else if (sig === "facility_ref") rows = rows.filter((r) => r.facilityRef === values[0]);
        else throw new Error(`fakeDb select credit_facilities: unhandled ${sig}`);
      } else if (t === "credit_accounts") {
        if (sig === "id") rows = rows.filter((r) => r.id === values[0]);
        else if (sig === "facility_id") rows = rows.filter((r) => r.facilityId === values[0]);
        else throw new Error(`fakeDb select credit_accounts: unhandled ${sig}`);
      } else if (t === "credit_ledger") {
        if (sig === "credit_account_id,kind,status") {
          // inArray(credit_account_id, ids) flattens to N values, then kind, status
          const status = values[values.length - 1];
          const kind = values[values.length - 2];
          const ids = values.slice(0, -2) as string[];
          rows = rows.filter((r) => ids.includes(r.creditAccountId) && r.kind === kind && r.status === status);
        } else throw new Error(`fakeDb select credit_ledger: unhandled ${sig}`);
      } else if (t === "payment_mandates") {
        if (sig === "id") {
          const ids = values as string[];
          rows = rows.filter((r) => ids.includes(r.id));
        } else throw new Error(`fakeDb select payment_mandates: unhandled ${sig}`);
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

  function runInsert(t: string, values: any): any {
    if (t === "credit_facilities") {
      const row: FacilityRow = {
        id: values.id ?? randomUUID(),
        lenderName: values.lenderName,
        facilityRef: values.facilityRef,
        commitmentCents: values.commitmentCents,
        currency: values.currency ?? "NGN",
        advanceRateBps: values.advanceRateBps ?? 8000,
        covenants: values.covenants ?? null,
        status: values.status ?? "active",
        createdAt: values.createdAt ?? new Date(),
        updatedAt: values.updatedAt ?? new Date(),
      };
      store.facilities.push(row);
      return { ...row };
    }
    throw new Error(`fakeDb insert: unhandled ${t}`);
  }

  function runUpdate(t: string, set: Record<string, unknown>, cond: unknown): any[] {
    const { columns, values } = decode(cond);
    const sig = columns.join(",");
    const matched: any[] = [];
    if (t === "credit_accounts" && sig === "id") {
      for (const r of store.accounts) {
        if (r.id !== values[0]) continue;
        for (const [k, v] of Object.entries(set)) (r as any)[k] = v;
        matched.push({ ...r });
      }
      return matched;
    }
    if (t === "credit_facilities" && sig === "id") {
      for (const r of store.facilities) {
        if (r.id !== values[0]) continue;
        for (const [k, v] of Object.entries(set)) (r as any)[k] = v;
        matched.push({ ...r });
      }
      return matched;
    }
    throw new Error(`fakeDb update: unhandled ${t} ${sig}`);
  }

  const thenable = (get: () => any[]) => {
    const self: any = {};
    self.then = (resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve().then(get).then(resolve, reject);
    self.catch = (rej: (e: unknown) => unknown) => Promise.resolve().then(get).catch(rej);
    return self;
  };

  const db: any = {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const t = tableName(table);
          return {
            where(cond: unknown) {
              const get = () => runSelect(t, fields, cond);
              const chain: any = thenable(get);
              chain.limit = () => chain;
              chain.orderBy = () => chain;
              return chain;
            },
            then: (resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => runSelect(t, fields, null))
                .then(resolve, reject),
            catch: (rej: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => runSelect(t, fields, null))
                .catch(rej),
          };
        },
      };
    },
    insert(table: unknown) {
      const t = tableName(table);
      return {
        values(vals: any) {
          const get = () => [runInsert(t, vals)];
          const chain: any = thenable(get);
          chain.returning = () => chain;
          return chain;
        },
      };
    },
    update(table: unknown) {
      const t = tableName(table);
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              const get = () => runUpdate(t, vals, cond);
              const chain: any = thenable(get);
              chain.returning = () => chain;
              return chain;
            },
          };
        },
      };
    },
    transaction(fn: (tx: any) => Promise<any>) {
      return fn(db);
    },
  };
  return { db, store };
}

// ── Seed factories ───────────────────────────────────────────────────────────
export function seedFacility(over: Partial<FacilityRow> = {}): FacilityRow {
  return {
    id: over.id ?? randomUUID(),
    lenderName: "Kuda MFB",
    facilityRef: `FAC-${Math.floor(Math.random() * 1e6)}`,
    commitmentCents: 1_000_000_00,
    currency: "NGN",
    advanceRateBps: 8000,
    covenants: null,
    status: "active",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...over,
  };
}

export function seedAccountExt(over: Partial<AccountExtRow> = {}): AccountExtRow {
  return {
    id: over.id ?? randomUUID(),
    supplierTenantId: "supplier-1",
    buyerTenantId: "buyer-1",
    limitCents: 100_000_00,
    outstandingCents: 0,
    status: "active",
    score: null,
    mandateId: null,
    bureauConsentAt: null,
    bureauConsentRef: null,
    facilityId: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...over,
  };
}

export function seedLedgerDue(accountId: string, over: Partial<LedgerDueRow> = {}): LedgerDueRow {
  return {
    creditAccountId: accountId,
    kind: "invoice_draw",
    status: "posted",
    dueDate: new Date("2025-02-01T00:00:00Z"),
    ...over,
  };
}
