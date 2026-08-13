/**
 * W15 draft lifecycle tests — bootstrap → normalize → dedupe → confirm
 * (idempotent, claim-first) → reject/expire. In-memory store, fakeHttp.
 */
import { describe, it, expect } from "vitest";
import {
  bootstrapCatalogFromImage,
  confirmCatalogDraft,
  getCatalogDraft,
  rejectCatalogDraft,
  DRAFT_TTL_MS,
} from "../index";
import type { CatalogDraftStore, StoredCatalogDraft } from "../store";
import { makeFakeHttp } from "../../compliance/fakeHttp";

const T1 = "tenant-1";
const T2 = "tenant-2";
const NOW = new Date("2025-06-01T00:00:00Z");

function makeStore(existing: Array<{ id: string; name: string }> = []) {
  const drafts = new Map<string, StoredCatalogDraft>();
  const products: Array<{ id: string; tenantId: string; sku: string; name: string; price: string; currency: string }> = [];
  const store: CatalogDraftStore = {
    async saveDraft(d) { drafts.set(`${d.tenantId}:${d.id}`, { ...d }); },
    async loadDraft(tenantId, draftId) {
      const d = drafts.get(`${tenantId}:${draftId}`);
      return d ? { ...d } : null;
    },
    async updateDraft(d) { drafts.set(`${d.tenantId}:${d.id}`, { ...d }); },
    async claimDraftForConfirm(tenantId, draftId) {
      const key = `${tenantId}:${draftId}`;
      const d = drafts.get(key);
      if (!d) return null;
      if (d.status !== "pending") return "already";
      const next = { ...d, status: "confirming" as const };
      drafts.set(key, next);
      return next;
    },
    async listCatalogNames() { return existing; },
    async createProduct(input) {
      const id = `prod-${products.length + 1}`;
      products.push({ id, ...input });
      return id;
    },
  };
  return { store, drafts, products };
}

const ENV_HTTP = {
  CATALOG_EXTRACTION_PROVIDER: "customHttp",
  CATALOG_EXTRACTION_ENDPOINT: "https://vision.example.test/extract",
} as NodeJS.ProcessEnv;

function httpWith(items: unknown[]) {
  return makeFakeHttp({
    routes: { "https://vision.example.test": { status: 200, body: { items } } },
  });
}

const IMG = { tenantId: T1, imageUrl: "https://cdn.example.test/list.jpg" };

async function bootedDraft(items: unknown[], existing: Array<{ id: string; name: string }> = []) {
  const m = makeStore(existing);
  const res = await bootstrapCatalogFromImage(IMG, {
    env: ENV_HTTP, http: httpWith(items), store: m.store, now: () => NOW,
  });
  if (!res.ok) throw new Error(res.error);
  return { ...m, draftId: res.draftId, items: res.items };
}

