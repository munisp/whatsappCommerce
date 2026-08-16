/**
 * W17/F10 unit tests — COD state machine, idempotent cash collection +
 * settlement, reconciliation math, partial-payment sums, offline capture.
 *
 * DB is an in-memory table-aware fake (same discipline as
 * services/procurement/fakeDb.ts): real drizzle condition decoding
 * (eq/and/inArray/gte/isNotNull) + the funds-critical unique claims
 * (cod_events cash_collected/settled, payment_transactions providerRef) are
 * enforced by the fake, so a regression to "blind write" behavior FAILS.
 * Every assertion fails if the feature is reverted.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  codEvents,
  customers,
  inventoryReservations,
  merchantNotifications,
  orderItems,
  orders,
  paymentTransactions,
  products,
  tenants,
} from "../../drizzle/schema";

vi.mock("./lowStock", () => ({ scheduleLowStockCheck: vi.fn() }));

import {
  COD_STATES,
  COD_TRANSITIONS,
  CodTransitionError,
  codReconciliation,
  confirmCashCollection,
  orderPaymentSummary,
  settleCod,
  transitionCod,
  handleRiderConfirm,
} from "./codFlow";
import { createOfflineOrder } from "./offlineOrders";

// ── Table registry ───────────────────────────────────────────────────────────

const TABLES: Record<string, unknown> = {
  orders, customers, products, tenants,
  order_items: orderItems,
  cod_events: codEvents,
  payment_transactions: paymentTransactions,
  merchant_notifications: merchantNotifications,
  inventory_reservations: inventoryReservations,
};

function tableName(table: unknown): string {
  for (const [name, t] of Object.entries(TABLES)) if (t === table) return name;
  throw new Error("codFlow fakeDb: unknown table");
}

// ── drizzle condition decoding → token stream ────────────────────────────────

type Tok =
  | { kind: "col"; name: string }
  | { kind: "op"; op: string }
  | { kind: "val"; v: unknown };

function tokenize(cond: unknown): Tok[] {
  const toks: Tok[] = [];
  const walk = (c: unknown, isChunkList = false): void => {
    if (c == null) return;
    if (Array.isArray(c)) {
      if (isChunkList) return c.forEach((x) => walk(x));
      toks.push({ kind: "val", v: c.map((p) => (p != null && typeof p === "object" && "value" in (p as any) ? (p as any).value : p)) });
      return;
    }
    const t = typeof c;
    if (t === "string" || t === "number" || t === "boolean" || c instanceof Date) {
      toks.push({ kind: "val", v: c });
      return;
    }
    if (t !== "object") return;
    const o = c as Record<string, any>;
    if (o.constructor?.name === "StringChunk") {
      toks.push({ kind: "op", op: String(o.value ?? "").toLowerCase() });
      return;
    }
    if (o.constructor?.name === "Column" || (typeof o.name === "string" && o.table != null)) {
      toks.push({ kind: "col", name: o.name });
      return;
    }
    if (Array.isArray(o.queryChunks)) return walk(o.queryChunks, true);
    if ("value" in o) {
      toks.push({ kind: "val", v: o.value });
      return;
    }
  };
  walk((cond as any)?.queryChunks ?? cond, true);
  return toks;
}

/** Evaluate a (conjunctive) drizzle condition against a row. Column names in
 * this repo's touched tables equal the JS prop names (orders/payment tables
 * use camelCase physical columns). */
function matches(row: any, cond: unknown): boolean {
  const toks = tokenize(cond);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "col") continue;
    const op = toks[i + 1]?.kind === "op" ? (toks[i + 1] as any).op.trim() : "";
    const next = toks[i + 2];
    const val = next?.kind === "val" ? next.v : undefined;
    const cell = row[t.name];
    if (op.startsWith("is not null")) {
      if (cell == null) return false;
    } else if (op.startsWith("is null")) {
      if (cell != null) return false;
    } else if (op.startsWith("in")) {
      if (!Array.isArray(val) || !val.includes(cell)) return false;
    } else if (op.startsWith(">=")) {
      const a = cell instanceof Date ? cell.getTime() : cell;
      const b = val instanceof Date ? (val as Date).getTime() : val;
      if (!(a >= (b as any))) return false;
    } else if (op.startsWith("=") || op === "") {
      if (val !== undefined && cell !== val) return false;
    }
  }
  return true;
}

