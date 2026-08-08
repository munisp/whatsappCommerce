/**
 * Promo engine tests.
 *
 * Covers: computeDiscountMinor (percent vs fixed, clamping, negative guard),
 * validatePromo (case-insensitive, expiry, minTotal, maxUses), claim-first
 * applyPromo, chat confirm_order with "use code X" (discount flows into the
 * order total + metadata), and orderCrud.create with a promoCode.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));

import { getDb } from "./db";
import {
  computeDiscountMinor,
  validatePromo,
  applyPromo,
  redeemPromo,
  getPromosFromSettings,
  findPromo,
  type Promo,
} from "./services/promos";
import { createChatOrder, extractPromoCode } from "./routers/nlp";
import { orderCrudRouter } from "./routers/orderCrud";
import { products, cartItems, tenants } from "../drizzle/schema";

// ─── Generic drizzle-SQL parameter extraction (mirrors inventory.test.ts) ────
function sqlParams(v: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (c: unknown): void => {
    if (c == null) return;
    if (Array.isArray(c)) return c.forEach(walk);
    const t = typeof c;
    if (t === "string" || t === "number" || t === "boolean" || c instanceof Date) {
      out.push(c);
      return;
    }
    if (t !== "object") return;
    const o = c as Record<string, unknown>;
    const ctor = (o.constructor as { name?: string } | undefined)?.name;
    if (ctor === "StringChunk" || ctor === "Column") return;
    if (Array.isArray(o.queryChunks)) return walk(o.queryChunks);
    if ("value" in o) {
      out.push(o.value);
      return;
    }
  };
  walk((v as { queryChunks?: unknown[] })?.queryChunks ?? v);
  return out;
}

const SAVE10: Promo = { code: "SAVE10", type: "percent", value: 10, usedCount: 0 };

// ─── Pure discount math ──────────────────────────────────────────────────────
describe("computeDiscountMinor (integer minor units)", () => {
  it("percent: single rounding point", () => {
    expect(computeDiscountMinor({ type: "percent", value: 10 }, 500000)).toBe(50000); // ₦5000.00 → ₦500.00
    expect(computeDiscountMinor({ type: "percent", value: 33 }, 10000)).toBe(3300);
  });
  it("fixed: major → minor exact", () => {
    expect(computeDiscountMinor({ type: "fixed", value: 500 }, 500000)).toBe(50000);
    expect(computeDiscountMinor({ type: "fixed", value: 19.99 }, 500000)).toBe(1999);
  });
  it("clamps so the total can never go negative", () => {
    expect(computeDiscountMinor({ type: "fixed", value: 99999 }, 10000)).toBe(10000);
    expect(computeDiscountMinor({ type: "percent", value: 100 }, 10000)).toBe(10000);
  });
  it("negative guard: bad inputs yield zero discount", () => {
    expect(computeDiscountMinor({ type: "percent", value: -5 }, 10000)).toBe(0);
    expect(computeDiscountMinor({ type: "fixed", value: -100 }, 10000)).toBe(0);
    expect(computeDiscountMinor({ type: "fixed", value: 10 }, -50)).toBe(0);
    expect(computeDiscountMinor({ type: "percent", value: 150 }, 10000)).toBe(10000);
  });
});

// ─── validatePromo / applyPromo against tenant settings ──────────────────────
function settingsDb(settings: unknown, executeResult: unknown[] = [{ id: "t1" }]) {
  const executions: unknown[] = [];
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ settings }]) }),
      }),
    }),
    execute: (q: unknown) => {
      executions.push(q);
      return Promise.resolve(executeResult);
    },
  };
  return { db, executions };
}

describe("validatePromo", () => {
  it("accepts a code case-insensitively and computes the discount", async () => {
    const { db } = settingsDb({ promos: [SAVE10] });
    const r = await validatePromo(db, "t1", "save10", 5000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.promo.code).toBe("SAVE10");
      expect(r.discountMinor).toBe(50000);
      expect(r.discount).toBe("500.00");
    }
  });
  it("rejects unknown codes", async () => {
    const { db } = settingsDb({ promos: [SAVE10] });
    const r = await validatePromo(db, "t1", "NOPE", 5000);
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });
  it("rejects expired codes", async () => {
    const { db } = settingsDb({ promos: [{ ...SAVE10, expiresAt: "2020-01-01T00:00:00Z" }] });
    const r = await validatePromo(db, "t1", "SAVE10", 5000, new Date("2026-01-01"));
    expect(r).toEqual({ ok: false, reason: "expired" });
  });
  it("accepts codes expiring in the future", async () => {
    const { db } = settingsDb({ promos: [{ ...SAVE10, expiresAt: "2999-01-01T00:00:00Z" }] });
    const r = await validatePromo(db, "t1", "SAVE10", 5000, new Date("2026-01-01"));
    expect(r.ok).toBe(true);
  });
  it("enforces minTotal", async () => {
    const { db } = settingsDb({ promos: [{ ...SAVE10, minTotal: 6000 }] });
    expect(await validatePromo(db, "t1", "SAVE10", 5000)).toEqual({ ok: false, reason: "min_total" });
    expect((await validatePromo(db, "t1", "SAVE10", 6000)).ok).toBe(true);
  });
  it("enforces maxUses", async () => {
    const { db } = settingsDb({ promos: [{ ...SAVE10, maxUses: 3, usedCount: 3 }] });
    expect(await validatePromo(db, "t1", "SAVE10", 5000)).toEqual({ ok: false, reason: "max_uses" });
    const { db: db2 } = settingsDb({ promos: [{ ...SAVE10, maxUses: 3, usedCount: 2 }] });
    expect((await validatePromo(db2, "t1", "SAVE10", 5000)).ok).toBe(true);
  });
});

describe("applyPromo (claim-first atomic increment)", () => {
  it("returns true when the guarded UPDATE claims a use", async () => {
    const { db, executions } = settingsDb({ promos: [SAVE10] }, [{ id: "t1" }]);
    expect(await applyPromo(db, "t1", "SAVE10")).toBe(true);
    expect(executions).toHaveLength(1);
  });
  it("returns false when the maxUses guard matches no row", async () => {
    const { db } = settingsDb({ promos: [SAVE10] }, []);
    expect(await applyPromo(db, "t1", "SAVE10")).toBe(false);
  });
  it("redeemPromo downgrades to max_uses when the claim races and loses", async () => {
    const { db } = settingsDb({ promos: [SAVE10] }, []);
    const r = await redeemPromo(db, "t1", "SAVE10", 5000);
    expect(r).toEqual({ ok: false, reason: "max_uses" });
  });
});

describe("settings parsing", () => {
  it("drops malformed entries and finds codes case-insensitively", () => {
    const promos = getPromosFromSettings({
      promos: [SAVE10, { code: "" }, { code: "X", type: "weird", value: 1 }, "junk", { code: "Y", type: "fixed", value: -1 }],
    });
    expect(promos).toHaveLength(1);
    expect(findPromo(promos, "save10")?.code).toBe("SAVE10");
    expect(getPromosFromSettings(null)).toEqual([]);
    expect(getPromosFromSettings({ promos: "nope" })).toEqual([]);
  });
});

describe("extractPromoCode", () => {
  it("parses chat text", () => {
    expect(extractPromoCode("use code SAVE10")).toBe("SAVE10");
    expect(extractPromoCode("2 please, code: FLASH-50")).toBe("FLASH-50");
    expect(extractPromoCode("just confirming my order")).toBeNull();
  });
});

// ─── Chat confirm_order with a promo code ────────────────────────────────────
interface FakeOpts {
  cart?: Array<Record<string, unknown>>;
  productRows?: Array<{ id: string; tenantId: string; name: string; stockQuantity: number }>;
  tenantSettings?: unknown;
  applyPromoResult?: unknown[];
}

function makeChatFakeDb(seed: FakeOpts) {
  const productRows = new Map((seed.productRows ?? []).map((p) => [p.id, { ...p }]));
  const cartRows = (seed.cart ?? []).map((r) => ({ ...r }));
  const inserts: Array<{ table: unknown; row: unknown }> = [];
  const executions: unknown[] = [];

  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    p.limit = (n: number) => Promise.resolve(rows.slice(0, n));
    p.returning = () => Promise.resolve(rows);
    p.onConflictDoNothing = () => Promise.resolve(rows);
    return p;
  };

  const handle: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          const params = sqlParams(cond);
          if (table === cartItems) return chain(cartRows.filter((r) => r.cartSessionId === params[0]));
          if (table === products) {
            const p = productRows.get(params[0] as string);
            return chain(p ? [{ id: p.id, name: p.name, stockQuantity: p.stockQuantity }] : []);
          }
          if (table === tenants) return chain([{ settings: seed.tenantSettings ?? {} }]);
          return chain([]);
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          if (table === products) {
            const [id, tenantId, minQty] = sqlParams(cond) as [string, string, number];
            const delta = Number(sqlParams(vals.stockQuantity)[0] ?? 0);
            const p = productRows.get(id);
            const rows = p && p.tenantId === tenantId && p.stockQuantity >= Number(minQty)
              ? (p.stockQuantity -= delta, [{ id: p.id, name: p.name, stockQuantity: p.stockQuantity }])
              : [];
            return chain(rows);
          }
          return chain([]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return chain([row]);
      },
    }),
    execute: (q: unknown) => {
      executions.push(q);
      return Promise.resolve(seed.applyPromoResult ?? [{ id: "t1" }]);
    },
  };
  handle.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(handle);
  return { db: handle as never, inserts, executions, getProduct: (id: string) => productRows.get(id) };
}

const CHAT_CART = [
  { id: "ci-1", cartSessionId: "cart-1", productId: "p1", productName: "Spicy Chicken Wrap", quantity: 2, unitPrice: "2500.00", currency: "NGN" },
];

describe("chat confirm_order with promo code", () => {
  it("applies the discount: total, order row, metadata, usage claim", async () => {
    const fake = makeChatFakeDb({
      cart: CHAT_CART,
      productRows: [{ id: "p1", tenantId: "t1", name: "Spicy Chicken Wrap", stockQuantity: 5 }],
      tenantSettings: { promos: [SAVE10] },
    });
    const result = await createChatOrder(fake.db, {
      tenantId: "t1",
      waPhoneNumber: "2348011111111",
      cartSessionId: "cart-1",
      fulfillment: "pickup",
      address: null,
      promoCode: extractPromoCode("yes confirm, use code save10"),
    });
    expect(result.created).toBe(true);
    expect(result.subtotal).toBe(5000);
    expect(result.promo).toEqual({ code: "SAVE10", discount: 500 });
    expect(result.total).toBe(4500); // discounted total flows to the payment link
    const orderInsert = fake.inserts.find((i) => (i.row as Record<string, unknown>).orderNumber);
    expect(orderInsert).toBeDefined();
    const row = orderInsert!.row as Record<string, unknown>;
    expect(row.totalAmount).toBe("4500.00");
    expect((row.metadata as Record<string, unknown>).promo).toMatchObject({ code: "SAVE10", discount: "500.00" });
    // Usage claimed exactly once (after the order transaction).
    expect(fake.executions).toHaveLength(1);
  });

  it("rejects an unknown code but still creates the order at full price", async () => {
    const fake = makeChatFakeDb({
      cart: CHAT_CART,
      productRows: [{ id: "p1", tenantId: "t1", name: "Spicy Chicken Wrap", stockQuantity: 5 }],
      tenantSettings: { promos: [SAVE10] },
    });
    const result = await createChatOrder(fake.db, {
      tenantId: "t1",
      waPhoneNumber: "2348011111111",
      cartSessionId: "cart-1",
      fulfillment: "pickup",
      address: null,
      promoCode: "BOGUS",
    });
    expect(result.created).toBe(true);
    expect(result.promo ?? null).toBeNull();
    expect(result.promoError).toMatch(/BOGUS/);
    expect(result.total).toBe(5000);
    expect(fake.executions).toHaveLength(0); // no usage claimed for a bad code
  });
});

// ─── orderCrud.create with promoCode ─────────────────────────────────────────
const ADMIN_CTX = { user: { id: 1, role: "admin", tenantId: null } } as any;

describe("orderCrud.create with promoCode", () => {
  beforeEach(() => vi.clearAllMocks());

  const input = {
    tenantId: "t1",
    customerId: "cust-1",
    items: [{ productId: "p1", productName: "Widget", quantity: 2, unitPrice: 2500 }],
  };

  it("applies a valid fixed promo to totalAmount + metadata", async () => {
    const fake = makeChatFakeDb({
      productRows: [{ id: "p1", tenantId: "t1", name: "Widget", stockQuantity: 5 }],
      tenantSettings: { promos: [{ code: "FLAT500", type: "fixed", value: 500, usedCount: 0 }] },
      applyPromoResult: [{ id: "t1" }],
    });
    vi.mocked(getDb).mockResolvedValue(fake.db);
    const caller = orderCrudRouter.createCaller(ADMIN_CTX);
    const r = await caller.create({ ...input, promoCode: "flat500" });
    expect(r.total).toBe(4500);
    expect(r.discount).toBe(500);
    expect(r.promo?.code).toBe("FLAT500");
    const orderInsert = fake.inserts.find((i) => (i.row as Record<string, unknown>).orderNumber);
    expect((orderInsert!.row as Record<string, unknown>).totalAmount).toBe("4500.00");
    expect(((orderInsert!.row as Record<string, unknown>).metadata as Record<string, unknown>).promo).toMatchObject({ code: "FLAT500" });
  });

  it("rejects an invalid code with BAD_REQUEST before any order row", async () => {
    const fake = makeChatFakeDb({
      productRows: [{ id: "p1", tenantId: "t1", name: "Widget", stockQuantity: 5 }],
      tenantSettings: { promos: [] },
    });
    vi.mocked(getDb).mockResolvedValue(fake.db);
    const caller = orderCrudRouter.createCaller(ADMIN_CTX);
    await expect(caller.create({ ...input, promoCode: "NOPE" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fake.inserts).toHaveLength(0);
  });

  it("works without a promoCode (behavior unchanged)", async () => {
    const fake = makeChatFakeDb({
      productRows: [{ id: "p1", tenantId: "t1", name: "Widget", stockQuantity: 5 }],
    });
    vi.mocked(getDb).mockResolvedValue(fake.db);
    const caller = orderCrudRouter.createCaller(ADMIN_CTX);
    const r = await caller.create(input);
    expect(r.total).toBe(5000);
    expect(r.discount).toBe(0);
    expect(r.promo).toBeNull();
  });
});
