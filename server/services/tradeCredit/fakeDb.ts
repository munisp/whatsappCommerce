/**
 * Test-only in-memory db for tradeCredit unit tests.
 *
 * Pattern follows server/inventory.test.ts: this is NOT a stub that always
 * succeeds — it honors the conditional-update semantics of the real queries
 * (UPDATE ... WHERE outstanding_cents + amt <= limit_cents RETURNING matches
 * zero rows when the guard fails), so the money-path race/guard logic is
 * provably exercised. Check-and-apply happens in ONE synchronous step,
 * mirroring Postgres row-lock semantics.
 *
 * Conditions are decoded generically: drizzle builds eq/and/gte/lte/inArray
 * and sql`` templates as queryChunk trees where Columns appear as Column
 * objects (`.name` = snake_case column) and bound values as Param objects
 * (`.value`). We walk the tree and match (table, column-signature) pairs —
 * the same approach as sqlParams in inventory.test.ts, extended with column
 * names so sibling queries stay unambiguous.
 */
import { randomUUID } from "crypto";
import {
  creditAccounts,
  creditLedger,
  kycApplications,
  orders,
  paymentTransactions,
  tenants,
} from "../../../drizzle/schema";

// ── Row types (JS camelCase props, mirroring drizzle $inferSelect) ──────────
export interface AccountRow {
  id: string;
  supplierTenantId: string;
  buyerTenantId: string;
  limitCents: number;
  outstandingCents: number;
  termsDays: number;
  status: string;
  score: number | null;
  scoreReasons: unknown;
  createdAt: Date;
  updatedAt: Date;
}
export interface LedgerRow {
  id: string;
  creditAccountId: string;
  kind: string;
  amountCents: number;
  poId: string | null;
  dueDate: Date | null;
  status: string;
  ref: string | null;
  note: string | null;
  createdAt: Date;
}
export interface OrderRow { tenantId: string; totalAmount: string; createdAt: Date }
export interface PaymentRow { tenantId: string; status: string; createdAt: Date; paidAt: Date | null }
export interface TenantRow { id: string; settings: unknown }

export interface FakeStore {
  accounts: AccountRow[];
  ledger: LedgerRow[];
  orders: OrderRow[];
  payments: PaymentRow[];
  tenants: TenantRow[];
  kycApplications: Array<{ id: string; tenantId: string; type: string; status: string }>;
}

