// === W49 RICHMEDIA (RICH-11) ===
/**
 * Meta /media upload cache. Uploading an image buffer/URL to
 * POST /{phoneNumberId}/media once yields a reusable media id (~30-day TTL);
 * caching it in wa_media_id_cache avoids Meta re-fetching the link on every
 * send and sidesteps any flakiness of link fetches.
 *
 * Fail-open everywhere: a cache miss/upload failure returns null and callers
 * fall back to the link form. Money paths never touch this module.
 */
import { and, eq, gt } from "drizzle-orm";
import type { getDb } from "../db";
import { waMediaIdCache } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Meta media ids live ~30 days; refresh after 29 to be safe. */
const MEDIA_ID_TTL_MS = 29 * 24 * 3600 * 1000;

/** Cached, unexpired media id for (tenantId, imageUrl), or null. */
export async function lookupWaMediaId(db: Db, tenantId: string, imageUrl: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ mediaId: waMediaIdCache.mediaId })
      .from(waMediaIdCache)
      .where(and(eq(waMediaIdCache.tenantId, tenantId), eq(waMediaIdCache.imageUrl, imageUrl), gt(waMediaIdCache.expiresAt, new Date())))
      .limit(1);
    return row?.mediaId ?? null;
  } catch {
    return null; // fail-open (table may not exist pre-migration)
  }
}

/** Record/refresh a media id (upsert on the tenant+url unique index). */
export async function recordWaMediaId(db: Db, tenantId: string, imageUrl: string, mediaId: string): Promise<void> {
  try {
    await db
      .insert(waMediaIdCache)
      .values({ tenantId, imageUrl, mediaId, expiresAt: new Date(Date.now() + MEDIA_ID_TTL_MS) })
      .onConflictDoUpdate({
        target: [waMediaIdCache.tenantId, waMediaIdCache.imageUrl],
        set: { mediaId, expiresAt: new Date(Date.now() + MEDIA_ID_TTL_MS) },
      });
  } catch (e: any) {
    console.warn("[waMediaCache] record failed (fail-open):", e?.message);
  }
}

/**
 * Resolve a send-by-id for an absolute image URL: cache hit → id; otherwise
 * upload the image bytes to Meta /media, cache, return id. Any failure →
 * null (caller sends the link form). Never throws.
 */
export async function getOrUploadWaMediaId(tenantId: string, imageUrl: string): Promise<string | null> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return null;
    const cached = await lookupWaMediaId(db, tenantId, imageUrl);
    if (cached) return cached;

    const { resolveTenantWaCredentials } = await import("./waSender");
    const creds = await resolveTenantWaCredentials(tenantId);
    if (!creds) return null;

    // Fetch the image bytes (bounded), then multipart-upload to Meta.
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return null; // WA image cap 5MB
    const type = img.headers.get("content-type") ?? "image/jpeg";

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", type);
    form.append("file", new Blob([new Uint8Array(buf)], { type }), "image");
    const res = await fetch(`https://graph.facebook.com/v21.0/${creds.phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as any;
    const mediaId = typeof data?.id === "string" ? data.id : null;
    if (mediaId) await recordWaMediaId(db, tenantId, imageUrl, mediaId);
    return mediaId;
  } catch {
    return null; // fail-open
  }
}
// === END W49 RICHMEDIA ===
