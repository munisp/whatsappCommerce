/**
 * W12 authz — tenantInvite.create / .resend.
 * Invite-minting is restricted to admins (platform admins via the
 * assertTenantAccess bypass); non-admin and cross-tenant callers get 403.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { tenantInviteRouter } from "../tenantInvite";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const tenantRow = { id: T1, name: "Tenant One", whatsappPhoneNumberId: "pn-1" };

function makeDb(rows: any[] = [tenantRow]) {
  const p = Promise.resolve(rows);
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => p), then: (r: any, j: any) => p.then(r, j) })),
      })),
    })),
  } as any;
}

const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
const TENANT_USER = { user: { id: 2, role: "user", tenantId: T1 } } as any;

beforeEach(() => vi.clearAllMocks());

describe("tenantInvite.create", () => {
  it("rejects a non-admin tenant user minting an invite for their own tenant", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb() as any);
    const caller = tenantInviteRouter.createCaller(TENANT_USER);
    await expect(caller.create({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a non-admin user minting an invite for another tenant", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb() as any);
    const caller = tenantInviteRouter.createCaller(TENANT_USER);
    await expect(caller.create({ tenantId: T2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated callers", async () => {
    const caller = tenantInviteRouter.createCaller({ user: null } as any);
    await expect(caller.create({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("platform admin can mint an invite", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb() as any);
    const caller = tenantInviteRouter.createCaller(ADMIN);
    const r = await caller.create({ tenantId: T1 });
    expect(r.token).toBeTruthy();
    expect(r.tenantId).toBe(T1);
  });
});

describe("tenantInvite.resend", () => {
  it("rejects non-admin users", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb() as any);
    const caller = tenantInviteRouter.createCaller(TENANT_USER);
    await expect(caller.resend({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects non-admin cross-tenant resend", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb() as any);
    const caller = tenantInviteRouter.createCaller(TENANT_USER);
    await expect(caller.resend({ tenantId: T2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("platform admin can resend", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb() as any);
    const caller = tenantInviteRouter.createCaller(ADMIN);
    const r = await caller.resend({ tenantId: T1 });
    expect(r.sent).toBe(true);
  });
});
