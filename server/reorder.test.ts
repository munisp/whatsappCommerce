/**
 * reorder — unit tests
 * Smart reorder: last-PAID-order resolution (tenant-scoped, phone or
 * customers.id), cart rebuild at CURRENT catalog prices with price-change
 * notes, and the no-prior-order fallback. DB is mocked in-memory with real
 * drizzle condition filtering so ownership checks are exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

// ── In-memory DB mock with real condition filtering ──────────────────────────

const stores: Record<string, Record<string, unknown>[]> = {};
const dialect = new PgDialect();

function filterRows(table: unknown, cond: unknown, rows: Record<string, unknown>[]) {
  if (!cond) return rows;
  let compiled: { sql: string; params: unknown[] };
  try {
    compiled = dialect.sqlToQuery(cond as never);
  } catch {
    return rows;
  }
  const colMap: Record<string, string> = {};
  try {
    for (const [prop, col] of Object.entries(getTableColumns(table as never))) {
      colMap[(col as { name: string }).name] = prop;
    }
  } catch {
    return rows;
  }
  const tests: Array<(r: Record<string, unknown>) => boolean> = [];
  for (const part of compiled.sql.split(/ and /)) {
    const mEq = part.match(/"[\w]+"\."([\w]+)" = \$(\d+)/);
    if (mEq) {
      const prop = colMap[mEq[1]];
      const val = compiled.params[Number(mEq[2]) - 1];
      if (prop) tests.push((r) => String(r[prop]) === String(val));
      continue;
    }
    const mIn = part.match(/"[\w]+"\."([\w]+)" in \(([^)]*)\)/i);
    if (mIn) {
      const prop = colMap[mIn[1]];
      const vals = mIn[2].split(",").map((s) => compiled.params[Number(s.trim().slice(1)) - 1]);
      if (prop) tests.push((r) => vals.some((v) => String(r[prop]) === String(v)));
    }
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

function makeChain(rows: Record<string, unknown>[]): any {
  const self: any = {};
  const chain = () => makeChain(rows);
  self.orderBy = chain;
  self.limit = chain;
  self.returning = () => Promise.resolve(rows);
  self.then = (resolve: (v: unknown) => void) => {
    resolve(rows);
    return self;
  };
  self.catch = () => self;
  return self;
}

const db: any = {
  select: () => ({
    from: (table: unknown) => {
      const all = stores[getTableName(table as never)] ?? [];
      const api: any = {};
      api.where = (cond: unknown) => makeChain(filterRows(table, cond, all));
      api.then = (resolve: (v: unknown) => void) => {
        resolve(all);
        return api;
      };
      return api;
    },
  }),
  insert: (table: unknown) => ({
    values: (vals: Record<string, unknown>) => {
      const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...vals };
      (stores[getTableName(table as never)] ??= []).push(row);
      return {
        returning: () => Promise.resolve([row]),
        then: (resolve: (v: unknown) => void) => resolve([row]),
      };
    },
  }),
  update: (table: unknown) => ({
    set: (vals: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        const name = getTableName(table as never);
        const matched = filterRows(table, cond, stores[name] ?? []);
        for (const row of matched) Object.assign(row, vals);
        return {
          returning: () => Promise.resolve(matched),
          then: (resolve: (v: unknown) => void) => resolve(matched),
        };
      },
    }),
  }),
};

import { buildReorder, buildReorderReply, findLastPaidOrder } from "./services/reorder";

const T = "tenant-1";
const PHONE = "2348000000001";

const PRODUCTS = [
  { id: "p1", name: "Spicy Chicken Wrap", price: "1500.00", currency: "NGN", stockQuantity: 10 },
  { id: "p2", name: "Malt Drink", price: "500.00", currency: "NGN", stockQuantity: 20 },
  { id: "p3", name: "Retired Snack", price: "300.00", currency: "NGN", stockQuantity: 0 },
];

function seedPaidOrder(overrides: Record<string, unknown> = {}) {
  (stores.orders ??= []).push({
    id: "order-1",
    tenantId: T,
    customerId: PHONE,
    orderNumber: "ORD-PAID-1",
    paymentStatus: "completed",
    status: "delivered",
    items: [
      { productId: "p1", name: "Spicy Chicken Wrap", qty: 2, price: "1200.00" },
      { productId: "p2", name: "Malt Drink", qty: 1, price: "500.00" },
    ],
    createdAt: new Date("2026-01-01T10:00:00Z"),
    updatedAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  for (const k of Object.keys(stores)) delete stores[k];
});

describe("buildReorder", () => {
  it("rebuilds the cart from the last paid order at CURRENT prices, noting changes", async () => {
    seedPaidOrder();
    const result = await buildReorder(db, {
      tenantId: T,
      waPhoneNumber: PHONE,
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: PRODUCTS,
    });
    expect(result.status).toBe("ready");
    expect(result.orderNumber).toBe("ORD-PAID-1");
    expect(result.added).toHaveLength(2);
    const wrap = result.added.find((a) => a.productName === "Spicy Chicken Wrap")!;
    expect(wrap.unitPrice).toBe("1500.00"); // repriced from the catalog
    expect(wrap.previousUnitPrice).toBe("1200.00");
    expect(wrap.priceChanged).toBe(true);
    const malt = result.added.find((a) => a.productName === "Malt Drink")!;
    expect(malt.priceChanged).toBe(false);
    // Cart rows actually landed in cart_sessions/cart_items.
    expect(stores.cart_sessions).toHaveLength(1);
    expect(stores.cart_items).toHaveLength(2);
    expect(stores.cart_sessions[0].tenantId).toBe(T);
    expect(stores.cart_sessions[0].waPhoneNumber).toBe(PHONE);
  });

  it("buyer-facing reply calls out the price change and next step", async () => {
    seedPaidOrder();
    const result = await buildReorder(db, {
      tenantId: T,
      waPhoneNumber: PHONE,
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: PRODUCTS,
    });
    const reply = buildReorderReply(result);
    expect(reply).toContain("ORD-PAID-1");
    expect(reply).toContain("was 1200.00, now 1500.00");
    expect(reply).toMatch(/today's catalog prices/);
    expect(reply).toMatch(/reply \*checkout\*/i);
  });

  it("flags out-of-stock items as unavailable instead of adding them", async () => {
    seedPaidOrder({
      items: [{ productId: "p3", name: "Retired Snack", qty: 1, price: "300.00" }],
    });
    const result = await buildReorder(db, {
      tenantId: T,
      waPhoneNumber: PHONE,
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: PRODUCTS,
    });
    expect(result.status).toBe("nothing_available");
    expect(result.added).toHaveLength(0);
    expect(result.unavailable.join(" ")).toContain("out of stock");
  });

  it("falls back politely when there is no prior PAID order", async () => {
    seedPaidOrder({ paymentStatus: "unpaid", orderNumber: "ORD-UNPAID" });
    expect(await findLastPaidOrder(db, T, PHONE)).toBeNull();
    const result = await buildReorder(db, {
      tenantId: T,
      waPhoneNumber: PHONE,
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: PRODUCTS,
    });
    expect(result.status).toBe("no_prior_order");
    expect(buildReorderReply(result)).toMatch(/couldn't find a previous paid order/i);
  });

  it("never reorders across tenants (ownership)", async () => {
    seedPaidOrder({ tenantId: "tenant-2", customerId: PHONE });
    const result = await buildReorder(db, {
      tenantId: T, // tenant-1 asks; only tenant-2 has an order for this phone
      waPhoneNumber: PHONE,
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: PRODUCTS,
    });
    expect(result.status).toBe("no_prior_order");
  });

  it("resolves orders stored against a customers.id (back-office orders)", async () => {
    (stores.customers ??= []).push({
      id: "cust-9",
      tenantId: T,
      whatsappPhone: PHONE,
      language: "en",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    seedPaidOrder({ customerId: "cust-9" });
    const found = await findLastPaidOrder(db, T, PHONE);
    expect(found?.orderNumber).toBe("ORD-PAID-1");
  });
});
