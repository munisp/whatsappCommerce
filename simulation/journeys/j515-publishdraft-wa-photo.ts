// === W50 IMAGES ===
/**
 * J515 — W50 images (Coder C, Q2c P0): publishDraft preserves the merchant's
 * own WhatsApp product photo. A photo draft carries mediaId; publish now
 * downloads the bytes via the Graph mock (scriptMedia), mirrors them into the
 * public product-images namespace (putImpl spy), and persists the
 * app-relative /api/storage/... URL on products.imageUrl with provenance
 * metadata.imageSource="wa-photo". A voice draft (no photo) does NOT put
 * anything under that draft's product key.
 */
import { eq } from "drizzle-orm";
import { scriptMedia } from "../metaMock";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J515",
  name: "publishDraft preserves the merchant WA photo (P0)",
  feature: "W50 IMAGES Q2c: catalogAI photo preservation → products.imageUrl",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createDraft, publishDraft } = await import("../../server/services/catalogAI");
    const merchant = world.newPhone("j515");

    const puts: Array<{ key: string; bytes: number; contentType: string }> = [];
    const putImpl = async (key: string, data: Buffer, contentType: string) => {
      puts.push({ key, bytes: data.length, contentType });
      return { key, url: `/api/storage/${key}` };
    };

    // ── Photo draft: WA bytes survive publish ────────────────────────────
    scriptMedia("mid.j515.photo", Buffer.from("sim-jpeg-bytes-j515"), "image/jpeg");
    const draft = await createDraft(world.db, {
      tenantId: TENANT_ID,
      source: "photo",
      merchantPhone: merchant,
      mediaId: "mid.j515.photo",
      listing: { name: "J515 Ankara Fabric", description: "6 yards", category: "j515fabric", priceCents: 450000 },
    });
    const pub = await publishDraft(world.db, draft.id, merchant, undefined, { putImpl });
    assert(pub.ok, "photo draft publishes");
    const [product] = await world.db.select().from(schema.products)
      .where(eq(schema.products.id, pub.productId!)).limit(1);
    assert(product.imageUrl === `/api/storage/product-images/${TENANT_ID}/${pub.productId}.jpg`,
      `WA photo mirrored into product-images namespace (got ${product.imageUrl})`);
    assert((product.metadata as any)?.imageSource === "wa-photo", "provenance imageSource=wa-photo");
    assert((product.metadata as any)?.source === "catalog_ai", "catalog_ai provenance retained");
    const put = puts.find((x) => x.key === `product-images/${TENANT_ID}/${pub.productId}.jpg`);
    assert(put, "storagePut called for the WA photo");
    assert(put!.bytes === Buffer.from("sim-jpeg-bytes-j515").length, "full photo bytes stored");
    assert(put!.contentType === "image/jpeg", "photo mime preserved");

    // ── Idempotent republish: no second put, same imageUrl ───────────────
    const again = await publishDraft(world.db, draft.id, merchant, undefined, { putImpl });
    assert(again.ok && again.productId === pub.productId, "republish is idempotent");
    assert(puts.length === 1, "no duplicate storage put on republish");

    // ── Voice draft: no WA photo is attached as a product image ──────────
    // (AI generation is fail-open against the unreachable sim Ollama, so the
    // product simply saves without an image.)
    process.env.OLLAMA_URL = "http://ollama-j515.invalid";
    const voice = await createDraft(world.db, {
      tenantId: TENANT_ID,
      source: "voice",
      merchantPhone: merchant,
      transcript: "j515 yam tubers",
      mediaId: "mid.j515.voice", // audio mediaId must NOT become the image
      listing: { name: "J515 Yam Tubers", description: "bag of 12", category: "j515produce", priceCents: 300000 },
    });
    const pubVoice = await publishDraft(world.db, voice.id, merchant, undefined, { putImpl });
    assert(pubVoice.ok, "voice draft publishes");
    const [voiceProduct] = await world.db.select().from(schema.products)
      .where(eq(schema.products.id, pubVoice.productId!)).limit(1);
    assert(voiceProduct.imageUrl === null, "voice-note audio is never used as the product image");
    assert(!puts.some((x) => x.key.includes(pubVoice.productId!)), "no storage put for voice mediaId");
  },
};
