/**
 * CV-1 / J85 unit tests — WhatsApp shelf-photo stock-take service.
 *
 * DB, WhatsApp sender, storage and ALL network (Graph media download + VLM
 * orchestrator) are mocked/injected — the service logic is exercised for
 * real: opt-in gate, session lifecycle, counts reply, calibrated APPLY with
 * low-confidence escalation. Each assertion fails if the feature is reverted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  inventorySnapshots,
  merchantNotifications,
  products,
  tenants,
  visualInventoryMappings,
  visualInventorySessions,
} from "../../drizzle/schema";

// ── Module mocks ─────────────────────────────────────────────────────────────

const holder = vi.hoisted(() => ({
  db: null as any,
  sentTexts: [] as Array<{ tenantId: string; to: string; body: string }>,
}));

vi.mock("../db", () => ({ getDb: vi.fn(async () => holder.db) }));
vi.mock("./waSender", () => ({
  resolveTenantWaCredentials: vi.fn(async () => ({ accessToken: "sim-token", phoneNumberId: "pn-1" })),
  sendWhatsAppText: vi.fn(async (tenantId: string, to: string, body: string) => {
    holder.sentTexts.push({ tenantId, to, body });
    return { ok: true };
  }),
}));
vi.mock("../storage", () => ({
  storagePut: vi.fn(async (key: string) => ({ url: `https://cdn.sim.test/${key}`, key })),
}));

import {
  formatCountsSummary,
  handleInboundStocktakeImage,
  handleStocktakeApplyReply,
  isWhatsAppStocktakeEnabled,
} from "./visualStocktake";

// ── Table-aware recording db fake ────────────────────────────────────────────

function makeFakeDb(rows: {
  settings?: Record<string, unknown>;
  mappings?: any[];
  sessions?: any[];
  snapshots?: any[];
}) {
  const inserted: Record<string, any[]> = {
    [getTableName(visualInventorySessions)]: [],
    [getTableName(merchantNotifications)]: [],
    [getTableName(inventorySnapshots)]: [],
    [getTableName(visualInventoryMappings)]: [],
  };
  const sessionUpdates: any[] = [];
  const productUpdates: any[] = [];

  const rowsFor = (table: any): any[] => {
    switch (getTableName(table)) {
      case getTableName(tenants):
        return [{ settings: rows.settings ?? {} }];
      case getTableName(visualInventoryMappings):
        return rows.mappings ?? [];
      case getTableName(visualInventorySessions):
        return rows.sessions ?? [];
      case getTableName(inventorySnapshots):
        return rows.snapshots ?? [];
      default:
        return [];
    }
  };

  const db: any = {
    select: () => ({
      from: (table: any) => {
        const result = rowsFor(table);
        const chain: any = {
          where: () => chain,
          orderBy: () => chain,
          limit: (n: number) => Promise.resolve(result.slice(0, n)),
          then: (res: (v: any) => any) => Promise.resolve(result).then(res),
          catch: (rej: (e: any) => any) => Promise.resolve(result).catch(rej),
        };
        return chain;
      },
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: () => {
          if (getTableName(table) === getTableName(visualInventorySessions)) sessionUpdates.push(values);
          if (getTableName(table) === getTableName(products)) productUpdates.push(values);
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: any) => ({
      values: (values: any) => {
        inserted[getTableName(table)]?.push(values);
        return {
          onConflictDoUpdate: () => Promise.resolve(),
          onConflictDoNothing: () => Promise.resolve(),
          then: (res: (v: any) => any) => Promise.resolve(undefined).then(res),
          catch: (rej: (e: any) => any) => Promise.resolve(undefined).catch(rej),
        };
      },
    }),
  };
  return {
    db,
    inserted,
    sessionUpdates,
    productUpdates,
    sessions: inserted[getTableName(visualInventorySessions)],
    notifications: inserted[getTableName(merchantNotifications)],
  };
}

// ── Fetch stub (Graph media + orchestrator) ──────────────────────────────────

function stubFetch(opts: { orchestratorBody?: any; orchestratorStatus?: number }) {
  return vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("media-bin")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    if (url.includes("graph.facebook.com")) {
      return new Response(
        JSON.stringify({ url: "https://graph.facebook.com/v21.0/media-bin/m-1", mime_type: "image/jpeg" }),
        { status: 200 },
      );
    }
    if (url.includes("/analyse")) {
      const status = opts.orchestratorStatus ?? 200;
      if (status !== 200) return new Response("boom", { status });
      return new Response(JSON.stringify(opts.orchestratorBody ?? { items: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

const ENABLED = {
  visualInventoryWhatsAppEnabled: true,
  visualInventoryAutoApplyConfidence: 0.95,
  visualInventoryReviewConfidence: 0.6,
};

beforeEach(() => {
  holder.db = null;
  holder.sentTexts.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Opt-in gate ───────────────────────────────────────────────────────────────

describe("isWhatsAppStocktakeEnabled", () => {
  it("default OFF; only explicit true enables", () => {
    expect(isWhatsAppStocktakeEnabled(null)).toBe(false);
    expect(isWhatsAppStocktakeEnabled({})).toBe(false);
    expect(isWhatsAppStocktakeEnabled({ visualInventoryWhatsAppEnabled: "true" })).toBe(false);
    expect(isWhatsAppStocktakeEnabled({ visualInventoryWhatsAppEnabled: true })).toBe(true);
  });
});

describe("formatCountsSummary", () => {
  it("formats 'I counted: 12× Indomie Pack, 30× Pure Water Sachet.'", () => {
    expect(formatCountsSummary([
      { label: "Indomie Pack", count: 12 },
      { label: "Pure Water Sachet", count: 30 },
    ])).toBe("I counted: 12× Indomie Pack, 30× Pure Water Sachet.");
  });
});

// ── Photo → counts reply ─────────────────────────────────────────────────────

describe("handleInboundStocktakeImage", () => {
  const base = { tenantId: "t-1", waPhoneNumber: "2347000000001", mediaId: "m-1" };

  it("flag OFF → no session, no orchestrator call, no reply", async () => {
    const fake = makeFakeDb({ settings: {} });
    holder.db = fake.db;
    const fetchStub = stubFetch({ orchestratorBody: { items: [{ label: "x", count: 1, confidence: 0.99 }] } });
    vi.stubGlobal("fetch", fetchStub);
    const out = await handleInboundStocktakeImage(base);
    expect(out).toEqual({ handled: true, outcome: "disabled" });
    expect(fake.sessions).toHaveLength(0);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(holder.sentTexts).toHaveLength(0);
  });

  it("flag ON → session (source whatsapp) + counts reply with APPLY/REVIEW instructions", async () => {
    const fake = makeFakeDb({
      settings: ENABLED,
      mappings: [
        { detectedLabel: "Indomie Pack", productId: "p-ind", isVerified: true },
        { detectedLabel: "Pure Water Sachet", productId: "p-pw", isVerified: true },
      ],
    });
    holder.db = fake.db;
    vi.stubGlobal("fetch", stubFetch({
      orchestratorBody: {
        items: [
          { label: "Indomie Pack", count: 12, confidence: 0.98 },
          { label: "Pure Water Sachet", count: 30, confidence: 0.97 },
        ],
        scene_description: "shelf",
        vlm_model_used: "yolo11",
        processing_ms: 42,
      },
    }));
    const out = await handleInboundStocktakeImage(base);
    expect(out.outcome).toBe("counts_replied");
    expect(out.sessionId).toBeTruthy();
    // Session row: processing → completed, source whatsapp, sender recorded.
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0].source).toBe("whatsapp");
    expect(fake.sessions[0].status).toBe("processing");
    expect(fake.sessions[0].userId).toBe(base.waPhoneNumber);
    const finalUpdate = fake.sessionUpdates[fake.sessionUpdates.length - 1];
    expect(finalUpdate.status).toBe("completed");
    expect(finalUpdate.totalItemsDetected).toBe(42);
    // Reply quotes the counts and the APPLY/REVIEW instruction.
    expect(holder.sentTexts).toHaveLength(1);
    const body = holder.sentTexts[0].body;
    expect(body).toContain("I counted: 12× Indomie Pack, 30× Pure Water Sachet");
    expect(body).toContain("APPLY");
    expect(body).toContain("REVIEW");
    // All items auto-apply eligible → no review notification.
    expect(fake.notifications).toHaveLength(0);
  });

  it("low-confidence item → session review_needed + operator notification", async () => {
    const fake = makeFakeDb({
      settings: ENABLED,
      mappings: [{ detectedLabel: "Indomie Pack", productId: "p-ind", isVerified: true }],
    });
    holder.db = fake.db;
    vi.stubGlobal("fetch", stubFetch({
      orchestratorBody: {
        items: [
          { label: "Indomie Pack", count: 12, confidence: 0.98 },
          { label: "Mystery Sachet", count: 5, confidence: 0.4 },
        ],
      },
    }));
    const out = await handleInboundStocktakeImage(base);
    expect(out.outcome).toBe("counts_replied");
    const finalUpdate = fake.sessionUpdates[fake.sessionUpdates.length - 1];
    expect(finalUpdate.status).toBe("review_needed");
    expect(fake.notifications).toHaveLength(1);
    expect(fake.notifications[0].metadata.kind).toBe("visual_inventory_review_required");
  });

  it("orchestrator failure → session failed + apologetic reply, never throws", async () => {
    const fake = makeFakeDb({ settings: ENABLED });
    holder.db = fake.db;
    vi.stubGlobal("fetch", stubFetch({ orchestratorStatus: 500 }));
    const out = await handleInboundStocktakeImage(base);
    expect(out.outcome).toBe("orchestrator_failed");
    const failUpdate = fake.sessionUpdates.find((u) => u.status === "failed");
    expect(failUpdate).toBeTruthy();
    expect(holder.sentTexts[0].body).toContain("couldn't analyse");
  });
});

// ── APPLY reply ───────────────────────────────────────────────────────────────

describe("handleStocktakeApplyReply", () => {
  const base = { tenantId: "t-1", waPhoneNumber: "2347000000001", command: "APPLY" as const };

  it("no pending session → handled with guidance reply", async () => {
    const fake = makeFakeDb({ settings: ENABLED, sessions: [] });
    holder.db = fake.db;
    const out = await handleStocktakeApplyReply(base);
    expect(out.outcome).toBe("no_pending_session");
    expect(holder.sentTexts[0].body).toContain("no pending stock-take");
  });

  it("flag OFF → not handled (falls through to NLP)", async () => {
    const fake = makeFakeDb({ settings: {}, sessions: [{ id: "s-1" }] });
    holder.db = fake.db;
    const out = await handleStocktakeApplyReply(base);
    expect(out.handled).toBe(false);
  });

  it("APPLY: auto-apply items applied, low-confidence queued, session review_needed", async () => {
    const fake = makeFakeDb({
      settings: ENABLED,
      mappings: [
        { detectedLabel: "Indomie Pack", productId: "p-ind", isVerified: true },
        { detectedLabel: "Pure Water Sachet", productId: "p-pw", isVerified: true },
      ],
      sessions: [{
        id: "s-1",
        tenantId: "t-1",
        userId: base.waPhoneNumber,
        source: "whatsapp",
        status: "completed",
        appliedToInventory: false,
        detectedItems: [
          { label: "Indomie Pack", count: 12, confidence: 0.98 },
          { label: "Pure Water Sachet", count: 30, confidence: 0.8 },
          { label: "Blurry Box", count: 2, confidence: 0.3 },
        ],
      }],
      snapshots: [{ stockQty: "10" }],
    });
    holder.db = fake.db;
    const out = await handleStocktakeApplyReply(base);
    expect(out.outcome).toBe("applied_partial");
    expect(out.applied).toBe(1); // only the 0.98 + verified item
    expect(out.needsReview).toBe(2); // 0.8 → review, 0.3 → excluded
    // Product stock updated to the detected count.
    expect(fake.productUpdates).toHaveLength(1);
    expect(fake.productUpdates[0].stockQuantity).toBe(12);
    // Session flipped to review_needed and marked applied.
    const finalUpdate = fake.sessionUpdates[fake.sessionUpdates.length - 1];
    expect(finalUpdate.status).toBe("review_needed");
    expect(finalUpdate.appliedToInventory).toBe(true);
    expect(finalUpdate.appliedBy).toBe(`whatsapp:${base.waPhoneNumber}`);
    // Operator notification for the review queue.
    expect(fake.notifications.some((n) => n.metadata?.kind === "visual_inventory_review_required")).toBe(true);
    // Reply tells the user what applied and what needs review.
    const body = holder.sentTexts[0].body;
    expect(body).toContain("Updated stock for 1 item");
    expect(body).toContain("2 item(s)");
    expect(body).toContain("review");
  });

  it("APPLY: all items calibrated → completed, success reply", async () => {
    const fake = makeFakeDb({
      settings: ENABLED,
      mappings: [{ detectedLabel: "Indomie Pack", productId: "p-ind", isVerified: true }],
      sessions: [{
        id: "s-2",
        tenantId: "t-1",
        userId: base.waPhoneNumber,
        source: "whatsapp",
        status: "completed",
        appliedToInventory: false,
        detectedItems: [{ label: "Indomie Pack", count: 12, confidence: 0.99 }],
      }],
      snapshots: [{ stockQty: "12" }],
    });
    holder.db = fake.db;
    const out = await handleStocktakeApplyReply(base);
    expect(out.outcome).toBe("applied");
    expect(out.applied).toBe(1);
    const finalUpdate = fake.sessionUpdates[fake.sessionUpdates.length - 1];
    expect(finalUpdate.status).toBe("completed");
    expect(holder.sentTexts[0].body).toContain("stock updated for 1 item");
  });

  it("REVIEW: parks the session without touching stock", async () => {
    const fake = makeFakeDb({
      settings: ENABLED,
      sessions: [{
        id: "s-3",
        tenantId: "t-1",
        userId: base.waPhoneNumber,
        source: "whatsapp",
        status: "completed",
        appliedToInventory: false,
        detectedItems: [{ label: "Indomie Pack", count: 12, confidence: 0.99 }],
      }],
    });
    holder.db = fake.db;
    const out = await handleStocktakeApplyReply({ ...base, command: "REVIEW" });
    expect(out.outcome).toBe("review_requested");
    expect(fake.productUpdates).toHaveLength(0);
    expect(fake.sessionUpdates.some((u) => u.status === "review_needed")).toBe(true);
    expect(holder.sentTexts[0].body).toContain("No stock was changed");
  });
});
