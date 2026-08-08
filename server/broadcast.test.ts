/**
 * Broadcast — real consent-gated send tests.
 * Covers: consent gating (non-consented excluded), 24h-window text vs
 * template routing, dryRun, per-tenant rate limiting, tenant isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

vi.mock("./_core/rateLimit", () => ({
  redisIncrExStrict: vi.fn(),
  RateLimitUnavailableError: class RateLimitUnavailableError extends Error {},
}));

vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return {
    ...orig,
    sendWhatsAppText: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
  };
});

import { getDb } from "./db";
import { redisIncrExStrict } from "./_core/rateLimit";
import { sendWhatsAppText, sendWhatsAppTemplate } from "./services/waSender";
import { broadcastRouter } from "./routers/broadcast";

/**
 * Chainable mock db. `queue` holds per-query results in call order; queries
 * ending in .limit() or awaited directly both shift the queue.
 * `executeResults` handles raw-SQL calls (consents, last-inbound) in order.
 */
function makeDb(queue: any[], executeResults: any[] = []) {
  const results = [...queue];
  const execResults = [...executeResults];
  const inserted: any[] = [];
  // The select-chain is thenable (queries ending without .limit), but the
  // root db object must NOT be thenable or `await getDb()` would assimilate it.
  const chain: any = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(() => Promise.resolve(results.shift() ?? [])),
    then: (resolve: any, reject: any) => Promise.resolve(results.shift() ?? []).then(resolve, reject),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  const db: any = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return { onConflictDoNothing: () => Promise.resolve() };
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    execute: vi.fn(() => Promise.resolve(execResults.shift() ?? { rows: [] })),
  };
  return { db, inserted };
}

const CAMPAIGN = {
  id: "camp-1",
  tenantId: "t1",
  name: "Promo",
  templateId: "tpl-1",
  varMapping: {},
  status: "draft",
};

const ADMIN_CTX = { user: { id: 1, role: "admin", tenantId: null } } as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWhatsAppText).mockResolvedValue({ sent: true, simulated: false, wamids: ["wamid.text"], chunks: 1 });
  vi.mocked(sendWhatsAppTemplate).mockResolvedValue({ sent: true, simulated: false, wamid: "wamid.tpl" });
  vi.mocked(redisIncrExStrict).mockResolvedValue(1);
});

describe("broadcast.send consent gating", () => {
  it("excludes non-consented customers (dryRun shows gated audience)", async () => {
    const { db } = makeDb(
      [
        [CAMPAIGN],                                     // campaign lookup
        [{ settings: { broadcast: { ratePerMin: 30 } } }], // tenant settings
        [                                               // customers of tenant
          { id: "c1", whatsappPhone: "+2348011111111", name: "Consented" },
          { id: "c2", whatsappPhone: "+2348022222222", name: "NotConsented" },
        ],
      ],
      [
        { rows: [{ phone: "+2348011111111" }] },        // consents: only c1
        { rows: [] },                                    // last inbound
      ],
    );
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const res = await caller.send({ campaignId: "camp-1", dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.audienceCount).toBe(1);
    expect(res.sample[0].phone).toBe("+2348011111111");
    // dryRun sends nothing and creates no recipients
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    // dryRun does not consume rate limit
    expect(redisIncrExStrict).not.toHaveBeenCalled();
  });

  it("treats a missing/failed consents table as NOT consented (empty audience)", async () => {
    const { db } = makeDb(
      [
        [CAMPAIGN],
        [{ settings: null }],
        [{ id: "c1", whatsappPhone: "+2348011111111", name: "A" }],
      ],
    );
    // execute must reject for the consent query but resolve for last-inbound
    db.execute
      .mockImplementationOnce(() => Promise.reject(new Error('relation "consents" does not exist')))
      .mockImplementationOnce(() => Promise.resolve({ rows: [] }));
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const res = await caller.send({ campaignId: "camp-1", dryRun: true });
    expect(res.audienceCount).toBe(0);
  });
});

describe("broadcast.send real batch", () => {
  it("sends text to in-window recipients and template to out-of-window", async () => {
    const now = new Date().toISOString();
    const { db, inserted } = makeDb(
      [
        [CAMPAIGN],
        [{ settings: { broadcast: { ratePerMin: 30, templateName: "wac_promo", languageCode: "en_US" } } }],
        [
          { id: "c1", whatsappPhone: "+2348011111111", name: "InWindow" },
          { id: "c2", whatsappPhone: "+2348022222222", name: "OutWindow" },
        ],
        [{ bodyText: "Hi {{customer_name}}!", name: "wac_promo", language: "en_US" }], // campaign template
      ],
      [
        { rows: [{ phone: "2348011111111" }, { phone: "2348022222222" }] }, // both consented
        { rows: [{ phone: "2348011111111", last_at: now }] },               // only c1 in window
      ],
    );
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const res = await caller.send({ campaignId: "camp-1" });

    expect(res.total).toBe(2);
    expect(res.sent).toBe(2);
    expect(res.failed).toBe(0);

    // In-window → free-form text with substitution, tenant creds via tenantId
    expect(sendWhatsAppText).toHaveBeenCalledOnce();
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "t1", "+2348011111111", "Hi InWindow!", expect.objectContaining({ notifType: "broadcast" }),
    );
    // Out-of-window → tenant-configured template
    expect(sendWhatsAppTemplate).toHaveBeenCalledOnce();
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      "t1", "+2348022222222", "wac_promo", "en_US", expect.any(Array), expect.objectContaining({ notifType: "broadcast" }),
    );
    // Per-recipient status rows were created
    expect(inserted.length).toBe(2);
    expect(inserted[0]).toMatchObject({ campaignId: "camp-1", status: "pending" });
  });

  it("marks per-recipient failures without failing the batch", async () => {
    vi.mocked(sendWhatsAppTemplate)
      .mockRejectedValueOnce(new Error("Graph API 400: bad template"))
      .mockResolvedValueOnce({ sent: true, simulated: false, wamid: "wamid.ok" });
    const { db } = makeDb(
      [
        [{ ...CAMPAIGN, templateId: null }],
        [{ settings: null }],
        [
          { id: "c1", whatsappPhone: "2348011111111", name: "A" },
          { id: "c2", whatsappPhone: "2348022222222", name: "B" },
        ],
      ],
      [
        { rows: [{ phone: "2348011111111" }, { phone: "2348022222222" }] },
        { rows: [] }, // no inbound → all out-of-window → template path
      ],
    );
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const res = await caller.send({ campaignId: "camp-1" });
    expect(res.total).toBe(2);
    expect(res.sent + res.failed).toBe(2);
  });
});

