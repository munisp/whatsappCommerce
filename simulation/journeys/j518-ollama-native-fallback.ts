// === W50 IMAGES ===
/**
 * J518 — W50 images (Coder C): when the OpenAI-compatible
 * /v1/images/generations endpoint 404s (older/native Ollama), the service
 * falls back to POST /api/generate with an image-capable model and parses the
 * native { images: [b64] } response. The custom OLLAMA_IMAGE_MODEL env is
 * honored on both endpoints.
 */
import { eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const HOST = "ollama-j518.example.com";
const PNG_B64 = Buffer.from("sim-png-bytes-j518").toString("base64");

export const journey: Journey = {
  id: "J518",
  name: "Ollama native /api/generate fallback after images 404",
  feature: "W50 IMAGES: native Ollama fallback",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { maybeGenerateProductImage } = await import("../../server/services/productImageGen");

    process.env.OLLAMA_URL = `http://${HOST}`;
    process.env.OLLAMA_IMAGE_MODEL = "qwen-image-v2";

    erp.script(HOST, (body) => {
      if (body && body.stream === false) {
        // Native /api/generate request.
        return { json: { model: body.model, images: [PNG_B64] } };
      }
      // OpenAI-compatible endpoint not available on this server.
      return { status: 404, json: { error: "unknown endpoint" } };
    });

    await world.db.insert(schema.products).values({
      id: "p-j518", tenantId: TENANT_ID, sku: "SIM-J518-A", name: "J518 Kilishi",
      description: "spiced dried beef", price: "80.00", currency: "NGN",
      status: "active", stockQuantity: 4,
    }).onConflictDoNothing();

    const puts: string[] = [];
    const putImpl = async (key: string, data: Buffer, contentType: string) => {
      puts.push(key);
      assert(data.equals(Buffer.from("sim-png-bytes-j518")), "native base64 decoded to bytes");
      return { key, url: `/api/storage/${key}` };
    };

    const res = await maybeGenerateProductImage(world.db, { tenantId: TENANT_ID, productId: "p-j518" }, { putImpl });
    assert(res.ok, `native fallback generated an image (got ${JSON.stringify(res)})`);

    const calls = erp.calls.filter((c) => c.url.includes(HOST));
    assert(calls.length === 2, `both endpoints tried (got ${calls.length})`);
    assertIncludes(calls[0].url, "/v1/images/generations", "OpenAI-compatible endpoint tried first");
    assertIncludes(calls[1].url, "/api/generate", "native endpoint used after 404");
    assert((calls[1].body as any).model === "qwen-image-v2", "OLLAMA_IMAGE_MODEL honored");

    const [p] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-j518")).limit(1);
    assert(p.imageUrl === `/api/storage/product-images/${TENANT_ID}/p-j518.png`, "imageUrl persisted from native fallback");
    assert((p.metadata as any)?.imageSource === "ai-ollama-qwen", "provenance stamped");

    delete process.env.OLLAMA_IMAGE_MODEL;
    erp.handlers.delete(HOST);
  },
};
