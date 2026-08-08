/**
 * faq — unit tests
 * FAQ matching (substring + fuzzy token overlap), settings parsing, and the
 * tenantConfig getFaq/setFaq procedures incl. cross-tenant rejection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { TrpcContext } from "./_core/context";
import { buildDefaultTenantSettings } from "../shared/tenantConfig";

import { matchFaq, parseFaqSettings, normalizeFaqText, type FaqEntry } from "./services/faq";

// ── Matching ─────────────────────────────────────────────────────────────────

const FAQS: FaqEntry[] = [
  { q: "What is your delivery fee?", a: "Delivery is ₦500 within the city." },
  { q: "Do you open on Sundays?", a: "Yes, 12pm–6pm." },
];

describe("matchFaq", () => {
  it("hits on substring containment (short inbound question)", () => {
    const hit = matchFaq(FAQS, "delivery fee?");
    expect(hit?.entry.a).toContain("₦500");
    expect(hit?.score).toBe(1);
  });

  it("hits on fuzzy token overlap", () => {
    const hit = matchFaq(FAQS, "what is the delivery fee for my area");
    expect(hit?.entry.q).toBe("What is your delivery fee?");
  });

  it("hits with diacritics/casing noise normalized away", () => {
    const hit = matchFaq([{ q: "Café opening hours", a: "8–6" }], "CAFE opening hours!!");
    expect(hit?.entry.a).toBe("8–6");
  });

  it("misses unrelated questions (falls through to the NLP pipeline)", () => {
    expect(matchFaq(FAQS, "do you sell leather shoes")).toBeNull();
    expect(matchFaq(FAQS, "")).toBeNull();
  });

  it("requires at least two shared content tokens for a fuzzy hit", () => {
    expect(matchFaq(FAQS, "how much is delivery to Kano")).toBeNull(); // only "delivery" shared
  });
});

describe("parseFaqSettings", () => {
  it("drops malformed entries and trims", () => {
    const parsed = parseFaqSettings({
      faq: [
        { q: "  Hours? ", a: " 9–5 " },
        { q: "", a: "no question" },
        { q: "no answer", a: "" },
        "garbage",
        { q: 42, a: "x" },
      ],
    });
    expect(parsed).toEqual([{ q: "Hours?", a: "9–5" }]);
  });

  it("returns [] when settings.faq is absent", () => {
    expect(parseFaqSettings(null)).toEqual([]);
    expect(parseFaqSettings({})).toEqual([]);
    expect(parseFaqSettings({ faq: "nope" })).toEqual([]);
  });
});

// ── tenantConfig getFaq/setFaq (in-memory DB, real tenant filtering) ────────

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
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

vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() =>
    Promise.resolve({
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
          const row = { createdAt: new Date(), updatedAt: new Date(), ...vals };
          (stores[getTableName(table as never)] ??= []).push(row);
          return Promise.resolve([row]);
        },
      }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const name = getTableName(table as never);
            const matched = filterRows(table, cond, stores[name] ?? []);
            for (const row of matched) Object.assign(row, vals, { updatedAt: new Date() });
            return Promise.resolve(matched);
          },
        }),
      }),
    }),
  ),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn().mockResolvedValue(true) }));

const { tenantConfigRouter } = await import("./routers/tenantConfig");

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

function makeCtx(user: NonNullable<TrpcContext["user"]>): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const callerA = () => tenantConfigRouter.createCaller(makeCtx(makeUser("user", TENANT_A)));
const callerB = () => tenantConfigRouter.createCaller(makeCtx(makeUser("user", TENANT_B)));

beforeEach(() => {
  stores.tenants = [
    {
      id: TENANT_A,
      name: "Adire Atelier",
      slug: TENANT_A,
      settings: buildDefaultTenantSettings("Adire Atelier"),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ] as any;
});

describe("tenantConfig.getFaq/setFaq", () => {
  it("round-trips the FAQ list into settings.faq", async () => {
    expect(await callerA().getFaq({ tenantId: TENANT_A })).toEqual([]);
    const faq = [{ q: "Delivery fee?", a: "₦500" }, { q: "Opening hours?", a: "9–5" }];
    await callerA().setFaq({ tenantId: TENANT_A, faq });
    expect(await callerA().getFaq({ tenantId: TENANT_A })).toEqual(faq);
    expect((stores.tenants[0].settings as any).faq).toEqual(faq);
  });

  it("rejects duplicate questions", async () => {
    await expect(
      callerA().setFaq({
        tenantId: TENANT_A,
        faq: [{ q: "Same?", a: "1" }, { q: "same?", a: "2" }],
      }),
    ).rejects.toThrow(/duplicate faq question/i);
  });

  it("rejects cross-tenant access (ownership)", async () => {
    await expect(callerB().getFaq({ tenantId: TENANT_A })).rejects.toThrow();
    await expect(
      callerB().setFaq({ tenantId: TENANT_A, faq: [{ q: "x", a: "y" }] }),
    ).rejects.toThrow();
    expect((stores.tenants[0].settings as any).faq).toBeUndefined();
  });
});
