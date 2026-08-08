/**
 * Inventory reservation guard — unit tests (migration 0031).
 *
 * Core invariant under test: NEVER take payment for items that don't exist
 * in stock, robust to any commerce race.
 *
 *   a. concurrent reserve race — two checkouts for the last 1 unit → exactly
 *      one wins, stock never goes negative, loser's transaction rolls back;
 *   b. chat confirm_order with a shortage → no order row, no payment link,
 *      reply names the shortages and the adjusted available cart;
 *   c. reserve → commit happy path (paymentConfirm success semantics);
 *   d. cancel → stock restored;
 *   e. sweeper releases expired reservations for unpaid orders only;
 *   f. double-release is idempotent (claim-first).
 *
 * The fake db below is NOT a stub that always succeeds: it honors the
 * conditional-update semantics of the real queries (UPDATE ... WHERE
 * stockQuantity >= qty RETURNING matches zero rows when stock is short), so
 * the race/guard logic is provably exercised.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAvailability,
  reserveStock,
  commitReservations,
  releaseReservations,
  releaseExpiredReservations,
  InsufficientStockError,
  RESERVATION_TTL_MS,
} from "./services/inventory";
import { createChatOrder, buildShortageReply } from "./routers/nlp";
import {
  products,
  orders,
  cartItems,
  inventoryReservations,
} from "../drizzle/schema";

// ─── Generic drizzle-SQL parameter extraction ────────────────────────────────
// Walks a drizzle SQL/condition object and returns the bound parameter values
// in order (numbers/strings/Dates are embedded raw in sql`` templates; eq/lt
// wrap values in Param). StringChunks and Columns are skipped.
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

// ─── In-memory store with real conditional-update semantics ──────────────────
interface ProductRow {
  id: string;
  tenantId: string;
  name: string;
  stockQuantity: number;
}
interface ReservationRow {
  id: string;
  tenantId: string;
  orderId: string;
  productId: string;
  qty: number;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

function makeFakeDb(seed: {
  products?: ProductRow[];
  orders?: Array<{ id: string; paymentStatus: string }>;
  cartItems?: Array<Record<string, unknown>>;
  reservations?: ReservationRow[];
}) {
  let productRows = new Map((seed.products ?? []).map((p) => [p.id, { ...p }]));
  let reservationRows: ReservationRow[] = (seed.reservations ?? []).map((r) => ({ ...r }));
  const orderRows = new Map((seed.orders ?? []).map((o) => [o.id, { ...o }]));
  const cartRows = (seed.cartItems ?? []).map((r) => ({ ...r }));
  const inserts: Array<{ table: unknown; row: unknown }> = [];

  type Undo = () => void;

  /** Atomic conditional product update — mirrors PG row-lock semantics. */
  const updateProducts = (log: Undo[] | null, vals: Record<string, unknown>, cond: unknown): unknown[] => {
    const whereParams = sqlParams(cond);
    const setQtyParams = sqlParams(vals.stockQuantity);
    const delta = Number(setQtyParams[0] ?? 0);
    if (whereParams.length >= 3) {
      // reserveStock: UPDATE ... WHERE id=? AND tenantId=? AND stockQuantity >= ?
      const [id, tenantId, minQty] = whereParams as [string, string, number];
      const p = productRows.get(id);
      if (!p || p.tenantId !== tenantId || p.stockQuantity < Number(minQty)) return [];
      const prev = p.stockQuantity;
      p.stockQuantity -= delta; // check + decrement is ONE atomic step
      log?.push(() => { p.stockQuantity = prev; });
      return [{ id: p.id, name: p.name, stockQuantity: p.stockQuantity }];
    }
    // releaseReservations restock: UPDATE ... WHERE id = ?
    const [id] = whereParams as [string];
    const p = productRows.get(id);
    if (!p) return [];
    const prev = p.stockQuantity;
    p.stockQuantity += delta;
    log?.push(() => { p.stockQuantity = prev; });
    return [{ id: p.id, stockQuantity: p.stockQuantity }];
  };

  const updateReservations = (log: Undo[] | null, vals: Record<string, unknown>, cond: unknown): unknown[] => {
    const whereParams = sqlParams(cond);
    const orderId = whereParams[0] as string;
    if (vals.status === "committed") {
      const hit = reservationRows.filter((r) => r.orderId === orderId && r.status === "reserved");
      hit.forEach((r) => {
        log?.push(((row) => () => { row.status = "reserved"; })(r));
        r.status = "committed";
      });
      return hit.map((r) => ({ id: r.id }));
    }
    if (vals.status === "released") {
      // Claim-first: flip exactly ONE still-reserved row (SKIP LOCKED winner).
      const row = reservationRows.find((r) => r.orderId === orderId && r.status === "reserved");
      if (!row) return [];
      log?.push(() => { row.status = "reserved"; });
      row.status = "released";
      return [{ id: row.id, productId: row.productId, qty: row.qty }];
    }
    return [];
  };

  const chain = (result: unknown[] | Promise<unknown[]>) => {
    const p = Promise.resolve(result) as Promise<unknown[]> & Record<string, unknown>;
    p.returning = () => Promise.resolve(result);
    p.limit = (n: number) => Promise.resolve((Array.isArray(result) ? result : []).slice(0, n));
    p.onConflictDoNothing = () => Promise.resolve(result);
    return p;
  };

  const buildHandle = (log: Undo[] | null): Record<string, unknown> => {
    const handle: Record<string, unknown> = {
      select: (_fields?: unknown) => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => {
            const params = sqlParams(cond);
            if (table === products) {
              const [id, tenantId] = params as [string, string?];
              const p = productRows.get(id);
              const rows = p && (tenantId === undefined || p.tenantId === tenantId)
                ? [{ id: p.id, name: p.name, stockQuantity: p.stockQuantity }]
                : [];
              return chain(rows);
            }
            if (table === orders) {
              const [id] = params as [string];
              const o = orderRows.get(id);
              return chain(o ? [{ paymentStatus: o.paymentStatus }] : []);
            }
            if (table === cartItems) {
              const [cartSessionId] = params as [string];
              return chain(cartRows.filter((r) => r.cartSessionId === cartSessionId));
            }
            if (table === inventoryReservations) {
              // sweeper: status='reserved' AND expiresAt < now → distinct orderIds
              const now = params[1] as Date;
              const ids = [...new Set(
                reservationRows
                  .filter((r) => r.status === "reserved" && r.expiresAt < now)
                  .map((r) => r.orderId),
              )];
              return chain(ids.map((orderId) => ({ orderId })));
            }
            return chain([]);
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            if (table === products) return chain(updateProducts(log, vals, cond));
            if (table === inventoryReservations) return chain(updateReservations(log, vals, cond));
            return chain([]);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          if (table === inventoryReservations) {
            const stored = { ...(row as ReservationRow) };
            reservationRows.push(stored);
            log?.push(() => {
              reservationRows = reservationRows.filter((r) => r !== stored);
            });
          }
          return chain([row]);
        },
      }),
      execute: () => Promise.resolve([]),
    };
    handle.selectDistinct = (fields?: unknown) => (handle.select as (f?: unknown) => unknown)(fields);
    return handle;
  };

  const db = buildHandle(null);
  // Rollback semantics: each tx gets its own undo log; a throw replays ONLY
  // that tx's writes in reverse — exactly like PG rolling back one
  // transaction while a concurrent committed transaction's writes survive.
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const log: Undo[] = [];
    const tx = buildHandle(log);
    try {
      return await fn(tx);
    } catch (err) {
      for (const undo of [...log].reverse()) undo();
      throw err;
    }
  };

  return {
    db: db as never,
    inserts,
    getProduct: (id: string) => productRows.get(id),
    getReservations: () => reservationRows.map((r) => ({ ...r })),
  };
}