describe("bootstrapCatalogFromImage", () => {
  it("disabled provider → extraction_disabled (no store write)", async () => {
    const m = makeStore();
    const res = await bootstrapCatalogFromImage(IMG, { env: {} as NodeJS.ProcessEnv, store: m.store });
    expect(res).toEqual({ ok: false, error: "extraction_disabled" });
    expect(m.drafts.size).toBe(0);
  });

  it("requires an image", async () => {
    const res = await bootstrapCatalogFromImage({ tenantId: T1 }, { env: ENV_HTTP, http: httpWith([]), store: makeStore().store });
    expect(res).toEqual({ ok: false, error: "image_required" });
  });

  it("extracts, normalizes and persists a pending draft", async () => {
    const { drafts, draftId, items } = await bootedDraft([
      { name: "• INDOMIE CHICKEN 70G", price: "₦250" },
      { name: "Rice 50kg", price: "₦65,000", confidence: 0.9 },
      { name: "???", price: "₦10" }, // dropped: unusable name
      { name: "No price here" },       // dropped: no price
    ]);
    expect(items.map((i) => i.name)).toEqual(["Indomie Chicken 70g", "Rice 50kg"]);
    expect(items[0].priceCents).toBe(25000);
    expect(items[0].currency).toBe("NGN");
    expect(items[1].confidence).toBeGreaterThan(items[0].confidence);
    const draft = drafts.get(`${T1}:${draftId}`)!;
    expect(draft.status).toBe("pending");
    expect(draft.expiresAt).toBe(new Date(NOW.getTime() + DRAFT_TTL_MS).toISOString());
  });

  it("upstream transport failure → extraction_failed", async () => {
    const http = makeFakeHttp({ routes: { "https://vision": { error: new Error("boom") } } });
    const res = await bootstrapCatalogFromImage(IMG, { env: ENV_HTTP, http, store: makeStore().store });
    expect(res).toEqual({ ok: false, error: "extraction_failed" });
  });

  it("empty extraction → no_items_extracted", async () => {
    const res = await bootstrapCatalogFromImage(IMG, { env: ENV_HTTP, http: httpWith([]), store: makeStore().store });
    expect(res).toEqual({ ok: false, error: "no_items_extracted" });
  });

  it("dedupes within the extraction, keeping the higher-confidence item", async () => {
    const { items } = await bootedDraft([
      { name: "Coca-Cola 50cl", price: "₦300" },
      { name: "coca cola 50cl", priceCents: 30000, confidence: 0.95 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBeGreaterThan(0.8);
  });

  it("flags duplicates against the existing catalog", async () => {
    const { drafts, draftId } = await bootedDraft(
      [{ name: "Rice 50kg", price: "₦65,000" }, { name: "Beans", price: "₦1,200" }],
      [{ id: "prod-existing", name: "rice  50kg" }],
    );
    expect(drafts.get(`${T1}:${draftId}`)!.duplicates).toEqual([
      { itemId: expect.any(String), existingProductId: "prod-existing", name: "Rice 50kg" },
    ]);
  });
});

describe("getCatalogDraft / tenant isolation", () => {
  it("returns the draft for its own tenant", async () => {
    const { store, draftId } = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const res = await getCatalogDraft({ tenantId: T1, draftId }, { store });
    expect(res.ok).toBe(true);
  });

  it("cross-tenant access → draft_not_found", async () => {
    const { store, draftId } = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const res = await getCatalogDraft({ tenantId: T2, draftId }, { store });
    expect(res).toEqual({ ok: false, error: "draft_not_found" });
  });

  it("lazily expires stale pending drafts", async () => {
    const { store, draftId } = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const later = new Date(NOW.getTime() + DRAFT_TTL_MS + 1000);
    const res = await getCatalogDraft({ tenantId: T1, draftId }, { store, now: () => later });
    expect(res.ok && res.draft.status).toBe("expired");
  });
});

describe("confirmCatalogDraft", () => {
  it("creates products with cents→decimal conversion and generated skus", async () => {
    const m = await bootedDraft([
      { name: "Indomie 70g", price: "₦250" },
      { name: "Sugar 1kg", price: "₦1,500/dozen" },
    ]);
    const res = await confirmCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: m.store, now: () => NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.productIds).toHaveLength(2);
    expect(m.products[0]).toMatchObject({ name: "Indomie 70g", price: "250.00", currency: "NGN" });
    expect(m.products[0].sku).toMatch(/^CB-/);
    expect(m.products[1].sku).toMatch(/^CB-/);
    expect(m.products[1].description).toMatch(/dozen/);
  });

  it("double-confirm returns alreadyConfirmed with no duplicate products", async () => {
    const m = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const first = await confirmCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: m.store, now: () => NOW });
    const second = await confirmCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: m.store, now: () => NOW });
    expect(first.ok && first.productIds).toHaveLength(1);
    expect(second.ok && second.alreadyConfirmed).toBe(true);
    expect(second.ok && second.productIds).toEqual(first.ok ? first.productIds : []);
    expect(m.products).toHaveLength(1);
  });

  it("approveItemIds whitelist limits what is published", async () => {
    const m = await bootedDraft([
      { name: "Rice", price: "₦1,000" },
      { name: "Beans", price: "₦2,000" },
    ]);
    const res = await confirmCatalogDraft(
      { tenantId: T1, draftId: m.draftId, approveItemIds: [m.items[0].id] },
      { store: m.store, now: () => NOW },
    );
    expect(res.ok).toBe(true);
    expect(m.products.map((p) => p.name)).toEqual(["Rice"]);
  });

  it("applies merchant edits before publishing", async () => {
    const m = await bootedDraft([{ name: "Rise", price: "₦1,000" }]);
    const res = await confirmCatalogDraft(
      { tenantId: T1, draftId: m.draftId, edits: { [m.items[0].id]: { name: "Rice 50kg", priceCents: 6500000, sku: "RICE-50" } } },
      { store: m.store, now: () => NOW },
    );
    expect(res.ok).toBe(true);
    expect(m.products[0]).toMatchObject({ name: "Rice 50kg", price: "65000.00", sku: "RICE-50" });
  });

  it("skips catalog duplicates and reports them", async () => {
    const m = await bootedDraft(
      [{ name: "Rice 50kg", price: "₦65,000" }, { name: "Beans", price: "₦1,200" }],
      [{ id: "prod-existing", name: "Rice 50kg" }],
    );
    const res = await confirmCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: m.store, now: () => NOW });
    expect(res.ok && res.skippedDuplicates).toHaveLength(1);
    expect(m.products.map((p) => p.name)).toEqual(["Beans"]);
  });

  it("cross-tenant confirm → draft_not_found, no products", async () => {
    const m = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const res = await confirmCatalogDraft({ tenantId: T2, draftId: m.draftId }, { store: m.store, now: () => NOW });
    expect(res).toEqual({ ok: false, error: "draft_not_found" });
    expect(m.products).toHaveLength(0);
  });

  it("expired draft cannot be confirmed", async () => {
    const m = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const later = new Date(NOW.getTime() + DRAFT_TTL_MS + 1000);
    const res = await confirmCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: m.store, now: () => later });
    expect(res).toEqual({ ok: false, error: "draft_expired" });
    expect(m.products).toHaveLength(0);
  });

  it("rolls the claim back to pending when product creation fails", async () => {
    const m = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const failing: CatalogDraftStore = {
      ...m.store,
      createProduct: async () => { throw new Error("db down"); },
    };
    const res = await confirmCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: failing, now: () => NOW });
    expect(res).toEqual({ ok: false, error: "product_create_failed" });
    const draft = await getCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: m.store, now: () => NOW });
    expect(draft.ok && draft.draft.status).toBe("pending");
  });
});

describe("rejectCatalogDraft", () => {
  it("rejects a pending draft and blocks later confirmation", async () => {
    const m = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const rej = await rejectCatalogDraft({ tenantId: T1, draftId: m.draftId, reason: "bad photo" }, { store: m.store, now: () => NOW });
    expect(rej).toEqual({ ok: true });
    const conf = await confirmCatalogDraft({ tenantId: T1, draftId: m.draftId }, { store: m.store, now: () => NOW });
    expect(conf.ok).toBe(false);
    if (!conf.ok) expect(conf.error).toMatch(/draft_not_confirmable:rejected/);
  });

  it("cross-tenant reject → draft_not_found", async () => {
    const m = await bootedDraft([{ name: "Rice", price: "₦1,000" }]);
    const res = await rejectCatalogDraft({ tenantId: T2, draftId: m.draftId }, { store: m.store, now: () => NOW });
    expect(res).toEqual({ ok: false, error: "draft_not_found" });
  });
});
