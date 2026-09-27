// === W49 RICHMEDIA ===
/**
 * J489 — RICH-3: relative /api/storage URLs are absolutized before reaching
 * Meta/Telegram, and the product-images namespace is publicly servable.
 *
 *   1. publicMediaUrl: https passthrough, /api/* prefixed with PUBLIC_APP_URL,
 *      null (skip) when no base configured — never a guaranteed-400 relative
 *      link to the Graph API.
 *   2. storageSecurity.isPublicStorageKey gates exactly the catalog-public
 *      namespaces (product-images, tenant-branding) and nothing else.
 *   3. End-to-end: a WA media send with a relative link is captured by the
 *      metaMock with an absolute https URL.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J489",
  name: "publicMediaUrl absolutizes /api/storage links; product-images namespace public",
  feature: "RICH-3",
  async run(world: World) {
    const { publicMediaUrl } = await import("../../server/services/richMedia");
    const { isPublicStorageKey } = await import("../../server/services/storageSecurity");

    const prev = process.env.PUBLIC_APP_URL;
    process.env.PUBLIC_APP_URL = "https://shop.example.com/";
    try {
      assert(publicMediaUrl("https://cdn.x.com/a.jpg") === "https://cdn.x.com/a.jpg", "absolute https passthrough");
      assert(
        publicMediaUrl("/api/storage/product-images/a.jpg") === "https://shop.example.com/api/storage/product-images/a.jpg",
        "relative storage URL absolutized (trailing slash on base handled)",
      );
      assert(publicMediaUrl("") === null && publicMediaUrl("data:image/png;base64,xx") === null, "junk rejected");
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = prev;
    }

    // Namespace gate: catalog-public only.
    assert(isPublicStorageKey("product-images/t1/a.jpg"), "product-images is public");
    assert(isPublicStorageKey("tenant-branding/t1/logo.png"), "tenant-branding (logo banner) is public");
    assert(!isPublicStorageKey("kyc/t1/id.jpg"), "kyc stays gated");
    assert(!isPublicStorageKey("evidence/x/y.pdf"), "evidence stays gated");
    assert(!isPublicStorageKey(""), "empty key not public");

    // End-to-end WA media send with a relative URL.
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    const { sendWhatsAppMedia } = await import("../../server/services/waSender");
    const phone = "+2348017000489";
    await sendWhatsAppMedia(TENANT_ID, phone, {
      type: "image",
      link: publicMediaUrl("/api/storage/product-images/b.jpg")!,
      caption: "hi",
    });
    const img = world.outbound.lastOfType("image", phone.replace("+", ""));
    assert(img?.body?.image?.link?.startsWith("https://"), `Graph received an absolute link (got ${img?.body?.image?.link})`);

    // ── RICH-11: Meta mediaId cache round trip (additive 0173 table) ──────
    const { recordWaMediaId, lookupWaMediaId } = await import("../../server/services/waMediaCache");
    const url = "https://shop.example.com/api/storage/product-images/cache-me.jpg";
    assert((await lookupWaMediaId(world.db, TENANT_ID, url)) === null, "cache miss before upload");
    await recordWaMediaId(world.db, TENANT_ID, url, "mid-489");
    assert((await lookupWaMediaId(world.db, TENANT_ID, url)) === "mid-489", "cache hit after record");
    await recordWaMediaId(world.db, TENANT_ID, url, "mid-489b"); // upsert refresh
    assert((await lookupWaMediaId(world.db, TENANT_ID, url)) === "mid-489b", "upsert refreshes the id");
    assert((await lookupWaMediaId(world.db, "other-tenant", url)) === null, "cache is tenant-scoped");
  },
};
