// === W50 IMAGES ===
/**
 * J517 — W50 images (Coder C, Q2a): local Ollama Qwen image generation,
 * OpenAI-compatible success path. A product WITHOUT imageUrl is generated an
 * image via POST {OLLAMA_URL}/v1/images/generations (model qwen-image,
 * journey-local host mock), bytes land in the product-images namespace
 * (putImpl spy), and products.imageUrl + metadata.imageSource=ai-ollama-qwen
 * are stamped. Zero external API cost — a local model; the Forge/GPT seam in
 * server/_core/imageGeneration.ts stays unwired.
 */
import { eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const HOST = "ollama-j517.example.com";
const PNG_B64 = Buffer.from("sim-png-bytes-j517").toString("base64");

export const journey: Journey = {
  id: "J517",
  name: "Ollama /v1/images/generations success path stamps imageUrl",
  feature: "W50 IMAGES Q2a: local Ollama Qwen image generation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { maybeGenerateProductImage, buildImagePrompt } = await import("../../server/services/productImageGen");

    process.env.OLLAMA_URL = `http://${HOST}`;
    delete process.env.OLLAMA_IMAGE_MODEL;

    erp.script(HOST, (body) => {
      // OpenAI-compatible images endpoint request shape.
      if (body && typeof body.prompt === "string" && body.n === 1) {
        return { json: { data: [{ b64_json: PNG_B64 }] } };
      }
      return { status: 404, json: { error: "not found" } };
    });

    await world.db.insert(schema.products).values({
      id: "p-j517", tenantId: TENANT_ID, sku: "SIM-J517-A", name: "J517 Shea Butter",
      description: "raw unrefined shea butter", category: "j517beauty",
      price: "150.00", currency: "NGN", status: "active", stockQuantity: 10,
    }).onConflictDoNothing();

    const puts: Array<{ key: string; bytes: number; contentType: string }> = [];
    const putImpl = async (key: string, data: Buffer, contentType: string) => {
      puts.push({ key, bytes: data.length, contentType });
      return { key, url: `/api/storage/${key}` };
    };

    const res = await maybeGenerateProductImage(world.db, { tenantId: TENANT_ID, productId: "p-j517" }, { putImpl });
    assert(res.ok && res.imageUrl === `/api/storage/product-images/${TENANT_ID}/p-j517.png`,
      `image generated + stored (got ${JSON.stringify(res)})`);

    // Prompt contract: concise e-commerce prompt.
    const call = erp.calls.find((c) => c.url.includes(HOST));
    assert(call, "ollama host called");
    assertIncludes(call!.url, "/v1/images/generations", "OpenAI-compatible endpoint used first");
    assert((call!.body as any).model === "qwen-image", "default qwen-image model");
    assertIncludes((call!.body as any).prompt, "Product photo of J517 Shea Butter", "prompt leads with the product");
    assertIncludes((call!.body as any).prompt, "clean studio white background, e-commerce catalog style", "studio/catalog style suffix");
    assertIncludes(buildImagePrompt({ name: "X", variant: "500g" }), "500g", "variant/size folded into prompt");

    assert(puts.length === 1 && puts[0].bytes === Buffer.from("sim-png-bytes-j517").length, "decoded bytes stored");
    const [p] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-j517")).limit(1);
    assert(p.imageUrl === `/api/storage/product-images/${TENANT_ID}/p-j517.png`, "products.imageUrl persisted");
    assert((p.metadata as any)?.imageSource === "ai-ollama-qwen", "provenance imageSource=ai-ollama-qwen");

    erp.handlers.delete(HOST);
  },
};
