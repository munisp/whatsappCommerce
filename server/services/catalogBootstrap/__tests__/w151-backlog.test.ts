/**
 * W15.1 backlog tests — catalogBootstrap:
 *  1. confirm-claim race: concurrent double-confirm settles once; the loser
 *     gets confirm_in_progress (not alreadyConfirmed + empty productIds); a
 *     wedged draft (SKU-unique collision from a lost race) self-heals by
 *     adopting the products its twin confirm already created.
 *  2. confirm edits share the extraction upper price bound (MAX_PRICE_CENTS).
 *  3. extraction output is capped at MAX_DRAFT_ITEMS with a truncation flag.
 */
import { describe, it, expect } from "vitest";
import {
  bootstrapCatalogFromImage,
  confirmCatalogDraft,
  getCatalogDraft,
  MAX_DRAFT_ITEMS,
  MAX_PRICE_CENTS,
} from "../index";
import type { CatalogDraftStore, StoredCatalogDraft } from "../store";
import { makeFakeHttp } from "../../compliance/fakeHttp";

const T1 = "tenant-1";
const NOW = new Date("2025-06-01T00:00:00Z");

interface MemProduct {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  price: string;
  currency: string;
  metadata?: Record<string, unknown> | null;
}

function makeStore(opts: {
  /** Simulate the products_tenant_sku_idx unique backstop. */
  enforceSkuUnique?: boolean;
  /** Defer the first createProduct batch until release() is called. */
  gateFirstCreate?: boolean;
} = {}) {
  const drafts = new Map<string, StoredCatalogDraft>();
  const products: MemProduct[] = [];
  let gate: Promise<void> | null = null;
  let release: () => void = () => {};
  if (opts.gateFirstCreate) gate = new Promise((r) => (release = r));
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
    async listCatalogNames() { return []; },
    async createProduct(input) {
      if (gate) { await gate; gate = null; }
      if (opts.enforceSkuUnique && products.some((p) => p.tenantId === input.tenantId && p.sku === input.sku)) {
        throw new Error(`duplicate key value violates unique constraint "products_tenant_sku_idx"`);
      }
      const id = `prod-${products.length + 1}`;
      products.push({ id, ...input });
      return id;
    },
    async findProductsBySkus(tenantId, skus) {
      return products
        .filter((p) => p.tenantId === tenantId && skus.includes(p.sku))
        .map((p) => ({ id: p.id, sku: p.sku, price: p.price, metadata: p.metadata ?? null }));
    },
  };
  return { store, drafts, products, release };
}

const ENV_HTTP = {
  CATALOG_EXTRACTION_PROVIDER: "customHttp",
  CATALOG_EXTRACTION_ENDPOINT: "https://vision.example.test/extract",
} as NodeJS.ProcessEnv;

const IMG = { tenantId: T1, imageUrl: "https://cdn.example.test/list.jpg" };

async function bootedDraft(items: unknown[], store: CatalogDraftStore) {
  const http = makeFakeHttp({
    routes: { "https://vision.example.test": { status: 200, body: { items } } },
  });
  const res = await bootstrapCatalogFromImage(IMG, { env: ENV_HTTP, http, store, now: () => NOW });
  if (!res.ok) throw new Error(res.error);
  return res;
}

