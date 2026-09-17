// === W45 messaging-services (Coder A2) ===
/**
 * inboundMediaMirror.ts — mirror inbound WhatsApp media to internal object
 * storage (MSG-6).
 *
 * Today the webhook stores `storageUrl = https://graph.facebook.com/.../{mediaId}`
 * — an EXPIRING Graph reference that 404s within days — and audio is excluded
 * from whatsapp_media_files entirely. This helper is the single seam the
 * webhook calls for EVERY inbound media message (image, document, video,
 * audio):
 *
 *   1. Insert the whatsapp_media_files row immediately (Graph URL as the
 *      fallback storageUrl, so downstream consumers never lose the media).
 *   2. Download the bytes from the Graph API with the tenant's credentials
 *      (two-step: GET /{mediaId} → { url }, then GET url).
 *   3. storagePut the bytes under `wa-media/{tenantId}/{mediaId}` and update
 *      the row to the internal key/url + real file size.
 *
 * Fire-and-forget by contract: NEVER throws, NEVER blocks the webhook 200
 * ack — call it without awaiting (or `.catch(() => {})`). On any failure the
 * row keeps the Graph URL fallback and `mirrored` is false.
 *
 * Intended call site (A1 owns server/_core/index.ts): in the media branch
 * (currently ~L2275-2292), replace the `if (mediaId) { db.insert(whatsappMediaFiles) }`
 * block with:
 *
 *   void mirrorInboundMedia({
 *     tenantId,
 *     waPhoneNumber,
 *     mediaId,
 *     kind: msg.type,            // "image" | "document" | "video" | "audio"
 *     mimeType: msg[msg.type]?.mime_type ?? null,
 *     caption: msg.image?.caption ?? msg.document?.caption ?? msg.video?.caption ?? null,
 *     filename: msg.document?.filename ?? null,
 *   });
 *
 * (Note: the current branch computes `mediaId` from image/document/video only
 * — pass msg.audio?.id for audio so voice notes are mirrored too.)
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { whatsappMediaFiles } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type InboundMediaKind = "image" | "document" | "video" | "audio";

export interface MirrorInboundMediaInput {
  tenantId: string;
  waPhoneNumber: string;
  /** Graph API media id from the webhook payload. */
  mediaId: string;
  kind: InboundMediaKind;
  mimeType?: string | null;
  caption?: string | null;
  filename?: string | null;
}

export interface MirrorInboundMediaResult {
  /** whatsapp_media_files row id (null when the insert itself failed). */
  rowId: string | null;
  storageKey: string;
  /** Internal /api/storage/... url when mirrored, else the Graph fallback. */
  storageUrl: string;
  /** True when the bytes were downloaded and persisted to object storage. */
  mirrored: boolean;
  mimeType: string;
}

export interface MirrorInboundMediaDeps {
  /** Injectable for tests — defaults to storage.storagePut. */
  putImpl?: (key: string, data: Buffer, contentType: string) => Promise<{ key: string; url: string }>;
}

/** Internal object-storage key convention for mirrored inbound media. */
export function mirroredMediaKey(tenantId: string, mediaId: string): string {
  return `wa-media/${tenantId}/${mediaId}`;
}

/** Graph fallback URL (expires — only used until/unless the mirror succeeds). */
export function graphMediaUrl(mediaId: string): string {
  return `https://graph.facebook.com/v21.0/${mediaId}`;
}

const DEFAULT_MIME: Record<InboundMediaKind, string> = {
  image: "image/jpeg",
  document: "application/octet-stream",
  video: "video/mp4",
  audio: "audio/ogg",
};

/** Download media bytes from the Graph API (two-step). Null on any failure. */
async function downloadWaMedia(
  tenantId: string,
  mediaId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const { resolveTenantWaCredentials } = await import("./waSender");
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const url = meta?.url;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(30000),
  }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  return {
    bytes: Buffer.from(bin),
    mimeType: typeof meta?.mime_type === "string" ? meta.mime_type : "application/octet-stream",
  };
}

/**
 * Mirror one inbound media message. See the module docstring for the exact
 * index.ts call site (A1 owns that edit). Never throws.
 */
export async function mirrorInboundMedia(
  input: MirrorInboundMediaInput,
  deps: MirrorInboundMediaDeps = {},
): Promise<MirrorInboundMediaResult> {
  const fallback: MirrorInboundMediaResult = {
    rowId: null,
    storageKey: `wa-media/${input.mediaId}`,
    storageUrl: graphMediaUrl(input.mediaId),
    mirrored: false,
    mimeType: input.mimeType ?? DEFAULT_MIME[input.kind],
  };
  try {
    if (!input.tenantId || !input.mediaId) return fallback;
    const db = await getDb();
    if (!db) return fallback;
    const mimeType = input.mimeType ?? DEFAULT_MIME[input.kind];
    const filename = input.filename?.trim() || `${input.kind}_${Date.now()}`;
    const storageKey = mirroredMediaKey(input.tenantId, input.mediaId);

    // 1. Row first — media is never lost even when the mirror download fails.
    const [row] = await db
      .insert(whatsappMediaFiles)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        waPhoneNumber: input.waPhoneNumber,
        mimeType,
        fileName: filename,
        storageKey,
        storageUrl: graphMediaUrl(input.mediaId), // fallback until mirrored
        documentType: input.kind, // W45: audio + video are first-class kinds now
        aiScanResult: input.caption ? { caption: input.caption } : null,
        uploadedAt: new Date(),
      })
      .returning({ id: whatsappMediaFiles.id })
      .catch((e: any) => {
        console.error("[mediaMirror] row insert failed:", e?.message);
        return [] as any[];
      });
    if (!row) return fallback;

    // 2. Best-effort mirror to object storage.
    const downloaded = await downloadWaMedia(input.tenantId, input.mediaId);
    if (!downloaded) return { ...fallback, rowId: row.id, mimeType };
    try {
      const put = deps.putImpl ?? (await import("../storage")).storagePut;
      const stored = await put(storageKey, downloaded.bytes, downloaded.mimeType || mimeType);
      await db
        .update(whatsappMediaFiles)
        .set({
          storageKey: stored.key,
          storageUrl: stored.url,
          fileSize: downloaded.bytes.length,
          mimeType: downloaded.mimeType || mimeType,
        })
        .where(eq(whatsappMediaFiles.id, row.id))
        .catch((e: any) => console.warn("[mediaMirror] row update failed:", e?.message));
      return { rowId: row.id, storageKey: stored.key, storageUrl: stored.url, mirrored: true, mimeType: downloaded.mimeType || mimeType };
    } catch (e: any) {
      console.warn("[mediaMirror] object-storage mirror failed (keeping Graph fallback):", e?.message);
      return { ...fallback, rowId: row.id, mimeType };
    }
  } catch (e: any) {
    console.error("[mediaMirror] unexpected error:", e?.message);
    return fallback;
  }
}