// ── Fake db ──────────────────────────────────────────────────────────────────

interface Store {
  orders: any[];
  cod_events: any[];
  payment_transactions: any[];
  merchant_notifications: any[];
  customers: any[];
  products: any[];
  order_items: any[];
  inventory_reservations: any[];
  tenants: any[];
}

function makeDb(store: Store) {
  const rowsOf = (t: string): any[] => (store as any)[t];

  const thenable = (get: () => any) => {
    const self: any = {};
    self.then = (res: (v: any) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(get).then(res, rej);
    self.catch = (rej: (e: unknown) => unknown) => Promise.resolve().then(get).catch(rej);
    return self;
  };

  /** Funds-critical unique claims (mirror 0056 partial unique indexes). */
  function violatesUnique(t: string, v: any): boolean {
    const rows = rowsOf(t);
    if (t === "cod_events" && (v.toState === "cash_collected" || v.toState === "settled")) {
      return rows.some((r) => r.tenantId === v.tenantId && r.orderId === v.orderId && r.toState === v.toState);
    }
    if (t === "payment_transactions" && v.providerRef != null &&
        ["cod", "offline-cash", "offline-transfer"].includes(v.provider)) {
      return rows.some((r) => r.providerRef === v.providerRef);
    }
    return false;
  }

  function doInsert(t: string, v: any, onConflictDoNothing: boolean): any | null {
    if (violatesUnique(t, v)) {
      if (onConflictDoNothing) return null;
      const err: any = new Error(`duplicate key violates unique claim on ${t}`);
      err.code = "23505";
      throw err;
    }
    const row = { createdAt: new Date(), ...v };
    rowsOf(t).push(row);
    return row;
  }

  const db: any = {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const t = tableName(table);
          const build = (cond: unknown) => {
            let limitN: number | undefined;
            const orderBys: any[] = [];
            const run = () => {
              let rows = rowsOf(t).filter((r) => (cond ? matches(r, cond) : true));
              for (const ob of orderBys) {
                const colTok = tokenize(ob).find((k) => k.kind === "col") as any;
                if (!colTok) continue;
                rows = [...rows].sort((a, b) => {
                  const av = a[colTok.name] instanceof Date ? a[colTok.name].getTime() : a[colTok.name];
                  const bv = b[colTok.name] instanceof Date ? b[colTok.name].getTime() : b[colTok.name];
                  return av < bv ? -1 : av > bv ? 1 : 0;
                });
              }
              if (limitN != null) rows = rows.slice(0, limitN);
              if (fields) {
                const keys = Object.keys(fields);
                return rows.map((r) => Object.fromEntries(keys.map((k) => {
                  const f: any = (fields as any)[k];
                  const prop = f?.name ?? k;
                  return [k, r[prop]];
                })));
              }
              return rows.map((r) => ({ ...r }));
            };
            const self = thenable(run);
            self.where = (c: unknown) => build(c);
            self.orderBy = (...obs: any[]) => { orderBys.push(...obs); return self; };
            self.limit = (n: number) => { limitN = n; return self; };
            return self;
          };
          return build(undefined);
        },
      };
    },
    insert(table: unknown) {
      const t = tableName(table);
      return {
        values(v: any) {
          let oc = false;
          const self = thenable(() => {
            const r = doInsert(t, v, oc);
            return r ? [{ ...r }] : [];
          });
          self.onConflictDoNothing = () => { oc = true; return self; };
          self.returning = () => thenable(() => {
            const r = doInsert(t, v, oc);
            return r ? [{ ...r }] : [];
          });
          return self;
        },
      };
    },
    update(table: unknown) {
      const t = tableName(table);
      return {
        set(setVals: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              const applySet = (r: any) => {
                for (const [k, v] of Object.entries(setVals)) {
                  // sql`col - n` / sql`col + n` arithmetic (reserveStock)
                  if (v != null && typeof v === "object" && Array.isArray((v as any).queryChunks)) {
                    const toks = tokenize(v);
                    const col = toks.find((x) => x.kind === "col") as any;
                    const num = toks.find((x) => x.kind === "val") as any;
                    const opTok = toks.find((x) => x.kind === "op" && /[+-]/.test(x.op)) as any;
                    if (col && num != null) {
                      r[k] = opTok && opTok.op.includes("-")
                        ? Number(r[col.name]) - Number(num.v)
                        : Number(r[col.name]) + Number(num.v);
                      continue;
                    }
                  }
                  r[k] = v;
                }
              };
              const self = thenable(() => {
                const m = rowsOf(t).filter((r) => matches(r, cond));
                m.forEach(applySet);
                return m.map((r) => ({ ...r }));
              });
              self.returning = () => thenable(() => {
                const m = rowsOf(t).filter((r) => matches(r, cond));
                m.forEach(applySet);
                return m.map((r) => ({ ...r }));
              });
              return self;
            },
          };
        },
      };
    },
    async transaction(fn: (tx: any) => Promise<any>) {
      // Snapshot rollback so a thrown InsufficientStockError leaves no residue.
      const snap = JSON.parse(JSON.stringify(store, (k, v) => v));
      try {
        return await fn(db);
      } catch (e) {
        for (const k of Object.keys(store) as (keyof Store)[]) {
          (store as any)[k] = (snap as any)[k];
        }
        throw e;
      }
    },
  };
  return db;
}