describe("confirm-claim race (W15.1)", () => {
  it("concurrent double-confirm settles once; loser gets confirm_in_progress; retry returns the same productIds", async () => {
    const m = makeStore({ gateFirstCreate: true, enforceSkuUnique: true });
    const { draftId } = await bootedDraft([{ name: "Rice", price: "₦1,000" }], m.store);

    const firstP = confirmCatalogDraft({ tenantId: T1, draftId }, { store: m.store, now: () => NOW });
    // Let the first confirm claim + reach the gated createProduct.
    await new Promise((r) => setTimeout(r, 10));
    const second = await confirmCatalogDraft({ tenantId: T1, draftId }, { store: m.store, now: () => NOW });
    // In-flight confirm is DISTINCT from a finished one.
    expect(second).toEqual({ ok: false, error: "confirm_in_progress" });

    m.release();
    const first = await firstP;
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.productIds).toHaveLength(1);
    expect(m.products).toHaveLength(1);

    // A later confirm is idempotent and returns the SAME productIds.
    const third = await confirmCatalogDraft({ tenantId: T1, draftId }, { store: m.store, now: () => NOW });
    expect(third.ok && third.alreadyConfirmed).toBe(true);
    expect(third.ok && third.productIds).toEqual(first.productIds);
    expect(m.products).toHaveLength(1);
  });

  it("a wedged draft (SKU collision from a lost race) self-heals by adopting its own products", async () => {
    const m = makeStore({ enforceSkuUnique: true });
    const { draftId } = await bootedDraft(
      [{ name: "Rice", price: "₦1,000" }, { name: "Beans", price: "₦2,000" }],
      m.store,
    );

    // Simulate the wedged state: the draft is back to 'pending' but a twin
    // confirm already created the products (with provenance metadata).
    const draft = (await m.store.loadDraft(T1, draftId))!;
    const plannedSkus = draft.items.map(
      (it, i) => it.sku ?? `CB-${draft.id.slice(3, 9).toUpperCase()}-${String(i + 1).padStart(3, "0")}`,
    );
    for (let i = 0; i < draft.items.length; i++) {
      m.products.push({
        id: `twin-${i + 1}`,
        tenantId: T1,
        sku: plannedSkus[i],
        name: draft.items[i].name,
        price: (draft.items[i].priceCents / 100).toFixed(2),
        currency: draft.items[i].currency,
        metadata: { source: "catalogBootstrap", draftId: draft.id, itemId: draft.items[i].id },
      });
    }

    const res = await confirmCatalogDraft({ tenantId: T1, draftId }, { store: m.store, now: () => NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyConfirmed).toBe(true);
    expect(res.productIds).toEqual(["twin-1", "twin-2"]);
    expect(m.products).toHaveLength(2); // no duplicates created

    // The draft is now durably confirmed with the adopted ids.
    const after = await getCatalogDraft({ tenantId: T1, draftId }, { store: m.store, now: () => NOW });
    expect(after.ok && after.draft.status).toBe("confirmed");
    expect(after.ok && after.draft.confirmedProductIds).toEqual(["twin-1", "twin-2"]);
  });

  it("does NOT heal a foreign SKU collision (different provenance and price) — rolls back to pending", async () => {
    const m = makeStore({ enforceSkuUnique: true });
    const { draftId } = await bootedDraft([{ name: "Rice", price: "₦1,000" }], m.store);
    const draft = (await m.store.loadDraft(T1, draftId))!;
    const sku = `CB-${draft.id.slice(3, 9).toUpperCase()}-001`;
    // A genuinely different product owns the SKU.
    m.products.push({
      id: "foreign-1", tenantId: T1, sku, name: "Something else",
      price: "9999.00", currency: "NGN", metadata: null,
    });

    const res = await confirmCatalogDraft({ tenantId: T1, draftId }, { store: m.store, now: () => NOW });
    expect(res).toEqual({ ok: false, error: "product_create_failed" });
    const after = await getCatalogDraft({ tenantId: T1, draftId }, { store: m.store, now: () => NOW });
    expect(after.ok && after.draft.status).toBe("pending");
    expect(m.products).toHaveLength(1);
  });
});

describe("confirm edit price bound (W15.1)", () => {
  it("ignores edits above the extraction upper bound (MAX_PRICE_CENTS)", async () => {
    const m = makeStore();
    const { draftId, items } = await bootedDraft([{ name: "Rice", price: "₦1,000" }], m.store);
    const res = await confirmCatalogDraft(
      {
        tenantId: T1,
        draftId,
        edits: { [items[0].id]: { priceCents: MAX_PRICE_CENTS + 1 } },
      },
      { store: m.store, now: () => NOW },
    );
    expect(res.ok).toBe(true);
    // Over-bound edit ignored → drafted price stands.
    expect(m.products[0].price).toBe("1000.00");
  });

  it("accepts an edit exactly at the upper bound", async () => {
    const m = makeStore();
    const { draftId, items } = await bootedDraft([{ name: "Rice", price: "₦1,000" }], m.store);
    const res = await confirmCatalogDraft(
      { tenantId: T1, draftId, edits: { [items[0].id]: { priceCents: MAX_PRICE_CENTS } } },
      { store: m.store, now: () => NOW },
    );
    expect(res.ok).toBe(true);
    expect(m.products[0].price).toBe((MAX_PRICE_CENTS / 100).toFixed(2));
  });
});

describe("extraction items cap (W15.1)", () => {
  it("caps parsed items at MAX_DRAFT_ITEMS and flags truncation", async () => {
    const m = makeStore();
    const many = Array.from({ length: MAX_DRAFT_ITEMS + 50 }, (_, i) => ({
      name: `Item ${i + 1}`,
      price: "₦100",
    }));
    const res = await bootedDraft(many, m.store);
    expect(res.items).toHaveLength(MAX_DRAFT_ITEMS);
    expect(res.truncated).toBe(true);
    // The persisted draft is capped too.
    const draft = (await m.store.loadDraft(T1, res.draftId))!;
    expect(draft.items).toHaveLength(MAX_DRAFT_ITEMS);
  });

  it("does not flag truncation at or under the cap", async () => {
    const m = makeStore();
    const res = await bootedDraft([{ name: "Rice", price: "₦1,000" }], m.store);
    expect(res.truncated).toBeUndefined();
  });
});