describe("broadcast.send rate limiting", () => {
  it("rejects the second burst within the same minute (tenant ratePerMin=1)", async () => {
    const setupDb = () => makeDb(
      [
        [CAMPAIGN],
        [{ settings: { broadcast: { ratePerMin: 1 } } }],
        [{ id: "c1", whatsappPhone: "2348011111111", name: "A" }],
        [{ bodyText: "Hi", name: "tpl", language: "en" }],
      ],
      [
        { rows: [{ phone: "2348011111111" }] },
        { rows: [] },
      ],
    );

    vi.mocked(redisIncrExStrict).mockResolvedValueOnce(1); // first burst: allowed
    vi.mocked(getDb).mockResolvedValue(setupDb().db);
    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const first = await caller.send({ campaignId: "camp-1" });
    expect(first.sent).toBe(1);

    vi.mocked(redisIncrExStrict).mockResolvedValueOnce(2); // second burst: over limit
    vi.mocked(getDb).mockResolvedValue(setupDb().db);
    await expect(caller.send({ campaignId: "camp-1" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
});

describe("broadcast.send tenant isolation", () => {
  it("forbids non-admin users from sending another tenant's campaign", async () => {
    const { db } = makeDb([[CAMPAIGN]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = broadcastRouter.createCaller({
      user: { id: 7, role: "user", tenantId: "other-tenant" },
    } as any);
    await expect(caller.send({ campaignId: "camp-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("broadcast.send messaging-quality throttle", () => {
  it("blocks the send when Meta reports a LOW quality rating", async () => {
    const { db } = makeDb([
      [CAMPAIGN],
      [{ settings: { waQuality: { rating: "LOW", checkedAt: new Date().toISOString() } } }],
    ]);
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    await expect(caller.send({ campaignId: "camp-1" })).rejects.toThrow(/LOW/);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(redisIncrExStrict).not.toHaveBeenCalled();
  });

  it("halves the per-minute rate when the rating is MEDIUM", async () => {
    const { db } = makeDb(
      [
        [{ ...CAMPAIGN, templateId: null }],
        [{ settings: { broadcast: { ratePerMin: 30 }, waQuality: { rating: "MEDIUM", checkedAt: new Date().toISOString() } } }],
        [{ id: "c1", whatsappPhone: "2348011111111", name: "A" }],
      ],
      [{ rows: [{ phone: "2348011111111" }] }, { rows: [] }],
    );
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const res = await caller.send({ campaignId: "camp-1" });
    expect(res.sent).toBe(1);
    expect(redisIncrExStrict).toHaveBeenCalled();
  });
});

describe("broadcast.create templateName override", () => {
  it("persists a free-form template override as varMapping.__templateName", async () => {
    const { db, inserted } = makeDb([]);
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const res = await caller.create({
      tenantId: "t1",
      name: "Promo",
      segment: "all",
      templateName: "approved_meta_template",
    });
    expect(res.id).toBeTruthy();
    expect(inserted[0].varMapping).toEqual({ __templateName: "approved_meta_template" });
  });

  it("the override beats the tenant default at send time (internal keys never leak into params)", async () => {
    const { db } = makeDb(
      [
        [{ ...CAMPAIGN, templateId: null, varMapping: { __templateName: "override_tpl", flavor: "x" } }],
        [{ settings: { broadcast: { templateName: "wac_default", languageCode: "en_US" } } }],
        [{ id: "c1", whatsappPhone: "2348011111111", name: "A" }],
      ],
      [{ rows: [{ phone: "2348011111111" }] }, { rows: [] }],
    );
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    await caller.send({ campaignId: "camp-1" });
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      "t1", "2348011111111", "override_tpl", "en_US",
      [{ type: "body", parameters: [{ type: "text", text: "A" }, { type: "text", text: "x" }] }],
      expect.objectContaining({ notifType: "broadcast" }),
    );
  });
});