// ── drizzle condition decoding ───────────────────────────────────────────────
interface Decoded { columns: string[]; values: unknown[] }

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
    const ctor = o.constructor?.name;
    if (ctor === "StringChunk") return;
    if (ctor === "Column" || (typeof o.name === "string" && o.table != null)) {
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

function decodeOrder(exprs: unknown[]): { prop: string; desc: boolean }[] {
  return exprs.map((e) => {
    const chunks: unknown[] = (e as any)?.queryChunks ?? [];
    let col = "";
    let desc = false;
    for (const c of chunks) {
      const o = c as any;
      if (o?.constructor?.name === "Column" || (typeof o?.name === "string" && o?.table != null)) col = o.name;
      if (typeof c === "string" && /desc/i.test(c)) desc = true;
      if (Array.isArray(o?.queryChunks)) {
        for (const cc of o.queryChunks) if (typeof cc === "string" && /desc/i.test(cc)) desc = true;
      }
    }
    return { prop: col, desc };
  });
}

/** snake_case column → row prop, per table. */
const PROP: Record<string, Record<string, string>> = {
  credit_accounts: {
    id: "id", supplier_tenant_id: "supplierTenantId", buyer_tenant_id: "buyerTenantId",
    limit_cents: "limitCents", outstanding_cents: "outstandingCents", terms_days: "termsDays",
    status: "status", score: "score", score_reasons: "scoreReasons",
    created_at: "createdAt", updated_at: "updatedAt",
  },
  credit_ledger: {
    id: "id", credit_account_id: "creditAccountId", kind: "kind", amount_cents: "amountCents",
    po_id: "poId", due_date: "dueDate", status: "status", ref: "ref", note: "note", created_at: "createdAt",
  },
  orders: { tenantId: "tenantId", totalAmount: "totalAmount", createdAt: "createdAt" },
  payment_transactions: { tenantId: "tenantId", status: "status", createdAt: "createdAt", paidAt: "paidAt" },
  tenants: { id: "id", settings: "settings" },
  kyc_applications: { id: "id", tenantId: "tenantId", type: "type", status: "status" },
};

/** Extract { delta } from an arithmetic SQL set value, honoring +/-. */
function decodeArithmetic(v: unknown): number {
  const chunks: unknown[] = (v as any)?.queryChunks ?? [];
  let sign = 1;
  let value = 0;
  for (const c of chunks) {
    if (typeof c === "number") { value = c; continue; }
    if (typeof c === "string") { if (c.includes("-")) sign = -1; continue; }
    const o = c as any;
    if (o?.constructor?.name === "StringChunk") {
      const s = Array.isArray(o.value) ? o.value.join("") : String(o.value ?? "");
      if (s.includes("-")) sign = -1;
      continue;
    }
    if (o != null && typeof o === "object" && typeof o.value === "number") value = o.value;
  }
  return sign * value;
}

function tableName(table: unknown): string {
  for (const [name, t] of Object.entries({
    credit_accounts: creditAccounts,
    credit_ledger: creditLedger,
    orders,
    payment_transactions: paymentTransactions,
    tenants,
    kyc_applications: kycApplications,
  })) {
    if (t === table) return name;
  }
  throw new Error("fakeDb: unknown table");
}

export function makeFakeDb(seed?: Partial<FakeStore>) {
  const store: FakeStore = {
    accounts: (seed?.accounts ?? []).map((r) => ({ ...r })),
    ledger: (seed?.ledger ?? []).map((r) => ({ ...r })),
    orders: (seed?.orders ?? []).map((r) => ({ ...r })),
    payments: (seed?.payments ?? []).map((r) => ({ ...r })),
    tenants: (seed?.tenants ?? []).map((r) => ({ ...r })),
    kycApplications: (seed?.kycApplications ?? []).map((r) => ({ ...r })),
  };
  const rowsOf = (t: string): any[] =>
    t === "credit_accounts" ? store.accounts
    : t === "credit_ledger" ? store.ledger
    : t === "orders" ? store.orders
    : t === "payment_transactions" ? store.payments
    : t === "kyc_applications" ? store.kycApplications
    : store.tenants;

  // ── SELECT filtering — matches every select shape in the services ────────
  function runSelect(t: string, fields: Record<string, unknown> | undefined, cond: unknown, orderExprs: unknown[], limitN?: number): any[] {
    const P = PROP[t];
    const { columns, values } = decode(cond);
    let rows = rowsOf(t);
    const sig = columns.join(",");
    if (t === "credit_accounts") {
      if (sig === "supplier_tenant_id,buyer_tenant_id") {
        rows = rows.filter((r) => r.supplierTenantId === values[0] && r.buyerTenantId === values[1]);
      } else if (sig === "id") {
        rows = rows.filter((r) => r.id === values[0]);
      } else if (sig === "supplier_tenant_id") {
        rows = rows.filter((r) => r.supplierTenantId === values[0]);
      } else if (sig === "buyer_tenant_id") {
        rows = rows.filter((r) => r.buyerTenantId === values[0]);
      } else throw new Error(`fakeDb select credit_accounts: unhandled ${sig}`);
    } else if (t === "credit_ledger") {
      if (sig === "credit_account_id,kind,status") {
        rows = rows.filter((r) => r.creditAccountId === values[0] && r.kind === values[1] && r.status === values[2]);
      } else if (sig === "credit_account_id,kind") {
        const kinds = values.slice(1);
        rows = rows.filter((r) => r.creditAccountId === values[0] && kinds.includes(r.kind));
      } else if (sig === "credit_account_id") {
        rows = rows.filter((r) => r.creditAccountId === values[0]);
      } else if (sig === "kind,status,due_date,due_date") {
        const horizon = values[2] as Date;
        rows = rows.filter((r) => r.kind === values[0] && r.status === values[1] && r.dueDate != null && new Date(r.dueDate).getTime() <= horizon.getTime());
      } else throw new Error(`fakeDb select credit_ledger: unhandled ${sig}`);
    } else if (t === "orders") {
      if (sig === "tenantId,createdAt") {
        const since = values[1] as Date;
        rows = rows.filter((r) => r.tenantId === values[0] && new Date(r.createdAt).getTime() >= since.getTime());
      } else if (sig === "tenantId") {
        rows = rows.filter((r) => r.tenantId === values[0]);
      } else throw new Error(`fakeDb select orders: unhandled ${sig}`);
    } else if (t === "payment_transactions") {
      if (sig === "tenantId,status") {
        rows = rows.filter((r) => r.tenantId === values[0] && r.status === values[1]);
      } else throw new Error(`fakeDb select payment_transactions: unhandled ${sig}`);
    } else if (t === "tenants") {
      if (sig === "id") rows = rows.filter((r) => r.id === values[0]);
      else throw new Error(`fakeDb select tenants: unhandled ${sig}`);
    } else if (t === "kyc_applications") {
      if (sig === "tenantId,type,status") {
        rows = rows.filter((r) => r.tenantId === values[0] && r.type === values[1] && r.status === values[2]);
      } else if (sig === "tenantId") {
        rows = rows.filter((r) => r.tenantId === values[0]);
      } else throw new Error(`fakeDb select kyc_applications: unhandled ${sig}`);
    }
    // orderBy
    for (const { prop, desc } of decodeOrder(orderExprs).reverse()) {
      const p = P[prop] ?? prop;
      rows = [...rows].sort((a, b) => {
        const av = a[p] instanceof Date ? a[p].getTime() : a[p];
        const bv = b[p] instanceof Date ? b[p].getTime() : b[p];
        return (av < bv ? -1 : av > bv ? 1 : 0) * (desc ? -1 : 1);
      });
    }
    if (limitN != null) rows = rows.slice(0, limitN);
    // project
    if (fields) {
      const keys = Object.keys(fields);
      rows = rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
    } else {
      rows = rows.map((r) => ({ ...r }));
    }
    return rows;
  }

  // ── INSERT ───────────────────────────────────────────────────────────────
  function runInsert(t: string, values: any): any {
    if (t === "credit_accounts") {
      const row: AccountRow = {
        id: values.id ?? randomUUID(),
        supplierTenantId: values.supplierTenantId,
        buyerTenantId: values.buyerTenantId,
        limitCents: values.limitCents ?? 0,
        outstandingCents: values.outstandingCents ?? 0,
        termsDays: values.termsDays ?? 30,
        status: values.status ?? "active",
        score: values.score ?? null,
        scoreReasons: values.scoreReasons ?? null,
        createdAt: values.createdAt ?? new Date(),
        updatedAt: values.updatedAt ?? new Date(),
      };
      store.accounts.push(row);
      return { ...row };
    }
    if (t === "credit_ledger") {
      const row: LedgerRow = {
        id: values.id ?? randomUUID(),
        creditAccountId: values.creditAccountId,
        kind: values.kind,
        amountCents: values.amountCents,
        poId: values.poId ?? null,
        dueDate: values.dueDate ?? null,
        status: values.status ?? "posted",
        ref: values.ref ?? null,
        note: values.note ?? null,
        createdAt: values.createdAt ?? new Date(),
      };
      store.ledger.push(row);
      return { ...row };
    }
    throw new Error(`fakeDb insert: unhandled ${t}`);
  }

  // ── UPDATE — conditional semantics per money-path shape ──────────────────
  function runUpdate(t: string, set: Record<string, unknown>, cond: unknown): any[] {
    const { columns, values } = decode(cond);
    const sig = columns.join(",");
    const matched: any[] = [];
    if (t === "credit_accounts") {
      for (const r of store.accounts) {
        let ok = false;
        if (sig === "id,status,outstanding_cents,limit_cents") {
          // drawOnCredit claim: id + status='active' + out + amt <= limit
          const [id, , amt] = values as [string, string, number];
          ok = r.id === id && r.status === "active" && r.outstandingCents + Number(amt) <= r.limitCents;
        } else if (sig === "id,outstanding_cents") {
          // applyRepayment claim: id + out >= amt
          const [id, amt] = values as [string, number];
          ok = r.id === id && r.outstandingCents >= Number(amt);
        } else if (sig === "id,supplier_tenant_id") {
          ok = r.id === values[0] && r.supplierTenantId === values[1];
        } else if (sig === "id,supplier_tenant_id,status") {
          // approveCreditAccount claim: id + supplier + status='pending'
          ok = r.id === values[0] && r.supplierTenantId === values[1] && r.status === values[2];
        } else if (sig === "id,status") {
          // dunning freeze: id + status='active'
          ok = r.id === values[0] && r.status === values[1];
        } else throw new Error(`fakeDb update credit_accounts: unhandled ${sig}`);
        if (!ok) continue;
        for (const [k, v] of Object.entries(set)) {
          if (v != null && typeof v === "object" && Array.isArray((v as any).queryChunks)) {
            // arithmetic SQL (outstanding ± amt): sign-aware delta
            const delta = decodeArithmetic(v);
            if (k === "outstandingCents") r.outstandingCents += delta;
            else throw new Error(`fakeDb set SQL on ${k}`);
          } else {
            (r as any)[k] = v;
          }
        }
        matched.push({ ...r });
      }
      return matched;
    }
    if (t === "credit_ledger") {
      for (const r of store.ledger) {
        let ok = false;
        if (sig === "id,status,note,note") {
          // dunning marker claim: id + status='posted' + note NOT LIKE marker
          const [id, , like] = values as [string, string, string];
          const marker = like.replace(/%/g, "");
          ok = r.id === id && r.status === "posted" && !(r.note ?? "").includes(marker);
        } else if (sig === "id,status") {
          // FIFO settle: inArray(id, ids) + status='posted' → ids are values[0..n-2]
          const statusVal = values[values.length - 1];
          const ids = values.slice(0, -1);
          ok = ids.includes(r.id) && r.status === statusVal;
        } else throw new Error(`fakeDb update credit_ledger: unhandled ${sig}`);
        if (!ok) continue;
        for (const [k, v] of Object.entries(set)) {
          if (v != null && typeof v === "object" && Array.isArray((v as any).queryChunks)) {
            if (k === "note") {
              const markerText = String(decode(v).values[0] ?? "");
              r.note = (r.note ?? "") + markerText;
            } else throw new Error(`fakeDb set SQL on ${k}`);
          } else {
            (r as any)[k] = v;
          }
        }
        matched.push({ ...r });
      }
      return matched;
    }
    throw new Error(`fakeDb update: unhandled ${t}`);
  }

  // ── drizzle chain surface ────────────────────────────────────────────────
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
              const orderExprs: unknown[] = [];
              let limitN: number | undefined;
              const get = () => runSelect(t, fields, cond, orderExprs, limitN);
              const chain: any = thenable(get);
              chain.orderBy = (...exprs: unknown[]) => {
                orderExprs.push(...exprs);
                return chain;
              };
              chain.limit = (n: number) => {
                limitN = n;
                return chain;
              };
              chain.offset = () => chain;
              return chain;
            },
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
      // Single synchronous store ⇒ check-and-apply is atomic (PG row-lock
      // semantics); no rollback needed because guard failures mutate nothing.
      return fn(db);
    },
    execute: async () => [],
  };
  return { db, store };
}

// ── Seed factories ───────────────────────────────────────────────────────────
export function seedAccount(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: over.id ?? randomUUID(),
    supplierTenantId: "supplier-1",
    buyerTenantId: "buyer-1",
    limitCents: 100_000,
    outstandingCents: 0,
    termsDays: 30,
    status: "active",
    score: null,
    scoreReasons: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...over,
  };
}

export function seedDraw(accountId: string, over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: over.id ?? randomUUID(),
    creditAccountId: accountId,
    kind: "invoice_draw",
    amountCents: 10_000,
    poId: "po-1",
    dueDate: new Date("2025-02-01T00:00:00Z"),
    status: "posted",
    ref: "draw:po-1",
    note: null,
    createdAt: new Date("2025-01-02T00:00:00Z"),
    ...over,
  };
}

/** Approved-by-default KYB application row for KYB-gate router tests. */
export function seedKycApplication(over: Record<string, unknown> = {}) {
  return {
    id: (over.id as string) ?? randomUUID(),
    tenantId: "supplier-1",
    type: "kyb",
    status: "approved",
    ...over,
  } as FakeStore["kycApplications"][number];
}
