// === W64 intelligence ===
/**
 * J618 — R3 photo-first web listing (catalogAI.draftFromPhoto path):
 *   1. Mock the world.llm vision completion (title/desc/category/priceCents
 *      JSON) → llmVisionAdapter.analyzeProductPhoto parses it.
 *   2. createDraft persists a pending_confirm draft (confirm-edit contract).
 *   3. publishDraft creates a real ACTIVE product and marks the draft
 *      published (existing publish path, unchanged).
 */
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J618",
  name: "photo listing: vision draft pending_confirm → publishDraft → product",
  feature: "W64 intelligence R3: catalogAI photo-first web listing",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { llmVisionAdapter, createDraft, publishDraft } = await import("../../server/services/catalogAI");
    const { eq } = await import("drizzle-orm");
    world.llm.when("Analyse this product photo", {
      title: "J618 Ankara Fabric 6 Yards",
      description: "Vibrant ankara print, 100% cotton, 6 yards.",
      category: "fashion",
      priceCents: 450000,
      confidence: 92,
    });
    // Bound the fail-open Ollama image-generation fallback (no photo mediaId
    // on web drafts → publish attempts local generation; unreachable in sim).
    const prevTimeout = process.env.OLLAMA_IMAGE_TIMEOUT_MS;
    process.env.OLLAMA_IMAGE_TIMEOUT_MS = "50";
    let draftId: string | null = null;
    try {
      // ── 1+2. Vision analysis → pending_confirm draft ───────────────────
      const analysis = await llmVisionAdapter.analyzeProductPhoto({
        imageBase64: Buffer.from("fake-jpeg-bytes-j618").toString("base64"),
        mimeType: "image/jpeg",
      });
      assert(analysis.title === "J618 Ankara Fabric 6 Yards", `vision title parsed (got ${analysis.title})`);
      assert(analysis.priceCents === 450000, `vision price parsed (got ${analysis.priceCents})`);

      const draft = await createDraft(world.db, {
        tenantId: TENANT_ID,
        source: "photo",
        merchantPhone: "web:j618",
        listing: {
          name: analysis.title,
          description: analysis.description,
          category: analysis.category,
          priceCents: analysis.priceCents,
        },
        rawExtraction: { ...analysis, channel: "web" },
      });
      draftId = draft.id;
      assert(draft.status === "pending_confirm", `draft pending_confirm (got ${draft.status})`);

      // ── 3. Publish via the existing confirm path → product exists ──────
      const pub = await publishDraft(world.db, draft.id, "portal:j618");
      assert(pub.ok && pub.productId, `publish ok (got ${JSON.stringify(pub)})`);
      const [product] = await world.db.select().from(schema.products)
        .where(eq(schema.products.id, pub.productId!)).limit(1);
      assert(product, "published product row exists");
      assert(product.name === "J618 Ankara Fabric 6 Yards", `product name (got ${product.name})`);
      assert(product.status === "active" && product.price === "4500.00", `product active at ₦4,500.00 (got ${product.status}/${product.price})`);
      const [after] = await world.db.select().from(schema.catalogAiDrafts)
        .where(eq(schema.catalogAiDrafts.id, draft.id)).limit(1);
      assert(after.status === "published" && after.productId === pub.productId, `draft published+linked (got ${after.status})`);
    } finally {
      if (prevTimeout === undefined) delete process.env.OLLAMA_IMAGE_TIMEOUT_MS;
      else process.env.OLLAMA_IMAGE_TIMEOUT_MS = prevTimeout;
      if (draftId) {
        const [d] = await world.db.select({ productId: schema.catalogAiDrafts.productId })
          .from(schema.catalogAiDrafts).where(eq(schema.catalogAiDrafts.id, draftId)).limit(1).catch(() => [] as any[]);
        await world.db.delete(schema.catalogAiDraftEvents).where(eq(schema.catalogAiDraftEvents.draftId, draftId)).catch(() => {});
        await world.db.delete(schema.catalogAiDrafts).where(eq(schema.catalogAiDrafts.id, draftId)).catch(() => {});
        if ((d as any)?.productId) {
          await world.db.delete(schema.products).where(eq(schema.products.id, (d as any).productId)).catch(() => {});
        }
      }
    }
  },
};
