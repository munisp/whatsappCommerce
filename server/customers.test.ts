/**
 * customers.create tests: phone normalization, (tenantId, whatsappPhone)
 * upsert/duplicate handling, tenant isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));

import { getDb } from "./db";
import { customersRouter } from "./routers/customers";

function makeDb(existingRow: any | null, createdRow?: any) {
  const inserted: any[] = [];
  let selectCalls = 0;
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            selectCalls++;
            // First select = duplicate check; second = post-insert re-read
            // (returns the inserted row, so created=id match holds).
            return Promise.resolve(
              selectCalls === 1 ? (existingRow ? [existingRow] : []) : [createdRow ?? inserted[0] ?? existingRow],
            );
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return { onConflictDoNothing: () => Promise.resolve([]) };
      }),
    })),
  };
  return { db, inserted };
}

const ADMIN_CTX = { user: { id: 1, role: "admin", tenantId: null } } as any;
const TENANT_CTX = { user: { id: 2, role: "user", tenantId: "t1" } } as any;

beforeEach(() => vi.clearAllMocks());

describe("customers.create", () => {
  it("creates a new customer with a normalized phone", async () => {
    const { db, inserted } = makeDb(null);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = customersRouter.createCaller(ADMIN_CTX);
    const r = await caller.create({ tenantId: "t1", whatsappPhone: "+234 801-111-1111", name: "Ada" });
    expect(r.created).toBe(true);
    expect(r.customer.whatsappPhone).toBe("2348011111111");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].whatsappPhone).toBe("2348011111111");
    expect(inserted[0].tenantId).toBe("t1");
  });

  it("returns the existing row on duplicate (upsert), no insert", async () => {
    const existing = { id: "existing-id", tenantId: "t1", whatsappPhone: "2348011111111", name: "Ada" };
    const { db, inserted } = makeDb(existing);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = customersRouter.createCaller(ADMIN_CTX);
    const r = await caller.create({ tenantId: "t1", whatsappPhone: "+2348011111111" });
    expect(r.created).toBe(false);
    expect(r.customer.id).toBe("existing-id");
    expect(inserted).toHaveLength(0);
  });

  it("rejects phones without digits", async () => {
    const { db } = makeDb(null);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = customersRouter.createCaller(ADMIN_CTX);
    await expect(caller.create({ tenantId: "t1", whatsappPhone: "abc-def" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("enforces tenant isolation for non-admin callers", async () => {
    const { db } = makeDb(null);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = customersRouter.createCaller(TENANT_CTX);
    await expect(caller.create({ tenantId: "other-tenant", whatsappPhone: "234801" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await caller.create({ tenantId: "t1", whatsappPhone: "234801" });
    expect(ok.created).toBe(true);
  });
});
