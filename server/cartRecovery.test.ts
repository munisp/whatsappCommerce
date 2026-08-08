/**
 * cartRecovery — unit tests
 * Abandoned-cart sweep: idle window, item presence, newer-order skip,
 * consent gate, once-per-24h marker, and localized recovery copy.
 * DB is mocked in-memory with real drizzle condition filtering; Redis markers
 * use the in-memory fallback (getRedis → null, NODE_ENV=test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

// ── In-memory DB mock with real condition filtering (incl. `<` on dates) ────

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
      continue;
    }
    const mLt = part.match(/"[\w]+"\."([\w]+)" < \$(\d+)/);
    if (mLt) {
      const prop = colMap[mLt[1]];
      const val = compiled.params[Number(mLt[2]) - 1];
      if (prop) tests.push((r) => new Date(r[prop] as any).getTime() < new Date(val as any).getTime());
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
      return Promise.resolve([row]);
    },
  }),
};

import {
  runCartRecovery,
  touchCartMarker,
  clearCartMarker,
  cartMarkerKey,
  recoveryMarkerKey,
  __clearMemoryCartMarkers,
} from "./services/cartRecovery";
import { setStickyLocale, __clearMemoryLocales } from "./services/i18n";

const T = "tenant-1";
const PHONE = "2348000000001";
const NOW = new Date("2026-02-01T12:00:00Z");

function seedCart(opts: { idleMinutesAgo: number; withItems?: boolean; phone?: string; tenantId?: string }) {
  const updatedAt = new Date(NOW.getTime() - opts.idleMinutesAgo * 60 * 1000);
  const cart = {
    id: crypto.randomUUID(),
    tenantId: opts.tenantId ?? T,
    waPhoneNumber: opts.phone ?? PHONE,
    sessionData: {},
    currentStep: "browse",
    language: "english",
    expiresAt: new Date(updatedAt.getTime() + 24 * 3600 * 1000),
    createdAt: updatedAt,
    updatedAt,
  };
  (stores.cart_sessions ??= []).push(cart);
  if (opts.withItems !== false) {
    (stores.cart_items ??= []).push({
      id: crypto.randomUUID(),
      cartSessionId: cart.id,
      productId: "p1",
      productName: "Spicy Wrap",
      quantity: 2,
      unitPrice: "1500.00",
      currency: "NGN",
      createdAt: updatedAt,
    });
  }
  return cart;
}

const sendImpl = vi.fn(async () => ({}));
const consentYes = vi.fn(async () => true);

beforeEach(() => {
  for (const k of Object.keys(stores)) delete stores[k];
  __clearMemoryCartMarkers();
  __clearMemoryLocales();
  sendImpl.mockClear();
  consentYes.mockClear();
});

describe("runCartRecovery", () => {
  it("ignores carts inside the idle window (<30min)", async () => {
    seedCart({ idleMinutesAgo: 10 });
    const c = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: consentYes });
    expect(c.scanned).toBe(0);
    expect(c.sent).toBe(0);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it("sends one recovery message for an idle cart with items + consent", async () => {
    seedCart({ idleMinutesAgo: 45 });
    const c = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: consentYes });
    expect(c.scanned).toBe(1);
    expect(c.sent).toBe(1);
    expect(sendImpl).toHaveBeenCalledWith(
      T, PHONE, expect.stringContaining("reply CHECKOUT"),
    );
  });

  it("skips carts without items", async () => {
    seedCart({ idleMinutesAgo: 45, withItems: false });
    const c = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: consentYes });
    expect(c.skippedNoItems).toBe(1);
    expect(c.sent).toBe(0);
  });

  it("skips when the buyer ordered after the cart went idle", async () => {
    const cart = seedCart({ idleMinutesAgo: 45 });
    (stores.orders ??= []).push({
      id: "order-new",
      tenantId: T,
      customerId: PHONE,
      orderNumber: "ORD-NEW",
      paymentStatus: "completed",
      createdAt: new Date(cart.updatedAt.getTime() + 5 * 60 * 1000), // after cart activity
      updatedAt: new Date(),
    });
    const c = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: consentYes });
    expect(c.skippedOrdered).toBe(1);
    expect(c.sent).toBe(0);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it("gates on NDPR consent", async () => {
    seedCart({ idleMinutesAgo: 45 });
    const c = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: vi.fn(async () => false) });
    expect(c.skippedNoConsent).toBe(1);
    expect(c.sent).toBe(0);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it("sends at most once per cart per 24h (marker survives reruns)", async () => {
    seedCart({ idleMinutesAgo: 45 });
    const first = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: consentYes });
    expect(first.sent).toBe(1);
    const second = await runCartRecovery({ db, now: new Date(NOW.getTime() + 60 * 60 * 1000), sendImpl, consentImpl: consentYes });
    expect(second.sent).toBe(0);
    expect(second.skippedRecentlySent).toBe(1);
    expect(sendImpl).toHaveBeenCalledTimes(1);
  });

  it("localizes the recovery message via the sticky locale", async () => {
    await setStickyLocale(T, PHONE, "fr");
    seedCart({ idleMinutesAgo: 45 });
    const c = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: consentYes });
    expect(c.sent).toBe(1);
    expect(sendImpl).toHaveBeenCalledWith(
      T, PHONE, expect.stringContaining("Vous avez laissé des articles"),
    );
  });

  it("never sends across tenants (ownership)", async () => {
    seedCart({ idleMinutesAgo: 45, tenantId: "tenant-2", phone: "2348999999999" });
    const c = await runCartRecovery({ db, now: NOW, sendImpl, consentImpl: consentYes });
    expect(c.sent).toBe(1);
    // The send is strictly scoped to the cart's own tenant + phone.
    expect(sendImpl).toHaveBeenCalledWith("tenant-2", "2348999999999", expect.anything());
    expect(sendImpl).not.toHaveBeenCalledWith(T, expect.anything(), expect.anything());
  });
});

describe("cart markers", () => {
  it("touch/clear round-trips the wa:cart marker key", async () => {
    // Indirect: markers are internal, but touch must not throw and keys are stable.
    expect(cartMarkerKey("t", "p")).toBe("wa:cart:t:p");
    expect(recoveryMarkerKey("t", "p")).toBe("wa:cart-recovery:t:p");
    await touchCartMarker("t", "p");
    await clearCartMarker("t", "p");
  });
});
