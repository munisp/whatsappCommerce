/**
 * waTemplates tests: cache parsing + APPROVED filtering, Meta list sync
 * (mocked fetch), template create payload, router tenant isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));

import { getDb } from "./db";
import {
  approvedTemplates,
  createMetaTemplate,
  fetchMetaTemplates,
  parseWaTemplateCache,
  positionalParams,
  syncWaTemplates,
} from "./services/waTemplates";
import { waTemplatesRouter } from "./routers/waTemplates";

const CREDS_TENANT = {
  wabaId: "waba-1",
  settings: { whatsapp: { accessToken: "tok", wabaId: "waba-1" } },
};

function makeDb(tenantRow: any = CREDS_TENANT) {
  const updates: any[] = [];
  const db: any = {
    select: vi.fn(() => {
      const c: any = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(() => Promise.resolve(tenantRow ? [tenantRow] : [])),
        catch: vi.fn(() => Promise.resolve(tenantRow ? [tenantRow] : [])),
      };
      c.from.mockReturnValue(c);
      c.where.mockReturnValue(c);
      return c;
    }),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push(v);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  return { db, updates };
}

function jsonFetch(payload: any, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as any;
}

beforeEach(() => vi.clearAllMocks());

describe("parseWaTemplateCache + approvedTemplates", () => {
  it("parses cached templates and filters APPROVED only", () => {
    const settings = {
      waTemplates: {
        syncedAt: "2025-01-01T00:00:00Z",
        templates: [
          { id: "1", name: "a_ok", category: "UTILITY", language: "en_US", status: "APPROVED", body: "hi" },
          { id: "2", name: "b_wait", category: "MARKETING", language: "en_US", status: "PENDING", body: "hey" },
          { id: "3", name: "c_no", category: "UTILITY", language: "en_US", status: "REJECTED", body: "yo", rejectedReason: "spammy" },
        ],
      },
    };
    const cache = parseWaTemplateCache(settings);
    expect(cache.templates).toHaveLength(3);
    expect(cache.syncedAt).toBe("2025-01-01T00:00:00Z");
    expect(approvedTemplates(cache).map((t) => t.name)).toEqual(["a_ok"]);
  });

  it("returns an empty cache for missing/malformed settings", () => {
    expect(parseWaTemplateCache(null).templates).toEqual([]);
    expect(parseWaTemplateCache({ waTemplates: { templates: "nope" } }).templates).toEqual([]);
  });
});

describe("positionalParams", () => {
  it("extracts ordered unique positional params", () => {
    expect(positionalParams("Hi {{1}}, order {{2}} due {{1}}")).toEqual([1, 2]);
    expect(positionalParams("no params {{name}}")).toEqual([]);
  });
});

describe("fetchMetaTemplates", () => {
  it("maps Meta components into cached template rows", async () => {
    const fetchFn = jsonFetch({
      data: [
        {
          id: "mt1",
          name: "order_update",
          category: "UTILITY",
          language: "en_US",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Order {{1}} shipped" }],
        },
      ],
    });
    const rows = await fetchMetaTemplates({ wabaId: "w1", accessToken: "t" }, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/w1/message_templates"),
      expect.objectContaining({ headers: { Authorization: "Bearer t" } }),
    );
    expect(rows).toEqual([
      { id: "mt1", name: "order_update", category: "UTILITY", language: "en_US", status: "APPROVED", body: "Order {{1}} shipped" },
    ]);
  });

  it("throws on a non-OK Meta response", async () => {
    await expect(fetchMetaTemplates({ wabaId: "w1", accessToken: "t" }, jsonFetch({ error: "denied" }, 403)))
      .rejects.toThrow("403");
  });
});

describe("syncWaTemplates", () => {
  it("writes the remote list into settings.waTemplates with syncedAt", async () => {
    const { db, updates } = makeDb();
    const fetchFn = jsonFetch({ data: [{ id: "1", name: "x", category: "UTILITY", language: "en_US", status: "PENDING", components: [] }] });
    const cache = await syncWaTemplates(db, "t1", fetchFn);
    expect(cache.templates).toHaveLength(1);
    expect(cache.syncedAt).toBeTruthy();
    expect(updates).toHaveLength(1);
    // settings is a drizzle sql fragment embedding settings.waTemplates.
    expect(updates[0].settings).toBeDefined();
  });

  it("fails when the tenant has no WABA credentials", async () => {
    const { db } = makeDb({ wabaId: null, settings: {} });
    delete process.env.WAC_WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_TOKEN;
    await expect(syncWaTemplates(db, "t1", jsonFetch({}))).rejects.toThrow("wabaId");
  });
});

describe("createMetaTemplate", () => {
  it("posts name/category/language/body with positional example params", async () => {
    const { db } = makeDb();
    const fetchFn = jsonFetch({ id: "new1", status: "PENDING" });
    const res = await createMetaTemplate(db, "t1", {
      name: "promo_alert",
      category: "MARKETING",
      language: "en_US",
      body: "Hi {{1}}, {{2}}% off today!",
    }, fetchFn);
    expect(res).toEqual({ id: "new1", status: "PENDING" });
    const body = JSON.parse((fetchFn.mock.calls[0] as any[])[1].body);
    expect(body).toMatchObject({ name: "promo_alert", category: "MARKETING", language: "en_US" });
    expect(body.components[0].type).toBe("BODY");
    expect(body.components[0].example.body_text[0]).toEqual(["sample1", "sample2"]);
  });

  it("throws with Meta's error on rejection", async () => {
    const { db } = makeDb();
    await expect(
      createMetaTemplate(db, "t1", { name: "x", category: "UTILITY", language: "en_US", body: "b" },
        jsonFetch({ error: { message: "invalid name" } }, 400)),
    ).rejects.toThrow("400");
  });
});

describe("waTemplates router", () => {
  const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
  const OTHER = { user: { id: 2, role: "user", tenantId: "other" } } as any;

  it("list returns the cache without syncing by default", async () => {
    const tenant = {
      settings: {
        waTemplates: { syncedAt: "2025-01-01T00:00:00Z", templates: [
          { id: "1", name: "a", category: "UTILITY", language: "en_US", status: "APPROVED", body: "b" },
          { id: "2", name: "p", category: "UTILITY", language: "en_US", status: "PENDING", body: "b" },
        ] },
      },
    };
    vi.mocked(getDb).mockResolvedValue(makeDb(tenant).db);
    const caller = waTemplatesRouter.createCaller(ADMIN);
    const all = await caller.list({ tenantId: "t1" });
    expect(all.templates).toHaveLength(2);
    const approved = await caller.list({ tenantId: "t1", approvedOnly: true });
    expect(approved.templates.map((t) => t.name)).toEqual(["a"]);
  });

  it("enforces tenant isolation", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb({ settings: {} }).db);
    const caller = waTemplatesRouter.createCaller(OTHER);
    await expect(caller.list({ tenantId: "t1" })).rejects.toThrow();
  });

  it("create validates template names (lowercase snake_case)", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb().db);
    const caller = waTemplatesRouter.createCaller(ADMIN);
    await expect(
      caller.create({ tenantId: "t1", name: "Bad Name!", category: "UTILITY", language: "en_US", body: "hi" }),
    ).rejects.toThrow();
  });
});
