/**
 * Back-in-stock waitlist + low-stock admin alert tests.
 *
 * Waitlist: subscribe (idempotent dedupe + re-arm), notify-on-restock
 * (0→>0 fan-out, per-entry notifiedAt stamp, no re-notify), STOP unsubscribe.
 * Low-stock: alert fires below threshold exactly once per 6h dedupe window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return { ...orig, sendWhatsAppText: vi.fn() };
});

import { getDb } from "./db";
import { sendWhatsAppText } from "./services/waSender";
import {
  subscribeToWaitlist,
  unsubscribeFromWaitlist,
  notifyWaitlistOnRestock,
  triggerRestockNotification,
} from "./services/waitlist";
import { maybeSendLowStockAlert, resetLowStockDedupeForTests } from "./services/lowStock";
import { products, tenants, waitlistEntries } from "../drizzle/schema";

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

interface WaitlistRow {
  id: string;
  tenantId: string;
  productId: string;
  phone: string;
  createdAt: Date;
  notifiedAt: Date | null;
}

function makeDb(seed: {
  products?: Array<{ id: string; tenantId: string; name: string; stockQuantity: number; lowStockThreshold?: number | null }>;
  waitlist?: WaitlistRow[];
  tenantSettings?: Record<string, unknown>;
}) {
  const productRows = new Map((seed.products ?? []).map((p) => [p.id, { ...p }]));
  const waitlistRows: WaitlistRow[] = (seed.waitlist ?? []).map((r) => ({ ...r }));
  const settings = seed.tenantSettings ?? {};

  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    p.limit = (n: number) => Promise.resolve(rows.slice(0, n));
    p.returning = () => Promise.resolve(rows);
    p.onConflictDoNothing = () => Promise.resolve(rows);
    return p;
  };

  const db: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          const params = sqlParams(cond);
          if (table === products) {
            const p = productRows.get(params[0] as string);
            return chain(p ? [{ ...p }] : []);
          }
          if (table === tenants) return chain([{ settings }]);
          if (table === waitlistEntries) {
            // notifyWaitlistOnRestock: (tenantId, productId, notifiedAt IS NULL)
            const [tenantId, productId] = params as [string, string];
            return chain(waitlistRows.filter(
              (r) => r.tenantId === tenantId && r.productId === productId && r.notifiedAt === null,
            ));
          }
          return chain([]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === waitlistEntries) {
          const r = row as WaitlistRow;
          const exists = waitlistRows.some(
            (w) => w.tenantId === r.tenantId && w.productId === r.productId && w.phone === r.phone,
          );
          // onConflictDoNothing on the unique (tenantId, productId, phone)
          return { onConflictDoNothing: () => Promise.resolve(exists ? [] : (waitlistRows.push(r), [r])) };
        }
        return { onConflictDoNothing: () => Promise.resolve([row]) };
      },
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const params = sqlParams(cond);
          if (table === waitlistEntries) {
            if (params.length === 1) {
              // stamp by id
              const row = waitlistRows.find((r) => r.id === params[0]);
              if (row && "notifiedAt" in vals) row.notifiedAt = vals.notifiedAt as Date | null;
              return chain(row ? [row] : []);
            }
            // re-arm by (tenantId, productId, phone)
            const [tenantId, productId, phone] = params as [string, string, string];
            const hits = waitlistRows.filter(
              (r) => r.tenantId === tenantId && r.productId === productId && r.phone === phone,
            );
            hits.forEach((r) => { if ("notifiedAt" in vals) r.notifiedAt = vals.notifiedAt as Date | null; });
            return chain(hits);
          }
          return chain([]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        const params = sqlParams(cond);
        if (table === waitlistEntries) {
          const [tenantId, phone, productId] = params as [string, string, string?];
          const hits = waitlistRows.filter(
            (r) => r.tenantId === tenantId && r.phone === phone && (!productId || r.productId === productId),
          );
          hits.forEach((h) => waitlistRows.splice(waitlistRows.indexOf(h), 1));
          return chain(hits.map((h) => ({ id: h.id })));
        }
        return chain([]);
      },
    }),
  };
  return { db: db as never, waitlistRows, getProduct: (id: string) => productRows.get(id) };
}

const T = "t1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWhatsAppText).mockResolvedValue({ sent: true, simulated: false, wamids: ["w"], chunks: 1 });
});

describe("waitlist subscribe", () => {
  it("records a new subscription and dedupes repeats", async () => {
    const { db, waitlistRows } = makeDb({});
    expect(await subscribeToWaitlist(db, T, "p1", "+234 801-111-1111")).toBe(true);
    expect(await subscribeToWaitlist(db, T, "p1", "2348011111111")).toBe(true);
    expect(waitlistRows).toHaveLength(1); // unique (tenant, product, phone)
    expect(waitlistRows[0].phone).toBe("2348011111111"); // normalized
  });

  it("re-arms a previously-notified entry on re-subscribe", async () => {
    const { db, waitlistRows } = makeDb({
      waitlist: [{ id: "w1", tenantId: T, productId: "p1", phone: "234801", createdAt: new Date(), notifiedAt: new Date() }],
    });
    await subscribeToWaitlist(db, T, "p1", "234801");
    expect(waitlistRows).toHaveLength(1);
    expect(waitlistRows[0].notifiedAt).toBeNull();
  });

  it("rejects phone numbers without digits", async () => {
    const { db, waitlistRows } = makeDb({});
    expect(await subscribeToWaitlist(db, T, "p1", "not-a-phone")).toBe(false);
    expect(waitlistRows).toHaveLength(0);
  });
});

describe("waitlist notify on restock", () => {
  const products = [{ id: "p1", tenantId: T, name: "Spicy Wrap", stockQuantity: 7 }];

  it("notifies all unnotified entries exactly once and stamps notifiedAt", async () => {
    const { db, waitlistRows } = makeDb({
      products,
      waitlist: [
        { id: "w1", tenantId: T, productId: "p1", phone: "234801", createdAt: new Date(), notifiedAt: null },
        { id: "w2", tenantId: T, productId: "p1", phone: "234802", createdAt: new Date(), notifiedAt: null },
        { id: "w3", tenantId: T, productId: "p1", phone: "234803", createdAt: new Date(), notifiedAt: new Date() }, // already notified
      ],
    });
    const r = await notifyWaitlistOnRestock(db, T, "p1");
    expect(r).toEqual({ notified: 2, failed: 0 });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(2);
    const body = vi.mocked(sendWhatsAppText).mock.calls[0][2];
    expect(body).toMatch(/Spicy Wrap/);
    expect(body).toMatch(/STOP/);
    expect(waitlistRows.find((w) => w.id === "w1")!.notifiedAt).not.toBeNull();
    expect(waitlistRows.find((w) => w.id === "w2")!.notifiedAt).not.toBeNull();

    // Second restock pass: nothing left to notify.
    const r2 = await notifyWaitlistOnRestock(db, T, "p1");
    expect(r2).toEqual({ notified: 0, failed: 0 });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(2);
  });

  it("does not notify when the product is still out of stock", async () => {
    const { db } = makeDb({
      products: [{ id: "p1", tenantId: T, name: "Wrap", stockQuantity: 0 }],
      waitlist: [{ id: "w1", tenantId: T, productId: "p1", phone: "234801", createdAt: new Date(), notifiedAt: null }],
    });
    expect(await notifyWaitlistOnRestock(db, T, "p1")).toEqual({ notified: 0, failed: 0 });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("triggerRestockNotification fires only on a 0→>0 transition", async () => {
    const { db } = makeDb({
      products,
      waitlist: [{ id: "w1", tenantId: T, productId: "p1", phone: "234801", createdAt: new Date(), notifiedAt: null }],
    });
    await triggerRestockNotification(db, T, "p1", 3, 7); // not a restock-from-zero
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    await triggerRestockNotification(db, T, "p1", 0, 7); // restock
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
});

describe("waitlist STOP unsubscribe", () => {
  it("removes all entries for the phone (tenant-scoped)", async () => {
    const { db, waitlistRows } = makeDb({
      waitlist: [
        { id: "w1", tenantId: T, productId: "p1", phone: "234801", createdAt: new Date(), notifiedAt: null },
        { id: "w2", tenantId: T, productId: "p2", phone: "234801", createdAt: new Date(), notifiedAt: null },
        { id: "w3", tenantId: "other-tenant", productId: "p1", phone: "234801", createdAt: new Date(), notifiedAt: null },
      ],
    });
    const removed = await unsubscribeFromWaitlist(db, T, "+234 801");
    expect(removed).toBe(2);
    expect(waitlistRows).toHaveLength(1);
    expect(waitlistRows[0].tenantId).toBe("other-tenant"); // tenant isolation
  });
});

// ─── Low-stock admin alerts ──────────────────────────────────────────────────
describe("low-stock admin alerts", () => {
  beforeEach(() => resetLowStockDedupeForTests());

  const product = { id: "p1", tenantId: T, name: "Spicy Wrap", stockQuantity: 2, lowStockThreshold: 5 };

  it("alerts the admin once per 6h dedupe window when below threshold", async () => {
    const { db } = makeDb({
      products: [product],
      tenantSettings: { adminPhone: "+2349000000000", inventory: { lowStockThreshold: 5 } },
    });
    vi.mocked(getDb).mockResolvedValue(db);
    await maybeSendLowStockAlert(T, "p1");
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    const [tenantId, toPhone, body] = vi.mocked(sendWhatsAppText).mock.calls[0];
    expect(tenantId).toBe(T);
    expect(toPhone).toBe("+2349000000000");
    expect(body).toMatch(/Spicy Wrap/);
    expect(body).toMatch(/2 unit/);

    // Deduped: same product within the window does not re-alert.
    await maybeSendLowStockAlert(T, "p1");
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });

  it("does not alert above the threshold", async () => {
    const { db } = makeDb({
      products: [{ ...product, stockQuantity: 20 }],
      tenantSettings: { adminPhone: "+2349000000000", inventory: { lowStockThreshold: 5 } },
    });
    vi.mocked(getDb).mockResolvedValue(db);
    await maybeSendLowStockAlert(T, "p1");
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("does not alert without an adminPhone configured", async () => {
    const { db } = makeDb({ products: [product], tenantSettings: {} });
    vi.mocked(getDb).mockResolvedValue(db);
    await maybeSendLowStockAlert(T, "p1");
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});
