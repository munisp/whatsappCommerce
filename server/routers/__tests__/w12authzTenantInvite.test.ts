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
    // W30 merge: invite tokens are now registered in tenant_invite_tokens
    // (single-use registry) — the create path inserts the jti row.
    insert: vi.fn(() => ({ values: vi.fn(async () => {}) })),
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

// ── W30 hotfix2: resend must mint a LIVE token ──────────────────────────────
// Before the fix resend minted an UNREGISTERED 72h token — validate() always
// rejected it ("Invite token is not registered"), so every resent link was
// dead. Resend now registers the jti in tenant_invite_tokens with the same
// single-use ≤24h semantics as create().
describe("tenantInvite.resend mints a live, single-use ≤24h token (hotfix2)", () => {
  function makeStatefulDb() {
    const tokens: any[] = [];
    const tenantP = Promise.resolve([tenantRow]);
    return {
      tokens,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => tenantP), then: (r: any, j: any) => tenantP.then(r, j) })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (v: any) => { tokens.push({ ...v, consumedAt: null }); }),
      })),
      update: vi.fn(() => ({
        set: (vals: any) => ({
          where: () => ({
            returning: async () => {
              const t = tokens.find((x) => !x.consumedAt);
              if (!t) return [];
              t.consumedAt = vals.consumedAt ?? new Date();
              return [{ jti: t.jti }];
            },
          }),
        }),
      })),
    } as any;
  }

  it("resent token carries a registered jti and validates exactly once", async () => {
    const db = makeStatefulDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const admin = tenantInviteRouter.createCaller(ADMIN);
    const r = await admin.resend({ tenantId: T1 });
    expect(r.sent).toBe(true);

    // jti is in the signed token AND in the registry, expiring ≤ 24h out.
    const token = r.portalUrl.split("token=")[1];
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(typeof payload.jti).toBe("string");
    const reg = db.tokens.find((t: any) => t.jti === payload.jti);
    expect(reg, "jti registered in tenant_invite_tokens").toBeTruthy();
    expect(reg.tenantId).toBe(T1);
    expect(reg.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(24 * 3600);

    // validate() accepts it (the old dead-token bug) …
    const portal = tenantInviteRouter.createCaller({ user: null } as any);
    const first = await portal.validate({ token });
    expect(first.valid, `first validate must succeed (got ${(first as any).error})`).toBe(true);
    // … and exactly once (single-use consume).
    const second = await portal.validate({ token });
    expect(second.valid).toBe(false);
  });
});
