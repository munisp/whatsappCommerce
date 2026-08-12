/**
 * Test-only in-memory db for procurement unit tests (same pattern as
 * services/tradeCredit/fakeDb.ts): stateful row stores + generic drizzle
 * condition decoding (eq/and/inArray over queryChunk trees), so flow logic
 * (MOQ guards, status transitions, ownership checks) is provably exercised
 * rather than stubbed away.
 */
import { randomUUID } from "crypto";
import {
  kycApplications,
  poItems,
  products,
  purchaseOrders,
  supplierProfiles,
  tenants,
  wholesalePriceTiers,
} from "../../../drizzle/schema";

export interface FakeStore {
  supplierProfiles: any[];
  purchaseOrders: any[];
  poItems: any[];
  tenants: any[];
  products: any[];
  wholesaleTiers: any[];
  kycApplications: any[];
}

// ── drizzle condition decoding (columns + bound values, in order) ───────────
function decode(v: unknown): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const walk = (c: unknown, isChunkList = false): void => {
    if (c == null) return;
    if (Array.isArray(c)) {
      // The queryChunks list itself is walked item by item; a raw Array chunk
      // nested inside it is an inArray binding and counts as ONE value
      // (drizzle: sql`${col} in ${values.map(bindIfParam)}` keeps the array).
      if (isChunkList) return c.forEach((x) => walk(x));
      values.push(
        c.map((p) =>
          p != null && typeof p === "object" && "value" in (p as Record<string, unknown>)
            ? (p as { value: unknown }).value
            : p,
        ),
      );
      return;
    }
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
    if (Array.isArray(o.queryChunks)) return walk(o.queryChunks, true);
    if ("value" in o) {
      values.push(o.value);
      return;
    }
  };
  walk((v as { queryChunks?: unknown[] })?.queryChunks ?? v, true);
  return { columns, values };
}

function decodeOrderDesc(exprs: unknown[]): { prop: string; desc: boolean }[] {
  return exprs.map((e) => {
    const chunks: unknown[] = (e as any)?.queryChunks ?? [];
    let col = "";
    let desc = false;
    const walk = (c: unknown): void => {
      if (c == null) return;
      if (typeof c === "string") {
        if (/desc/i.test(c)) desc = true;
        return;
      }
      if (Array.isArray(c)) return c.forEach(walk);
      if (typeof c !== "object") return;
      const o = c as any;
      if (o.constructor?.name === "Column" || (typeof o?.name === "string" && o?.table != null)) col = o.name;
      if (Array.isArray(o.queryChunks)) walk(o.queryChunks);
    };
    walk(chunks);
    return { prop: col, desc };
  });
}

/** snake_case column → JS row prop, per table. */
const PROP: Record<string, Record<string, string>> = {
  supplier_profiles: {
    tenant_id: "tenantId", moq_cents: "moqCents", lead_time_days: "leadTimeDays",
    terms_offered: "termsOffered", default_terms_days: "defaultTermsDays",
    auto_approve_below_cents: "autoApproveBelowCents", categories: "categories",
    status: "status", created_at: "createdAt", updated_at: "updatedAt",
  },
  purchase_orders: {
    id: "id", po_number: "poNumber", buyer_tenant_id: "buyerTenantId",
    supplier_tenant_id: "supplierTenantId", status: "status", subtotal_cents: "subtotalCents",
    payment_mode: "paymentMode", credit_account_id: "creditAccountId", terms_days: "termsDays",
    due_date: "dueDate", buyer_phone: "buyerPhone", notes: "notes",
    created_at: "createdAt", updated_at: "updatedAt",
  },
  po_items: {
    id: "id", po_id: "poId", product_ref: "productRef", name: "name", qty: "qty",
    unit_price_cents: "unitPriceCents", line_total_cents: "lineTotalCents",
  },
  tenants: { id: "id", name: "name", settings: "settings" },
  kyc_applications: {
    id: "id", tenantId: "tenantId", type: "type", status: "status",
  },
  products: {
    id: "id", tenantId: "tenantId", sku: "sku", name: "name", price: "price",
    currency: "currency", status: "status", stockQuantity: "stockQuantity", metadata: "metadata",
  },
  wholesale_price_tiers: {
    id: "id", tenantId: "tenantId", productId: "productId", buyerType: "buyerType",
    minQuantity: "minQuantity", unitPrice: "unitPrice", currency: "currency",
  },
};

const TABLES: Record<string, unknown> = {
  supplier_profiles: supplierProfiles,
  purchase_orders: purchaseOrders,
  po_items: poItems,
  tenants,
  kyc_applications: kycApplications,
  products,
  wholesale_price_tiers: wholesalePriceTiers,
};

function tableName(table: unknown): string {
  for (const [name, t] of Object.entries(TABLES)) if (t === table) return name;
  throw new Error("procurement fakeDb: unknown table");
}

function filterRows(rows: any[], t: string, cond: unknown): any[] {
  const P = PROP[t];
  const { columns, values } = decode(cond);
  // Pair columns with values positionally (eq/and only use 1:1 bindings;
  // inArray contributes its column once and the array as one value).
  return rows.filter((r) => {
    let vi = 0;
    for (const col of columns) {
      const prop = P[col] ?? col;
      const bound = values[vi];
      vi += 1;
      if (Array.isArray(bound)) {
        if (!bound.includes(r[prop])) return false;
      } else if (r[prop] !== bound) return false;
    }
    return true;
  });
}