const T = "tenant-1";

// ─── a. Concurrent reserve race for the last unit ────────────────────────────
describe("reserveStock race safety", () => {
  it("two concurrent reserves for the last 1 unit → exactly one succeeds, stock never negative", async () => {
    const fake = makeFakeDb({
      products: [{ id: "p1", tenantId: T, name: "Last Widget", stockQuantity: 1 }],
    });
    const reserveInTx = (orderId: string) =>
      (fake.db as { transaction: (fn: (tx: never) => Promise<void>) => Promise<void> }).transaction(
        (tx) => reserveStock(tx, T, orderId, [{ productId: "p1", qty: 1 }]),
      );

    const results = await Promise.allSettled([reserveInTx("order-A"), reserveInTx("order-B")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockError);
    // Stock hit exactly zero — never negative — and only the winner's
    // reservation survived (the loser's whole transaction rolled back).
    expect(fake.getProduct("p1")!.stockQuantity).toBe(0);
    const res = fake.getReservations();
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe("reserved");
    expect(res[0].qty).toBe(1);
  });

  it("a later short item rolls back the WHOLE order tx (earlier reservation undone)", async () => {
    const fake = makeFakeDb({
      products: [
        { id: "p1", tenantId: T, name: "Widget", stockQuantity: 5 },
        { id: "p2", tenantId: T, name: "Rare Gadget", stockQuantity: 0 },
      ],
    });
    await expect(
      (fake.db as { transaction: (fn: (tx: never) => Promise<void>) => Promise<void> }).transaction(
        (tx) => reserveStock(tx, T, "order-X", [
          { productId: "p1", qty: 2 },  // succeeds inside the tx...
          { productId: "p2", qty: 1 },  // ...then this fails
        ]),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    // Rollback: p1 stock restored, no reservation rows survived.
    expect(fake.getProduct("p1")!.stockQuantity).toBe(5);
    expect(fake.getReservations()).toHaveLength(0);
  });

  it("reservation rows carry a 15-minute expiry", async () => {
    const fake = makeFakeDb({
      products: [{ id: "p1", tenantId: T, name: "Widget", stockQuantity: 5 }],
    });
    const now = new Date();
    await reserveStock(fake.db, T, "order-1", [{ productId: "p1", qty: 2 }], now);
    const [r] = fake.getReservations();
    expect(r.expiresAt.getTime() - now.getTime()).toBe(RESERVATION_TTL_MS);
    expect(RESERVATION_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("checkAvailability reports named shortages without mutating stock", async () => {
    const fake = makeFakeDb({
      products: [
        { id: "p1", tenantId: T, name: "Widget", stockQuantity: 1 },
        { id: "p2", tenantId: T, name: "Gadget", stockQuantity: 0 },
      ],
    });
    const r = await checkAvailability(fake.db, T, [
      { productId: "p1", qty: 3 },
      { productId: "p2", qty: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.shortages).toEqual([
      { productId: "p1", name: "Widget", requested: 3, available: 1 },
      { productId: "p2", name: "Gadget", requested: 1, available: 0 },
    ]);
    expect(fake.getProduct("p1")!.stockQuantity).toBe(1); // untouched
  });
});

// ─── b. Chat confirm_order with shortage → no payment link ───────────────────
describe("chat checkout inventory guard", () => {
  const cart = [
    {
      id: "ci-1", cartSessionId: "cart-1", productId: "p1", productName: "Spicy Chicken Wrap",
      quantity: 2, unitPrice: "2500.00", currency: "NGN",
    },
    {
      id: "ci-2", cartSessionId: "cart-1", productId: "p2", productName: "Chapman",
      quantity: 1, unitPrice: "1500.00", currency: "NGN",
    },
  ];

  it("shortage → no order row, no payment transaction, reply lists shortages + adjusted cart", async () => {
    const fake = makeFakeDb({
      products: [
        { id: "p1", tenantId: T, name: "Spicy Chicken Wrap", stockQuantity: 1 }, // need 2
        { id: "p2", tenantId: T, name: "Chapman", stockQuantity: 9 },
      ],
      cartItems: cart,
    });
    const result = await createChatOrder(fake.db, {
      tenantId: T,
      waPhoneNumber: "2348012345678",
      cartSessionId: "cart-1",
      fulfillment: "pickup",
      address: null,
    });

    expect(result.created).toBe(false);
    expect(result.shortages).toEqual([
      { productId: "p1", name: "Spicy Chicken Wrap", requested: 2, available: 1 },
    ]);
    expect(result.availableItems?.map((i) => i.productName)).toEqual(["Chapman"]);
    expect(result.paymentUrl ?? null).toBeNull();
    // NOTHING was persisted: no order, no reservation, no payment link row.
    expect(fake.inserts).toHaveLength(0);
    expect(fake.getReservations()).toHaveLength(0);
    expect(fake.getProduct("p1")!.stockQuantity).toBe(1);

    // The buyer-facing reply names the shortage and the still-available cart,
    // and contains no payment link.
    const reply = buildShortageReply(result.shortages!, result.availableItems ?? [], result.currency ?? "NGN");
    expect(reply).toMatch(/Spicy Chicken Wrap/);
    expect(reply).toMatch(/only 1 left/);
    expect(reply).toMatch(/Chapman/);
    expect(reply).not.toMatch(/complete payment/i);
  });

  it("full availability → order + reservation in one transaction, stock decremented", async () => {
    const fake = makeFakeDb({
      products: [
        { id: "p1", tenantId: T, name: "Spicy Chicken Wrap", stockQuantity: 5 },
        { id: "p2", tenantId: T, name: "Chapman", stockQuantity: 9 },
      ],
      cartItems: cart,
    });
    const result = await createChatOrder(fake.db, {
      tenantId: T,
      waPhoneNumber: "2348012345678",
      cartSessionId: "cart-1",
      fulfillment: "pickup",
      address: null,
    });
    expect(result.created).toBe(true);
    expect(fake.getProduct("p1")!.stockQuantity).toBe(3); // 5 - 2
    expect(fake.getProduct("p2")!.stockQuantity).toBe(8); // 9 - 1
    const res = fake.getReservations();
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.orderId === result.orderId && r.status === "reserved")).toBe(true);
    // the order row insert happened inside the same transaction
    expect(fake.inserts.some((i) => i.table === orders)).toBe(true);
  });
});

// ─── c/d/f. reserve → commit / cancel → restock / idempotent release ─────────
describe("reservation lifecycle", () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(async () => {
    fake = makeFakeDb({
      products: [{ id: "p1", tenantId: T, name: "Widget", stockQuantity: 5 }],
    });
    await reserveStock(fake.db, T, "order-1", [{ productId: "p1", qty: 2 }]);
  });

  it("c. commit (payment confirmed) flips reserved → committed, stock stays decremented", async () => {
    expect(fake.getProduct("p1")!.stockQuantity).toBe(3);
    const n = await commitReservations(fake.db, "order-1");
    expect(n).toBe(1);
    expect(fake.getReservations()[0].status).toBe("committed");
    expect(fake.getProduct("p1")!.stockQuantity).toBe(3);
    // replay-safe: committing again is a no-op
    expect(await commitReservations(fake.db, "order-1")).toBe(0);
  });

  it("d. cancel releases the reservation and restores stock", async () => {
    const n = await releaseReservations(fake.db, "order-1");
    expect(n).toBe(1);
    expect(fake.getReservations()[0].status).toBe("released");
    expect(fake.getProduct("p1")!.stockQuantity).toBe(5); // 3 + 2 back
  });

  it("f. double-release is idempotent — stock credited back exactly once", async () => {
    await releaseReservations(fake.db, "order-1");
    const again = await releaseReservations(fake.db, "order-1");
    expect(again).toBe(0);
    expect(fake.getProduct("p1")!.stockQuantity).toBe(5); // NOT 7
    // concurrent cancel + sweeper race: still exactly one restock
    const fake2 = makeFakeDb({
      products: [{ id: "p1", tenantId: T, name: "Widget", stockQuantity: 5 }],
    });
    await reserveStock(fake2.db, T, "order-9", [{ productId: "p1", qty: 2 }]);
    const [r1, r2] = await Promise.all([
      releaseReservations(fake2.db, "order-9"),
      releaseReservations(fake2.db, "order-9"),
    ]);
    expect(r1 + r2).toBe(1);
    expect(fake2.getProduct("p1")!.stockQuantity).toBe(5);
  });
});

// ─── e. Expiry sweeper ───────────────────────────────────────────────────────
describe("releaseExpiredReservations sweeper", () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);

  it("releases expired reservations for UNPAID orders and restocks", async () => {
    const fake = makeFakeDb({
      products: [{ id: "p1", tenantId: T, name: "Widget", stockQuantity: 3 }],
      orders: [{ id: "order-exp", paymentStatus: "unpaid" }],
      reservations: [{
        id: "r1", tenantId: T, orderId: "order-exp", productId: "p1", qty: 2,
        status: "reserved", expiresAt: past, createdAt: past,
      }],
    });
    const r = await releaseExpiredReservations(fake.db);
    expect(r).toEqual({ orders: 1, released: 1 });
    expect(fake.getReservations()[0].status).toBe("released");
    expect(fake.getProduct("p1")!.stockQuantity).toBe(5);
    // idempotent: a second sweep finds nothing
    const r2 = await releaseExpiredReservations(fake.db);
    expect(r2).toEqual({ orders: 0, released: 0 });
    expect(fake.getProduct("p1")!.stockQuantity).toBe(5);
  });

  it("never releases stock for a PAID order, and ignores unexpired holds", async () => {
    const fake = makeFakeDb({
      products: [{ id: "p1", tenantId: T, name: "Widget", stockQuantity: 3 }],
      orders: [
        { id: "order-paid", paymentStatus: "completed" },
        { id: "order-fresh", paymentStatus: "unpaid" },
      ],
      reservations: [
        {
          id: "r1", tenantId: T, orderId: "order-paid", productId: "p1", qty: 2,
          status: "reserved", expiresAt: past, createdAt: past,
        },
        {
          id: "r2", tenantId: T, orderId: "order-fresh", productId: "p1", qty: 1,
          status: "reserved", expiresAt: future, createdAt: new Date(),
        },
      ],
    });
    const r = await releaseExpiredReservations(fake.db);
    expect(r).toEqual({ orders: 0, released: 0 });
    expect(fake.getReservations().map((x) => x.status)).toEqual(["reserved", "reserved"]);
    expect(fake.getProduct("p1")!.stockQuantity).toBe(3);
  });
});
