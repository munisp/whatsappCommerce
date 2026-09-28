// === W50 IMAGES ===
/**
 * J520 — W50 images (Coder C): provenance + idempotency + manual
 * regeneration.
 *   1. Provenance union: wa-photo / medusa / upload imageSource values all
 *      land on products.metadata.imageSource (send paths/UI can badge
 *      AI-generated images — NDPR/consumer transparency).
 *   2. Idempotent skip: imageUrl already set → { reason:"already_has_image" },
 *      no Ollama call.
 *   3. products.generateImage tRPC mutation with force=true regenerates and
 *      overwrites imageUrl, preserving unrelated metadata keys.
 */
import { eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, TENANT_ID, type World } from "../world";
import { adminCaller } from "./helpers";
import type { Journey } from "../runner";

const HOST = "ollama-j520.example.com";
const PNG_B64 = Buffer.from("sim-png-bytes-j520").toString("base64");

export const journey: Journey = {
  id: "J520",
  name: "image provenance union + idempotent skip + force regeneration",
  feature: "W50 IMAGES: provenance metadata + products.generateImage",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { maybeGenerateProductImage } = await import("../../server/services/productImageGen");

    // ── 1. Provenance union across sources ───────────────────────────────
    await world.db.insert(schema.products).values([
      { id: "p-j520-wa", tenantId: TENANT_ID, sku: "SIM-J520-WA", name: "WA Photo Item", price: "1.00", currency: "NGN", status: "active", stockQuantity: 0, imageUrl: `/api/storage/product-images/${TENANT_ID}/p-j520-wa.jpg`, metadata: { imageSource: "wa-photo" } },
      { id: "p-j520-med", tenantId: TENANT_ID, sku: "SIM-J520-MED", name: "Medusa Item", price: "2.00", currency: "NGN", status: "active", stockQuantity: 0, imageUrl: "https://cdn.medusa-j520.example.com/x.jpg", metadata: { imageSource: "medusa" } },
      { id: "p-j520-up", tenantId: TENANT_ID, sku: "SIM-J520-UP", name: "Upload Item", price: "3.00", currency: "NGN", status: "active", stockQuantity: 0, imageUrl: "https://cdn.j520.example.com/up.jpg", metadata: { imageSource: "upload" } },
      { id: "p-j520", tenantId: TENANT_ID, sku: "SIM-J520-A", name: "J520 Force Item", price: "4.00", currency: "NGN", status: "active", stockQuantity: 0, imageUrl: "https://cdn.j520.example.com/old.jpg", metadata: { imageSource: "upload", color: "red" } },
    ]).onConflictDoNothing();
    const rows = await world.db.select().from(schema.products)
      .where(eq(schema.products.tenantId, TENANT_ID));
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    for (const [id, src] of [["p-j520-wa", "wa-photo"], ["p-j520-med", "medusa"], ["p-j520-up", "upload"]] as const) {
      assert((byId.get(id)!.metadata as any)?.imageSource === src, `provenance ${src} persisted`);
    }

    // ── 2. Idempotent skip when imageUrl is set ──────────────────────────
    process.env.OLLAMA_URL = `http://${HOST}`;
    let ollamaCalls = 0;
    erp.script(HOST, () => { ollamaCalls += 1; return { json: { data: [{ b64_json: PNG_B64 }] } }; });
    const skip = await maybeGenerateProductImage(world.db, { tenantId: TENANT_ID, productId: "p-j520-up" });
    assert(skip.ok && skip.reason === "already_has_image", `skip when image exists (got ${JSON.stringify(skip)})`);
    assert(skip.imageUrl === "https://cdn.j520.example.com/up.jpg", "existing imageUrl returned untouched");
    assert(ollamaCalls === 0, "no Ollama call on skip");

    // ── 3. Manual regeneration via the tRPC mutation (force=true) ────────
    const puts: string[] = [];
    // The tRPC path uses the default storagePut; sim has no MinIO, so prove
    // the service-level force path with a spy put, then prove the mutation
    // itself is wired (it delegates to the same service and fails open when
    // storage is unavailable).
    const forced = await maybeGenerateProductImage(world.db, {
      tenantId: TENANT_ID, productId: "p-j520", force: true,
    }, {
      putImpl: async (key, data, contentType) => {
        puts.push(key);
        return { key, url: `/api/storage/${key}` };
      },
    });
    assert(forced.ok, `force=true regenerates despite existing image (got ${JSON.stringify(forced)})`);
    assert(ollamaCalls === 1, "Ollama called for the forced regeneration");
    const [p] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-j520")).limit(1);
    assert(p.imageUrl === `/api/storage/product-images/${TENANT_ID}/p-j520.png`, "imageUrl overwritten");
    assert((p.metadata as any)?.imageSource === "ai-ollama-qwen", "provenance flips to ai-ollama-qwen");
    assert((p.metadata as any)?.color === "red", "unrelated metadata keys preserved on merge");

    // tRPC mutation is wired end-to-end (admin caller; storage degrades
    // fail-open in sim where MinIO is absent, so ok may be false — the
    // contract being proven is that the route exists, auth passes, and it
    // never throws 500s on infra absence).
    const caller = await adminCaller();
    const viaTrpc = await caller.product.generateImage({ tenantId: TENANT_ID, id: "p-j520-up", force: true });
    assert(typeof viaTrpc.ok === "boolean", "products.generateImage returns a structured result");
    assert(ollamaCalls >= 2, "mutation reached the Ollama seam");

    erp.handlers.delete(HOST);
    delete process.env.OLLAMA_URL;
  },
};