export function makeFakeDb(seed?: Partial<FakeStore>) {
  const store: FakeStore = {
    supplierProfiles: (seed?.supplierProfiles ?? []).map((r) => ({ ...r })),
    purchaseOrders: (seed?.purchaseOrders ?? []).map((r) => ({ ...r })),
    poItems: (seed?.poItems ?? []).map((r) => ({ ...r })),
    tenants: (seed?.tenants ?? []).map((r) => ({ ...r })),
    products: (seed?.products ?? []).map((r) => ({ ...r })),
    wholesaleTiers: (seed?.wholesaleTiers ?? []).map((r) => ({ ...r })),
    kycApplications: (seed?.kycApplications ?? []).map((r) => ({ ...r })),
  };
  const STORE_KEY: Record<string, keyof FakeStore> = {
    supplier_profiles: "supplierProfiles",
    purchase_orders: "purchaseOrders",
    po_items: "poItems",
    tenants: "tenants",
    kyc_applications: "kycApplications",
    products: "products",
    wholesale_price_tiers: "wholesaleTiers",
  };
  const rowsOf = (t: string): any[] => store[STORE_KEY[t]] as any[];

  function runSelect(t: string, fields: Record<string, unknown> | undefined, cond: unknown, orderExprs: unknown[], limitN?: number): any[] {
    let rows = filterRows(rowsOf(t), t, cond);
    for (const { prop, desc } of decodeOrderDesc(orderExprs).reverse()) {
      const p = PROP[t][prop] ?? prop;
      rows = [...rows].sort((a, b) => {
        const av = a[p] instanceof Date ? a[p].getTime() : a[p];
        const bv = b[p] instanceof Date ? b[p].getTime() : b[p];
        return (av < bv ? -1 : av > bv ? 1 : 0) * (desc ? -1 : 1);
      });
    }
    if (limitN != null) rows = rows.slice(0, limitN);
    if (fields) {
      const keys = Object.keys(fields);
      return rows.map((r) => Object.fromEntries(keys.map((k) => {
        if (k === "profile") return [k, { ...r }]; // directory leftJoin shape
        if (k === "tenantName") {
          const tenant = store.tenants.find((tn) => tn.id === r.tenantId);
          return [k, tenant?.name ?? null];
        }
        return [k, r[k]];
      })));
    }
    return rows.map((r) => ({ ...r }));
  }

  function runInsert(t: string, values: any): any {
    if (Array.isArray(values)) return values.map((v) => runInsert(t, v));
    if (t === "purchase_orders" && store.purchaseOrders.some((r) => r.poNumber === values.poNumber)) {
      const err: any = new Error(`duplicate key value violates unique constraint "purchase_orders_po_number_unique"`);
      err.code = "23505";
      throw err;
    }
    const row = { id: values.id ?? randomUUID(), ...values };
    rowsOf(t).push(row);
    return { ...row };
  }

  function runUpdate(t: string, set: Record<string, unknown>, cond: unknown): any[] {
    const matched: any[] = [];
    for (const r of rowsOf(t)) {
      if (filterRows([r], t, cond).length === 0) continue;
      Object.assign(r, set);
      matched.push({ ...r });
    }
    return matched;
  }

  function runDelete(t: string, cond: unknown): any[] {
    const rows = rowsOf(t);
    const removed = filterRows(rows, t, cond);
    for (const r of removed) rows.splice(rows.indexOf(r), 1);
    return removed;
  }

  const thenable = (get: () => any) => {
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
          const build = (cond: unknown) => {
            const orderExprs: unknown[] = [];
            let limitN: number | undefined;
            const get = () => runSelect(t, fields, cond, orderExprs, limitN);
            const chain: any = thenable(get);
            chain.orderBy = (...exprs: unknown[]) => { orderExprs.push(...exprs); return chain; };
            chain.limit = (n: number) => { limitN = n; return chain; };
            chain.offset = () => chain;
            return chain;
          };
          return {
            where(cond: unknown) { return build(cond); },
            leftJoin(_t: unknown, _cond: unknown) {
              return { where(cond: unknown) { return build(cond); } };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      const t = tableName(table);
      return {
        values(vals: any) {
          const get = () => runInsert(t, vals);
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
    delete(table: unknown) {
      const t = tableName(table);
      return {
        where(cond: unknown) {
          return thenable(() => runDelete(t, cond));
        },
      };
    },
    transaction(fn: (tx: any) => Promise<any>) { return fn(db); },
    execute: async () => [],
  };
  return { db, store };
}

// ── Seed factories ───────────────────────────────────────────────────────────
export function seedSupplierProfile(over: Record<string, unknown> = {}) {
  return {
    tenantId: "supplier-1",
    moqCents: 0,
    leadTimeDays: 3,
    termsOffered: [7, 14, 30],
    defaultTermsDays: 14,
    autoApproveBelowCents: null,
    categories: ["beverages"],
    status: "active",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...over,
  };
}

export function seedPo(over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? randomUUID(),
    poNumber: "PO-20250101-AAAA",
    buyerTenantId: "buyer-1",
    supplierTenantId: "supplier-1",
    status: "submitted",
    subtotalCents: 50_000,
    paymentMode: "credit",
    creditAccountId: null,
    termsDays: 14,
    dueDate: null,
    buyerPhone: "+2348000000001",
    notes: null,
    createdAt: new Date("2025-01-02T00:00:00Z"),
    updatedAt: new Date("2025-01-02T00:00:00Z"),
    ...over,
  };
}

/** Approved-by-default KYB application row for gate tests. */
export function seedKycApplication(over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? randomUUID(),
    tenantId: "supplier-1",
    type: "kyb",
    status: "approved",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...over,
  };
}
