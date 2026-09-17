// === W45 messaging-services (Coder A2) ===
/**
 * J357 — Inbound media mirror (MSG-6): mirrorInboundMedia inserts the
 * whatsapp_media_files row immediately, downloads the bytes from the Graph
 * API (mock CDN), and flips the row to the internal object-storage key —
 * covering image AND audio. When the download/mirror fails, the row keeps
 * the expiring Graph URL as an explicit fallback (mirrored=false).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import { scriptMedia } from "../metaMock";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J357",
  name: "inbound media mirror incl. audio",
  feature: "MSG-6 mirrorInboundMedia: object-storage mirror + Graph fallback",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { mirrorInboundMedia, mirroredMediaKey } = await import("../../server/services/inboundMediaMirror");
    const phone = world.newPhone("j357");

    const puts: Array<{ key: string; bytes: number; contentType: string }> = [];
    const putImpl = async (key: string, data: Buffer, contentType: string) => {
      puts.push({ key, bytes: data.length, contentType });
      return { key, url: `/api/storage/${key}` };
    };

    // ── Image mirrored end-to-end ───────────────────────────────────────
    scriptMedia("mid.j357.img", Buffer.from("fake-jpeg-bytes-j357"), "image/jpeg");
    const img = await mirrorInboundMedia(
      { tenantId: TENANT_ID, waPhoneNumber: phone, mediaId: "mid.j357.img", kind: "image", caption: "receipt?" },
      { putImpl },
    );
    assert(img.rowId, "image row inserted");
    assert(img.mirrored === true, "image mirrored to object storage");
    assert(img.storageUrl === `/api/storage/${mirroredMediaKey(TENANT_ID, "mid.j357.img")}`, "internal storage url");
    const [imgRow] = await world.db.select().from(schema.whatsappMediaFiles)
      .where(eq(schema.whatsappMediaFiles.id, img.rowId!));
    assert(imgRow.storageKey === mirroredMediaKey(TENANT_ID, "mid.j357.img"), "row carries internal key");
    assert(imgRow.fileSize === Buffer.from("fake-jpeg-bytes-j357").length, `fileSize recorded (got ${imgRow.fileSize})`);
    assert(imgRow.documentType === "image", "image documentType");
    assert(!String(imgRow.storageUrl).includes("graph.facebook.com"), "row no longer points at the expiring Graph URL");
    assert(puts[0]?.contentType === "image/jpeg", "content type preserved on put");

    // ── Audio (voice note) mirrored too — previously excluded ──────────
    scriptMedia("mid.j357.aud", Buffer.from("ogg-bytes-j357"), "audio/ogg");
    const aud = await mirrorInboundMedia(
      { tenantId: TENANT_ID, waPhoneNumber: phone, mediaId: "mid.j357.aud", kind: "audio", mimeType: "audio/ogg" },
      { putImpl },
    );
    assert(aud.mirrored === true, "audio mirrored");
    const [audRow] = await world.db.select().from(schema.whatsappMediaFiles)
      .where(eq(schema.whatsappMediaFiles.id, aud.rowId!));
    assert(audRow.documentType === "audio", "audio is a first-class media kind now");
    assert(audRow.mimeType === "audio/ogg", "audio mime recorded");

    // ── Mirror failure → Graph fallback retained, row still present ─────
    // (mid.j357.gone is never scripted → the Graph download 404s)
    const gone = await mirrorInboundMedia(
      { tenantId: TENANT_ID, waPhoneNumber: phone, mediaId: "mid.j357.gone", kind: "video" },
      { putImpl },
    );
    assert(gone.rowId, "row inserted even when the mirror fails");
    assert(gone.mirrored === false, "mirror failure is explicit");
    const [goneRow] = await world.db.select().from(schema.whatsappMediaFiles)
      .where(eq(schema.whatsappMediaFiles.id, gone.rowId!));
    assert(String(goneRow.storageUrl).includes("graph.facebook.com"), "Graph URL kept as the fallback");
    assert(puts.length === 2, "no object-storage put for a failed download");

    // ── MSG-24 fail-soft image reply helper (same seam family) ─────────
    const { replyImagePipelineFailed } = await import("../../server/services/imagePipelineFallback");
    const base = world.outbound.toPhone(phone).length;
    const ok = await replyImagePipelineFailed(TENANT_ID, phone);
    assert(ok, "fail-soft reply delivered");
    const msg = world.outbound.lastOfType("text", phone);
    assert(world.outbound.toPhone(phone).length > base, "fail-soft reply reached the customer");
    assertIncludes(JSON.stringify(msg?.body ?? {}), "couldn't process that photo", "localized fail-soft copy");
  },
};
