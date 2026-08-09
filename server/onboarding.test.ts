/**
 * onboarding.test.ts — tenant provisioning + onboarding pipeline.
 *
 * Covers: platform-admin-only start, seeded default settings/waMenu contract,
 * happy path draft→configuring→validating→live (mocked fetch for Graph +
 * integration checks), validation failure blocking activation, retry flow,
 * and cross-tenant rejection.
 *
 * DB is mocked in-memory (drizzle conditions really evaluated, same style as
 * tenantIsolation.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DEFAULT_WA_MENU } from "../shared/waMenu";

// ─── In-memory DB mock ───────────────────────────────────────────────────────

const stores: Record<string, Record<string, unknown>[]> = { tenants: [] };

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
    const mGt = part.match(/"[\w]+"\."([\w]+)" > \$(\d+)/);
    if (mGt) {
      const prop = colMap[mGt[1]];
      const val = compiled.params[Number(mGt[2]) - 1];
      if (prop) tests.push((r) => Number(r[prop]) > Number(val));
    }
    // other predicates pass through
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

function makeChain(rows: Record<string, unknown>[]): any {
  const self: any = {};
  const chain = () => makeChain(rows);
  self.orderBy = chain;
  self.limit = chain;
  self.offset = chain;
  self.groupBy = chain;
  self.returning = () => Promise.resolve(rows);
  self.then = (resolve: (v: unknown) => void) => {
    resolve(rows);
    return self;
  };
  self.catch = () => self;
  return self;
}

function makeMockDb() {
  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);
        const all = stores[name] ?? [];
        const api: any = {};
        api.where = (cond: unknown) => makeChain(filterRows(table, cond, all));
        api.orderBy = () => ({ limit: () => Promise.resolve(all) });
        api.then = (resolve: (v: unknown) => void) => {
          resolve(all);
          return api;
        };
        return api;
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const name = getTableName(table as never);
        const row = { createdAt: new Date(), updatedAt: new Date(), ...vals };
        (stores[name] ??= []).push(row);
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
          const simpleVals: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(vals)) {
            if (v == null || typeof v !== "object" || v instanceof Date) simpleVals[k] = v;
            else if (!("sql" in (v as object))) simpleVals[k] = v; // plain JSONB objects
          }
          for (const row of matched) Object.assign(row, simpleVals, { updatedAt: new Date() });
          return {
            returning: () => Promise.resolve(matched),
            then: (resolve: (v: unknown) => void) => resolve(matched),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        const name = getTableName(table as never);
        const matched = filterRows(table, cond, stores[name] ?? []);
        stores[name] = (stores[name] ?? []).filter((r) => !matched.includes(r));
        return Promise.resolve(matched);
      },
    }),
  };
  return db;
}

vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(makeMockDb())),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn().mockResolvedValue(true) }));

const { onboardingRouter } = await import("./routers/onboarding");

// ─── Context helpers ─────────────────────────────────────────────────────────

function makeUser(role: "admin" | "user", tenantId: string | null): NonNullable<TrpcContext["user"]> {
  return {
    id: role === "admin" ? 1 : 2,
    openId: `openid-${role}-${tenantId}`,
    email: `${role}@example.com`,
    name: `${role} user`,
    loginMethod: "keycloak",
    role,
    tenantId,
    phone: null,
    phoneVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as NonNullable<TrpcContext["user"]>;
}

function makeCtx(user: NonNullable<TrpcContext["user"]> | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const adminCtx = makeCtx(makeUser("admin", null));

function fetchOk(url: string) {
  return Promise.resolve(
    new Response(JSON.stringify({ id: url }), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  stores.tenants = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onboarding.start (provisioning)", () => {
  it("is platform-admin only", async () => {
    const tenantUserCaller = onboardingRouter.createCaller(makeCtx(makeUser("user", "t-x")));
    await expect(tenantUserCaller.start({ name: "Nope Ltd" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const anonCaller = onboardingRouter.createCaller(makeCtx(null));
    await expect(anonCaller.start({ name: "Nope Ltd" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("seeds the exact default settings skeleton + waMenu contract", async () => {
    const caller = onboardingRouter.createCaller(adminCtx);
    const res = await caller.start({ name: "Adire Atelier", plan: "starter" });
    expect(res.tenantId).toBeTruthy();
    expect(res.slug).toBe("adire-atelier");
    expect(res.onboardingStatus).toBe("draft");

    const row = stores.tenants.find((t) => t.id === res.tenantId)!;
    const settings = row.settings as any;

    expect(settings.commerce).toEqual({ currency: "NGN", pickupEnabled: true, deliveryZones: [] });
    expect(settings.branding).toEqual({ name: "Adire Atelier", logoUrl: null, primaryColor: "#8A5A2B" });
    expect(settings.crm).toEqual({ customFields: [], pipelineStages: ["new", "qualified", "won", "lost"] });
    expect(settings.inventory).toEqual({ source: "local", lowStockThreshold: 5 });
    expect(settings.integrations).toEqual({});
    expect(settings.onboarding.status).toBe("draft");

    // waMenu contract: all 6 use cases, shop/track/handoff enabled
    expect(settings.waMenu).toEqual(DEFAULT_WA_MENU);
    expect(settings.waMenu.useCases.map((u: any) => u.id).sort()).toEqual(
      ["booking", "handoff", "procurement", "shop", "support", "track"],
    );
    const enabled = settings.waMenu.useCases.filter((u: any) => u.enabled).map((u: any) => u.id);
    expect(enabled.sort()).toEqual(["handoff", "shop", "track"]);
    expect(settings.waMenu.fallback).toBe("nlp");
  });
});

describe("onboarding pipeline happy path (draft → live)", () => {
  it("walks updateStep → validate → activate with mocked live checks", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => fetchOk(url));
    vi.stubGlobal("fetch", fetchMock);

    const admin = onboardingRouter.createCaller(adminCtx);
    const { tenantId } = await admin.start({ name: "Kola Foods" });
    const tenantCaller = onboardingRouter.createCaller(makeCtx(makeUser("user", tenantId)));

    let st = await tenantCaller.getStatus({ tenantId });
    expect(st.status).toBe("draft");
    expect(st.whatsappConfigured).toBe(false);

    // whatsapp creds
    st = await tenantCaller.updateStep({
      tenantId,
      step: "whatsapp",
      data: { phoneNumberId: "1234567890", accessToken: "EAAG-token" },
    });
    expect(st.status).toBe("configuring");
    expect(st.completedSteps).toContain("whatsapp");

    // use-case selection (enable support, disable handoff)
    st = await tenantCaller.updateStep({
      tenantId,
      step: "useCases",
      data: {
        useCases: [
          { id: "shop", label: "Shop products", enabled: true, order: 1 },
          { id: "track", label: "Track my order", enabled: true, order: 2 },
          { id: "support", label: "Get support", enabled: true, order: 3 },
          { id: "booking", label: "Book an appointment", enabled: false, order: 4 },
          { id: "handoff", label: "Talk to a human", enabled: false, order: 5 },
        ],
      },
    });
    expect(st.completedSteps).toContain("useCases");

    // integrations (enabled medusa → will be connection-tested)
    await tenantCaller.updateStep({
      tenantId,
      step: "integrations",
      data: { provider: "medusa", creds: { url: "https://medusa.example.com", apiKey: "mk_123", enabled: true } },
    });

    // branding
    await tenantCaller.updateStep({
      tenantId,
      step: "branding",
      data: { name: "Kola Foods", logoUrl: null, primaryColor: "#112233" },
    });

    const val = await tenantCaller.validate({ tenantId });
    expect(val.passed).toBe(true);
    expect(val.status).toBe("validating");
    expect(val.validationPassed).toBe(true);
    // Graph API + medusa test-connection were both called
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u === "https://graph.facebook.com/v21.0/1234567890")).toBe(true);
    expect(calledUrls.some((u) => u.startsWith("https://medusa.example.com/"))).toBe(true);

    const act = await tenantCaller.activate({ tenantId });
    expect(act.status).toBe("live");
    const row = stores.tenants.find((t) => t.id === tenantId)!;
    expect(row.status).toBe("active");
  });
});

describe("validation failure blocks activation", () => {
  it("failed validation → activate rejected → retry → fix → live", async () => {
    const admin = onboardingRouter.createCaller(adminCtx);
    const { tenantId } = await admin.start({ name: "Broken Shop" });
    const tenantCaller = onboardingRouter.createCaller(makeCtx(makeUser("user", tenantId)));

    await tenantCaller.updateStep({
      tenantId,
      step: "whatsapp",
      data: { phoneNumberId: "bad-phone", accessToken: "bad-token" },
    });

    // Graph API rejects the token
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid OAuth" } }), { status: 401 })),
    );
    const val = await tenantCaller.validate({ tenantId });
    expect(val.passed).toBe(false);
    expect(val.status).toBe("failed");
    expect(val.reasons.join(" ")).toContain("whatsapp");

    await expect(tenantCaller.activate({ tenantId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Retry: back to configuring, fix creds, revalidate OK
    const retry = await tenantCaller.retryValidation({ tenantId });
    expect(retry.status).toBe("configuring");

    await tenantCaller.updateStep({
      tenantId,
      step: "whatsapp",
      data: { phoneNumberId: "good-phone", accessToken: "good-token" },
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => fetchOk(url)));
    const val2 = await tenantCaller.validate({ tenantId });
    expect(val2.passed).toBe(true);
    const act = await tenantCaller.activate({ tenantId });
    expect(act.status).toBe("live");
  });

  it("fails validation when whatsapp creds were never configured", async () => {
    const admin = onboardingRouter.createCaller(adminCtx);
    const { tenantId } = await admin.start({ name: "No Creds" });
    const tenantCaller = onboardingRouter.createCaller(makeCtx(makeUser("user", tenantId)));
    const val = await tenantCaller.validate({ tenantId });
    expect(val.passed).toBe(false);
    expect(val.status).toBe("failed");
    expect(val.reasons.join(" ")).toContain("missing phoneNumberId or accessToken");
  });
});

describe("cross-tenant access", () => {
  it("rejects tenant B operating on tenant A onboarding", async () => {
    const admin = onboardingRouter.createCaller(adminCtx);
    const { tenantId } = await admin.start({ name: "Tenant A" });
    const intruder = onboardingRouter.createCaller(makeCtx(makeUser("user", "tenant-b")));

    await expect(intruder.getStatus({ tenantId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      intruder.updateStep({ tenantId, step: "branding", data: { name: "X", logoUrl: null, primaryColor: "#000000" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(intruder.validate({ tenantId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(intruder.activate({ tenantId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(intruder.retryValidation({ tenantId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
