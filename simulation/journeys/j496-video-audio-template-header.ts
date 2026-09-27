// === W49 RICHMEDIA ===
/**
 * J496 — RICH-13 + RICH-14: extended WA media types and template image
 * headers.
 *
 *   1. sendWhatsAppMedia now accepts video (with caption) and audio
 *      (caption stripped — the API has none) by link or mediaId.
 *   2. buildMediaPayload still rejects nonsense types and link+id conflicts.
 *   3. sendWhatsAppTemplate passes image-header components through verbatim
 *      (capability was latent — cartRecovery/broadcast can now send branded
 *      template headers).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J496",
  name: "video/audio media types + template image headers",
  feature: "RICH-13/RICH-14",
  async run(world: World) {
    const { sendWhatsAppMedia, buildMediaPayload, sendWhatsAppTemplate } = await import("../../server/services/waSender");
    const phone = "+2348017000496";

    // 1. video + audio sends.
    await sendWhatsAppMedia(TENANT_ID, phone, { type: "video", link: "https://cdn.example.com/howto.mp4", caption: "How to tie gele" });
    const vid = world.outbound.lastOfType("video", phone.replace("+", ""));
    assert(vid?.body?.video?.link === "https://cdn.example.com/howto.mp4", "video by link");
    assert(vid?.body?.video?.caption === "How to tie gele", "video caption");

    await sendWhatsAppMedia(TENANT_ID, phone, { type: "audio", mediaId: "mid-496", caption: "ignored" });
    const aud = world.outbound.lastOfType("audio", phone.replace("+", ""));
    assert(aud?.body?.audio?.id === "mid-496", "audio by mediaId");
    assert(!("caption" in (aud?.body?.audio ?? {})), "audio has no caption field");

    // 2. builder honesty.
    let threw = false;
    try { buildMediaPayload({ type: "sticker" as any, link: "https://x.co/s.webp" }); } catch { threw = true; }
    assert(threw, "unknown media type rejected");
    threw = false;
    try { buildMediaPayload({ type: "video", link: "https://x.co/v.mp4", mediaId: "m1" }); } catch { threw = true; }
    assert(threw, "link+mediaId conflict rejected");

    // 3. template with an image header component passes through.
    await sendWhatsAppTemplate(TENANT_ID, phone, "wac_cart_recovery", "en_US", [
      { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example.com/brand.jpg" } }] },
      { type: "body", parameters: [{ type: "text", text: "Sim Store" }] },
    ], { notifType: "cart_recovery" });
    const tpl = world.outbound.lastOfType("template", phone.replace("+", ""));
    const comps = (tpl!.body as any).template.components;
    assert(comps?.[0]?.type === "header" && comps[0].parameters[0].image.link === "https://cdn.example.com/brand.jpg", "image header component passed through");
  },
};
