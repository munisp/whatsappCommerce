/**
 * Contact auto-provisioning tests: webhook-entry upsert reuses the shared
 * customers helper (single normalization), fills name only when empty, and
 * meters new-customer creations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./redis", () => ({ getRedis: vi.fn().mockResolvedValue(null) }));

import { upsertCustomerByPhone } from "./routers/customers";
import { provisionInboundContact } from "./services/waContacts";
import { METRIC_CUSTOMERS_CREATED } from "./services/metering";

beforeEach(() => vi.clearAllMocks());

describe("upsertCustomerByPhone", () => {
  /**
   * Hand-rolled db that mimics the helper's query sequence:
   *   1) SELECT … WHERE tenant+phone LIMIT 1
   *   2) (on miss) INSERT … ON CONFLICT DO NOTHING
   *   3) SELECT … WHERE tenant+phone LIMIT 1
   */
  function helperDb(existing: any = null) {
    const state = { row: existing, inserted: null as any, updated: null as any };
    const db: any = {
      select: vi.fn(() => {
        const c: any = {
          from: vi.fn(() => c),
          where: vi.fn(() => c),
          limit: vi.fn(() => Promise.resolve(state.row ? [state.row] : [])),
        };
        return c;
      }),
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => ({
          onConflictDoNothing: vi.fn(() => {
            state.inserted = v;
            state.row = { ...v };
            return Promise.resolve();
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((patch: any) => ({
          where: vi.fn(() => {
            state.updated = patch;
            if (state.row) Object.assign(state.row, patch);
            return Promise.resolve();
          }),
        })),
      })),
    };
    return { db, state };
  }

  it("normalizes the phone (digits-only) on create", async () => {
    const { db, state } = helperDb(null);
    const res = await upsertCustomerByPhone(db, { tenantId: "t1", whatsappPhone: "+234 801 555 0000", name: "Ada" });
    expect(res.created).toBe(true);
    expect(state.inserted.whatsappPhone).toBe("2348015550000");
    expect(state.inserted.name).toBe("Ada");
  });

  it("returns the existing row and fills an empty name only with nameIfEmpty", async () => {
    const existing = { id: "c1", tenantId: "t1", whatsappPhone: "2348015550000", name: null };
    const { db, state } = helperDb(existing);
    const res = await upsertCustomerByPhone(db, {
      tenantId: "t1", whatsappPhone: "2348015550000", name: "Ada Lovelace", nameIfEmpty: true,
    });
    expect(res.created).toBe(false);
    expect(state.updated.name).toBe("Ada Lovelace");
  });

  it("never overwrites an existing name", async () => {
    const existing = { id: "c1", tenantId: "t1", whatsappPhone: "1", name: "Grace" };
    const { db, state } = helperDb(existing);
    const res = await upsertCustomerByPhone(db, { tenantId: "t1", whatsappPhone: "1", name: "New Name", nameIfEmpty: true });
    expect(res.created).toBe(false);
    expect(state.updated).toBeNull();
    expect(res.customer.name).toBe("Grace");
  });

  it("rejects phones without digits", async () => {
    const { db } = helperDb(null);
    await expect(upsertCustomerByPhone(db, { tenantId: "t1", whatsappPhone: "abc" })).rejects.toThrow("digits");
  });
});

describe("provisionInboundContact", () => {
  it("creates the customer, meters customers_created, and never throws", async () => {
    const state = { row: null as any };
    const usageRows: any[] = [];
    const db: any = {
      select: vi.fn(() => {
        const c: any = {
          from: vi.fn(() => c),
          where: vi.fn(() => c),
          limit: vi.fn(() => Promise.resolve(state.row ? [state.row] : [])),
        };
        return c;
      }),
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          // usage_counters insert has onConflictDoUpdate; customers insert has
          // onConflictDoNothing.
          if (v.metric) usageRows.push(v);
          else state.row = { ...v };
          return {
            onConflictDoNothing: vi.fn(() => Promise.resolve()),
            onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ count: 1 }])) })),
          };
        }),
      })),
    };
    const res = await provisionInboundContact(db, "t1", "+234 801 555", "  Ada  ");
    expect(res?.created).toBe(true);
    expect(state.row.whatsappPhone).toBe("234801555");
    expect(state.row.name).toBe("Ada");
    expect(usageRows[0]?.metric).toBe(METRIC_CUSTOMERS_CREATED);
  });

  it("does not meter when the customer already exists", async () => {
    const state = { row: { id: "c1", tenantId: "t1", whatsappPhone: "234801555", name: "Grace" } };
    const usageRows: any[] = [];
    const db: any = {
      select: vi.fn(() => {
        const c: any = {
          from: vi.fn(() => c),
          where: vi.fn(() => c),
          limit: vi.fn(() => Promise.resolve([state.row])),
        };
        return c;
      }),
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          usageRows.push(v);
          return { onConflictDoNothing: vi.fn(() => Promise.resolve()) };
        }),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    };
    const res = await provisionInboundContact(db, "t1", "234801555", "Other");
    expect(res).toEqual({ customerId: "c1", created: false });
    expect(usageRows).toHaveLength(0);
  });

  it("returns null (never throws) when the db blows up", async () => {
    const db: any = {
      select: vi.fn(() => { throw new Error("boom"); }),
    };
    expect(await provisionInboundContact(db, "t1", "123", "x")).toBeNull();
  });
});