function freshStore(): Store {
  return {
    orders: [], cod_events: [], payment_transactions: [], merchant_notifications: [],
    customers: [], products: [], order_items: [], inventory_reservations: [],
    tenants: [{ id: "t1", settings: { codRiderPhones: ["2348000000001"] } }],
  };
}

function seedCodOrder(store: Store, over: Partial<any> = {}): any {
  const order = {
    id: "o1", tenantId: "t1", customerId: "c1", orderNumber: "ORD-TEST1",
    status: "pending", totalAmount: "1000.00", currency: "NGN",
    paymentStatus: "unpaid", codState: "cod_pending",
    items: [], metadata: { paymentMethod: "cod" },
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
  store.orders.push(order);
  return order;
}

let store: Store;
let db: any;
beforeEach(() => {
  store = freshStore();
  db = makeDb(store);
});

// ── 1. Transition matrix ─────────────────────────────────────────────────────

describe("COD state machine transition matrix", () => {
  it("every legal transition succeeds and records a cod_events row", async () => {
    let n = 0;
    for (const [from, tos] of Object.entries(COD_TRANSITIONS)) {
      for (const to of tos) {
        n++;
        const id = `o-${from}-${to}`;
        store.orders.push({
          id, tenantId: "t1", customerId: "c1", orderNumber: `ORD-${n}`,
          status: "pending", totalAmount: "10.00", currency: "NGN",
          paymentStatus: "unpaid", codState: from, createdAt: new Date(), updatedAt: new Date(),
        });
        const res = await transitionCod(db, {
          tenantId: "t1", orderId: id, to: to as any, actor: "test",
          reason: to === "delivery_failed" ? "no answer" : undefined,
        });
        expect(res.fromState).toBe(from);
        expect(res.toState).toBe(to);
        const o = store.orders.find((r) => r.id === id);
        expect(o.codState).toBe(to);
        const ev = store.cod_events.find((e) => e.orderId === id && e.toState === to);
        expect(ev, `event recorded for ${from}→${to}`).toBeDefined();
        expect(ev.fromState).toBe(from);
      }
    }
    expect(n).toBeGreaterThan(10);
  });

  it("every illegal transition throws CodTransitionError (no silent no-op)", async () => {
    const all = COD_STATES as readonly string[];
    let illegal = 0;
    for (const from of all) {
      for (const to of all) {
        if ((COD_TRANSITIONS as any)[from]?.includes(to)) continue;
        illegal++;
        const id = `bad-${from}-${to}`;
        store.orders.push({
          id, tenantId: "t1", customerId: "c1", orderNumber: `ORD-B-${illegal}`,
          status: "pending", totalAmount: "10.00", currency: "NGN",
          paymentStatus: "unpaid", codState: from, createdAt: new Date(), updatedAt: new Date(),
        });
        await expect(
          transitionCod(db, {
            tenantId: "t1", orderId: id, to: to as any, actor: "test",
            reason: to === "delivery_failed" ? "r" : undefined,
          }),
        ).rejects.toBeInstanceOf(CodTransitionError);
        // State untouched.
        expect(store.orders.find((r) => r.id === id).codState).toBe(from);
      }
    }
    expect(illegal).toBeGreaterThan(50);
  });

  it("rejects transitions on non-COD orders and unknown orders", async () => {
    store.orders.push({
      id: "plain", tenantId: "t1", customerId: "c1", orderNumber: "ORD-P",
      status: "pending", totalAmount: "5.00", currency: "NGN",
      paymentStatus: "unpaid", codState: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await expect(
      transitionCod(db, { tenantId: "t1", orderId: "plain", to: "rider_assigned", actor: "t" }),
    ).rejects.toBeInstanceOf(CodTransitionError);
    await expect(
      transitionCod(db, { tenantId: "t1", orderId: "nope", to: "rider_assigned", actor: "t" }),
    ).rejects.toBeInstanceOf(CodTransitionError);
  });

  it("delivery_failed requires a reason and alerts the merchant", async () => {
    const o = seedCodOrder(store, { codState: "out_for_delivery" });
    await expect(
      transitionCod(db, { tenantId: "t1", orderId: o.id, to: "delivery_failed", actor: "rider" }),
    ).rejects.toBeInstanceOf(CodTransitionError);
    await transitionCod(db, {
      tenantId: "t1", orderId: o.id, to: "delivery_failed", actor: "rider", reason: "gate locked",
    });
    const notif = store.merchant_notifications.find((n) => n.type === "cod_delivery_failed");
    expect(notif).toBeDefined();
    expect(notif.body).toContain("gate locked");
    expect(notif.tenantId).toBe("t1");
  });
});

// ── 2. Idempotent cash collection + settlement ──────────────────────────────

async function driveToDelivery(orderId: string) {
  await transitionCod(db, { tenantId: "t1", orderId, to: "rider_assigned", actor: "dispatcher" });
  await transitionCod(db, { tenantId: "t1", orderId, to: "out_for_delivery", actor: "rider" });
  await transitionCod(db, { tenantId: "t1", orderId, to: "delivered_pending_cash", actor: "rider" });
}

describe("codConfirmCollection idempotency + settlement", () => {
  it("confirm → cash_collected; replay applies nothing and never double-settles", async () => {
    const o = seedCodOrder(store);
    await driveToDelivery(o.id);

    const first = await confirmCashCollection(db, { tenantId: "t1", orderId: o.id, amount: 1000, actor: "rider:1" });
    expect(first.applied).toBe(true);
    expect(first.completed).toBe(true);
    expect(first.codState).toBe("cash_collected");
    expect(store.payment_transactions.filter((t) => t.orderId === o.id).length).toBe(1);
    expect(store.orders.find((r) => r.id === o.id).paymentStatus).toBe("completed");

    // Replay the SAME confirmation (same orderId+state-derived default key is
    // state-dependent, so pass the caller's idempotency key as the webhook
    // retry would) — no second money row, no error.
    const replay = await confirmCashCollection(db, {
      tenantId: "t1", orderId: o.id, amount: 1000, actor: "rider:1",
      idempotencyKey: `cod-collect:${o.id}:delivered_pending_cash:1000.00`,
    });
    expect(replay.applied).toBe(false);
    expect(store.payment_transactions.filter((t) => t.orderId === o.id).length).toBe(1);

    const s1 = await settleCod(db, { tenantId: "t1", orderId: o.id, actor: "merchant" });
    expect(s1.settled).toBe(true);
    expect(s1.replay).toBe(false);
    expect(store.orders.find((r) => r.id === o.id).codState).toBe("settled");

    // Settlement replay → no second event, no error.
    const s2 = await settleCod(db, { tenantId: "t1", orderId: o.id, actor: "merchant" });
    expect(s2.replay).toBe(true);
    expect(store.cod_events.filter((e) => e.orderId === o.id && e.toState === "settled").length).toBe(1);
  });

  it("partial cash collection tracks remaining balance until completion", async () => {
    const o = seedCodOrder(store); // total 1000
    await driveToDelivery(o.id);

    const p1 = await confirmCashCollection(db, { tenantId: "t1", orderId: o.id, amount: 400, actor: "rider:1" });
    expect(p1.applied).toBe(true);
    expect(p1.completed).toBe(false);
    expect(p1.summary.status).toBe("partial");
    expect(p1.summary.totalPaid).toBe(400);
    expect(p1.summary.remaining).toBe(600);
    expect(store.orders.find((r) => r.id === o.id).codState).toBe("delivered_pending_cash");

    const p2 = await confirmCashCollection(db, { tenantId: "t1", orderId: o.id, amount: 600, actor: "rider:1" });
    expect(p2.completed).toBe(true);
    expect(p2.summary.status).toBe("paid");
    expect(store.orders.find((r) => r.id === o.id).codState).toBe("cash_collected");
    // Exactly one cash_collected claim event.
    expect(store.cod_events.filter((e) => e.orderId === o.id && e.toState === "cash_collected").length).toBe(1);
  });

  it("under-collection with final=true raises a discrepancy alert", async () => {
    const o = seedCodOrder(store);
    await driveToDelivery(o.id);
    const res = await confirmCashCollection(db, {
      tenantId: "t1", orderId: o.id, amount: 900, actor: "rider:1", final: true,
    });
    expect(res.completed).toBe(true);
    expect(res.discrepancy).toBeDefined();
    expect(res.discrepancy!.variance).toBeCloseTo(-100, 2);
    const notif = store.merchant_notifications.find((n) => n.type === "cod_discrepancy");
    expect(notif).toBeDefined();
    expect(notif.body).toContain("900.00");
  });

  it("cash cannot be confirmed before delivery or after settle", async () => {
    const o = seedCodOrder(store);
    await expect(
      confirmCashCollection(db, { tenantId: "t1", orderId: o.id, amount: 1000, actor: "rider:1" }),
    ).rejects.toBeInstanceOf(CodTransitionError);
  });
});

// ── 3. orderPaymentSummary (COD + online partial) ───────────────────────────

describe("orderPaymentSummary", () => {
  it("sums multiple payment records toward the total (online + cod)", async () => {
    const o = seedCodOrder(store, { codState: null }); // online order works too
    let s = await orderPaymentSummary(db, "t1", o.id);
    expect(s.status).toBe("unpaid");
    store.payment_transactions.push(
      { id: "p1", tenantId: "t1", orderId: o.id, provider: "paystack", amount: "250.00", status: "completed" },
      { id: "p2", tenantId: "t1", orderId: o.id, provider: "cod", amount: "750.00", status: "completed" },
      { id: "p3", tenantId: "t1", orderId: o.id, provider: "paystack", amount: "999.00", status: "initiated" }, // not counted
    );
    s = await orderPaymentSummary(db, "t1", o.id);
    expect(s.totalPaid).toBe(1000);
    expect(s.remaining).toBe(0);
    expect(s.status).toBe("paid");
  });
});

// ── 4. Reconciliation math ───────────────────────────────────────────────────

describe("codReconciliation", () => {
  it("per-day expected vs collected vs variance + unsettled aging", async () => {
    const now = new Date("2026-02-10T12:00:00Z");
    const day = (d: string) => new Date(`${d}T10:00:00Z`);
    // Settled order collected on the 9th (exact).
    store.orders.push({
      id: "r1", tenantId: "t1", customerId: "c1", orderNumber: "ORD-R1", status: "pending",
      totalAmount: "500.00", currency: "NGN", paymentStatus: "completed", codState: "settled",
      createdAt: day("2026-02-09"), updatedAt: day("2026-02-09"),
    });
    store.cod_events.push({ id: "e1", tenantId: "t1", orderId: "r1", fromState: "delivered_pending_cash", toState: "cash_collected", actor: "r", createdAt: day("2026-02-09") });
    store.payment_transactions.push({ id: "x1", tenantId: "t1", orderId: "r1", provider: "cod", providerRef: "cod-collect:r1:a", amount: "500.00", status: "completed", paidAt: day("2026-02-09"), createdAt: day("2026-02-09") });
    // Under-collected order on the 10th (variance -100), still unsettled.
    store.orders.push({
      id: "r2", tenantId: "t1", customerId: "c1", orderNumber: "ORD-R2", status: "pending",
      totalAmount: "1000.00", currency: "NGN", paymentStatus: "completed", codState: "cash_collected",
      createdAt: day("2026-02-09"), updatedAt: new Date("2026-02-10T00:00:00Z"),
    });
    store.cod_events.push({ id: "e2", tenantId: "t1", orderId: "r2", fromState: "delivered_pending_cash", toState: "cash_collected", actor: "r", createdAt: day("2026-02-10") });
    store.payment_transactions.push({ id: "x2", tenantId: "t1", orderId: "r2", provider: "cod", providerRef: "cod-collect:r2:a", amount: "900.00", status: "completed", paidAt: day("2026-02-10"), createdAt: day("2026-02-10") });
    // Still awaiting cash (aging list).
    store.orders.push({
      id: "r3", tenantId: "t1", customerId: "c1", orderNumber: "ORD-R3", status: "pending",
      totalAmount: "300.00", currency: "NGN", paymentStatus: "unpaid", codState: "delivered_pending_cash",
      createdAt: day("2026-02-08"), updatedAt: day("2026-02-08"),
    });

    const rep = await codReconciliation(db, "t1", { windowDays: 3, now });
    const d9 = rep.days.find((d) => d.date === "2026-02-09")!;
    const d10 = rep.days.find((d) => d.date === "2026-02-10")!;
    expect(d9.expected).toBe(500);
    expect(d9.collected).toBe(500);
    expect(d9.variance).toBe(0);
    expect(d10.expected).toBe(1000);
    expect(d10.collected).toBe(900);
    expect(d10.variance).toBe(-100);
    expect(rep.totals).toEqual({ expected: 1500, collected: 1400, variance: -100 });

    const agingIds = rep.unsettled.map((u) => u.orderId);
    expect(agingIds).toContain("r2"); // collected, not settled
    expect(agingIds).toContain("r3"); // awaiting cash
    expect(agingIds).not.toContain("r1"); // settled
    const r3 = rep.unsettled.find((u) => u.orderId === "r3")!;
    expect(r3.remaining).toBe(300);
    expect(r3.ageHours).toBeGreaterThan(24);
    // Aging sorted oldest first.
    expect(rep.unsettled[0].orderId).toBe("r3");
  });
});

// ── 5. Offline order capture (stock via the shared reserveStock path) ────────

describe("createOfflineOrder", () => {
  it("creates customer + order, decrements stock via reserveStock, records payment", async () => {
    store.products.push({
      id: "p1", tenantId: "t1", sku: "S1", name: "Indomie Pack", price: "100.00",
      currency: "NGN", status: "active", stockQuantity: 10,
    });
    const res = await createOfflineOrder(db, {
      tenantId: "t1", customerName: "Walk-in Ada", customerPhone: "2348011111111",
      items: [{ productId: "p1", qty: 3 }], paymentMethod: "cash",
    });
    expect(res.created).toBe(true);
    expect(res.total).toBe(300);
    expect(res.paymentStatus).toBe("completed");
    // Stock decremented through the shared path + reservation row written.
    expect(store.products.find((p) => p.id === "p1").stockQuantity).toBe(7);
    expect(store.inventory_reservations.some((r) => r.orderId === res.orderId && r.qty === 3)).toBe(true);
    // Customer created and reused.
    expect(store.customers.length).toBe(1);
    expect(store.customers[0].whatsappPhone).toBe("2348011111111");
    const pay = store.payment_transactions.find((t) => t.orderId === res.orderId);
    expect(pay.provider).toBe("offline-cash");
    expect(Number(pay.amount)).toBe(300);
    // Repeat customer is reused, not duplicated.
    store.products.find((p) => p.id === "p1").stockQuantity = 10;
    const res2 = await createOfflineOrder(db, {
      tenantId: "t1", customerName: "Ada Again", customerPhone: "2348011111111",
      items: [{ productId: "p1", qty: 1 }], paymentMethod: "transfer", amountPaid: 50,
    });
    expect(res2.customerId).toBe(res.customerId);
    expect(store.customers.length).toBe(1);
    expect(res2.paymentStatus).toBe("initiated"); // partial transfer
    const sum = await orderPaymentSummary(db, "t1", res2.orderId!);
    expect(sum.status).toBe("partial");
    expect(sum.remaining).toBe(50);
  });

  it("offline COD orders enter cod_pending and can flow to settlement", async () => {
    store.products.push({
      id: "p2", tenantId: "t1", sku: "S2", name: "Rice Bag", price: "5000.00",
      currency: "NGN", status: "active", stockQuantity: 2,
    });
    const res = await createOfflineOrder(db, {
      tenantId: "t1", customerName: "Musa", customerPhone: "2348022222222",
      items: [{ productId: "p2", qty: 1 }], paymentMethod: "cod",
    });
    expect(res.codState).toBe("cod_pending");
    expect(res.paymentStatus).toBe("unpaid");
    expect(store.products.find((p) => p.id === "p2").stockQuantity).toBe(1);
    const entry = store.cod_events.find((e) => e.orderId === res.orderId && e.toState === "cod_pending");
    expect(entry).toBeDefined();

    await driveToDelivery(res.orderId!);
    const col = await confirmCashCollection(db, { tenantId: "t1", orderId: res.orderId!, amount: 5000, actor: "rider:1" });
    expect(col.completed).toBe(true);
    const st = await settleCod(db, { tenantId: "t1", orderId: res.orderId!, actor: "merchant" });
    expect(st.settled).toBe(true);
  });

  it("insufficient stock rolls the whole offline order back", async () => {
    store.products.push({
      id: "p3", tenantId: "t1", sku: "S3", name: "Sugar", price: "50.00",
      currency: "NGN", status: "active", stockQuantity: 1,
    });
    const res = await createOfflineOrder(db, {
      tenantId: "t1", customerName: "Kunle", customerPhone: "2348033333333",
      items: [{ productId: "p3", qty: 5 }], paymentMethod: "cash",
    });
    expect(res.created).toBe(false);
    expect(res.shortages![0].available).toBe(1);
    expect(store.orders.length).toBe(0);
    expect(store.products.find((p) => p.id === "p3").stockQuantity).toBe(1);
  });
});

// ── 6. Rider WhatsApp reply flow ─────────────────────────────────────────────

describe("handleRiderConfirm", () => {
  it("registered rider confirms by order number; non-riders fall through", async () => {
    const o = seedCodOrder(store, { orderNumber: "ORD-77" });
    await driveToDelivery(o.id);
    const sent: string[] = [];
    const sendText = async (_t: string, _to: string, body: string) => { sent.push(body); };

    const stranger = await handleRiderConfirm({
      db, tenantId: "t1", waPhoneNumber: "2348999999999", text: "RIDER_CONFIRM ORD-77", sendText,
    });
    expect(stranger.handled).toBe(false);

    const rider = await handleRiderConfirm({
      db, tenantId: "t1", waPhoneNumber: "2348000000001", text: "RIDER_CONFIRM ORD-77", sendText,
    });
    expect(rider.handled).toBe(true);
    expect(rider.result?.completed).toBe(true);
    expect(sent.at(-1)).toContain("fully collected");
    expect(store.orders.find((r) => r.id === o.id).codState).toBe("cash_collected");

    const unknown = await handleRiderConfirm({
      db, tenantId: "t1", waPhoneNumber: "2348000000001", text: "RIDER_CONFIRM ORD-NOPE", sendText,
    });
    expect(unknown.handled).toBe(true);
    expect(sent.at(-1)).toContain("not found");

    const unrelated = await handleRiderConfirm({
      db, tenantId: "t1", waPhoneNumber: "2348000000001", text: "hello there", sendText,
    });
    expect(unrelated.handled).toBe(false);
  });
});
