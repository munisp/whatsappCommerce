/**
 * brandStudio/waProfile.ts — push brand identity to the tenant's WhatsApp
 * business profile via the Graph API (v21.0).
 *
 *   Text fields (about/description/address/vertical):
 *     POST /{phone-number-id}/whatsapp_business_profile
 *     { messaging_product: "whatsapp", ...fields }
 *     Meta limits: about ≤ 139, description ≤ 512, address ≤ 256.
 *
 *   Profile photo (profile_picture_handle, resumable-upload flow):
 *     1. POST /{app-id}/uploads?file_name=..&file_length=..&file_type=..
 *        → { id: upload session id }
 *     2. POST /{upload-session-id}  (raw bytes, header file_offset: 0,
 *        Authorization: OAuth <token>) → { h: file handle }
 *     3. POST /{phone-number-id}/whatsapp_business_profile
 *        { messaging_product: "whatsapp", profile_picture_handle: h }
 *     App id from WHATSAPP_APP_ID / WAC_WHATSAPP_APP_ID.
 *
 * Contract: NEVER throws. Partial success is reported per field via
 * pushed[] / failed[]; failures are logged, not raised.
 */
import { resolveTenantWaCredentials } from "../waSender";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/** Meta hard limits for whatsapp_business_profile fields. */
export const WA_PROFILE_LIMITS = {
  about: 139,
  description: 512,
  address: 256,
} as const;

export type WaProfileField = "about" | "description" | "address" | "vertical" | "photo";

export interface PushWhatsappProfileArgs {
  tenantId: string;
  about?: string;
  description?: string;
  address?: string;
  vertical?: string;
  logoDataUri?: string;
}

export interface PushWhatsappProfileResult {
  ok: boolean;
  pushed: string[];
  failed: string[];
}

/** Clamp to Meta's limit on a graceful boundary (trim trailing partial word). */
export function clampProfileField(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= limit * 0.7) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s.,;:!?-]+$/, "");
}

/** Parse a data: URI into mime + bytes. Returns null for malformed input. */
export function parseDataUri(dataUri: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([a-zA-Z0-9][a-zA-Z0-9/+.-]*);base64,(.+)$/s.exec(dataUri ?? "");
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[2], "base64");
    return bytes.length > 0 ? { mime: m[1], bytes } : null;
  } catch {
    return null;
  }
}

interface GraphOk {
  ok: boolean;
  status: number;
  body: any;
}

async function graphPost(
  url: string,
  token: string,
  init: { json?: unknown; raw?: Buffer; headers?: Record<string, string> },
): Promise<GraphOk> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;
  if (init.raw) {
    body = new Uint8Array(init.raw);
    headers.authorization = `OAuth ${token}`;
  } else {
    body = JSON.stringify(init.json ?? {});
    headers["content-type"] = "application/json";
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method: "POST", headers, body });
  const parsed: any = await res.json().catch(() => ({}));
  return { ok: res.ok && !parsed?.error, status: res.status, body: parsed };
}

/**
 * Push brand fields to the tenant's WhatsApp business profile.
 * Resolves credentials exactly like waSender (tenant settings → env).
 * Never throws — every failure lands in failed[] with a console warning.
 */
export async function pushWhatsappProfile(args: PushWhatsappProfileArgs): Promise<PushWhatsappProfileResult> {
  const pushed: string[] = [];
  const failed: string[] = [];

  // Assemble text fields (clamped to Meta limits; empty strings skipped).
  const fields: Record<string, string> = {};
  const textFields: Array<[WaProfileField, string | undefined]> = [
    ["about", args.about],
    ["description", args.description],
    ["address", args.address],
    ["vertical", args.vertical],
  ];
  for (const [name, value] of textFields) {
    const v = (value ?? "").trim();
    if (!v) continue;
    const limit = name in WA_PROFILE_LIMITS ? WA_PROFILE_LIMITS[name as keyof typeof WA_PROFILE_LIMITS] : undefined;
    fields[name] = limit ? clampProfileField(v, limit) : v;
  }
  const wantPhoto = typeof args.logoDataUri === "string" && args.logoDataUri.length > 0;

  let creds: Awaited<ReturnType<typeof resolveTenantWaCredentials>> = null;
  try {
    creds = await resolveTenantWaCredentials(args.tenantId);
  } catch (e: any) {
    console.warn(`[brandStudio] credential resolution failed for tenant ${args.tenantId}:`, e?.message);
  }
  if (!creds) {
    failed.push(...Object.keys(fields), ...(wantPhoto ? ["photo"] : []));
    if (failed.length === 0) failed.push("credentials");
    console.warn(`[brandStudio] no WhatsApp credentials for tenant ${args.tenantId} — profile push skipped`);
    return { ok: false, pushed, failed };
  }

  // ── Text fields: one POST, all-or-nothing for the group ──────────────────
  if (Object.keys(fields).length > 0) {
    try {
      const res = await graphPost(`${GRAPH_BASE}/${creds.phoneNumberId}/whatsapp_business_profile`, creds.accessToken, {
        json: { messaging_product: "whatsapp", ...fields },
      });
      if (res.ok) {
        pushed.push(...Object.keys(fields));
      } else {
        failed.push(...Object.keys(fields));
        console.warn(
          `[brandStudio] whatsapp_business_profile update failed (HTTP ${res.status}):`,
          JSON.stringify(res.body).slice(0, 300),
        );
      }
    } catch (e: any) {
      failed.push(...Object.keys(fields));
      console.warn(`[brandStudio] whatsapp_business_profile update threw:`, e?.message);
    }
  }

  // ── Profile photo via resumable-upload handle ─────────────────────────────
  if (wantPhoto) {
    try {
      const asset = parseDataUri(args.logoDataUri!);
      if (!asset) throw new Error("logoDataUri is not a valid base64 data URI");
      // Meta accepts raster types only — SVG monograms must be rasterized by
      // the caller (or the AI-provider PNG used) before pushing as a photo.
      const mime = asset.mime.toLowerCase().replace("image/jpg", "image/jpeg");
      if (!/^image\/(png|jpeg)$/.test(mime)) {
        throw new Error(`unsupported photo mime "${asset.mime}" — Meta requires image/png or image/jpeg`);
      }
      const bytes = asset.bytes;
      const appId = process.env.WHATSAPP_APP_ID || process.env.WAC_WHATSAPP_APP_ID || "";
      if (!appId) throw new Error("WHATSAPP_APP_ID is not configured — cannot upload profile photo");

      // 1. Create the upload session.
      const session = await graphPost(
        `${GRAPH_BASE}/${appId}/uploads?file_name=${encodeURIComponent("logo." + (mime === "image/png" ? "png" : "jpg"))}&file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}`,
        creds.accessToken,
        { json: {} },
      );
      const uploadId = session.body?.id;
      if (!session.ok || typeof uploadId !== "string" || !uploadId) {
        throw new Error(`upload session failed (HTTP ${session.status}): ${JSON.stringify(session.body).slice(0, 200)}`);
      }

      // 2. Upload the bytes → file handle.
      const upload = await graphPost(`${GRAPH_BASE}/${uploadId}`, creds.accessToken, {
        raw: bytes,
        headers: { file_offset: "0", "content-type": "application/octet-stream" },
      });
      const handle = upload.body?.h;
      if (!upload.ok || typeof handle !== "string" || !handle) {
        throw new Error(`file upload failed (HTTP ${upload.status}): ${JSON.stringify(upload.body).slice(0, 200)}`);
      }

      // 3. Set the profile picture from the handle.
      const pic = await graphPost(`${GRAPH_BASE}/${creds.phoneNumberId}/whatsapp_business_profile`, creds.accessToken, {
        json: { messaging_product: "whatsapp", profile_picture_handle: handle },
      });
      if (!pic.ok) {
        throw new Error(`profile_picture_handle update failed (HTTP ${pic.status}): ${JSON.stringify(pic.body).slice(0, 200)}`);
      }
      pushed.push("photo");
    } catch (e: any) {
      failed.push("photo");
      console.warn(`[brandStudio] profile photo push failed:`, e?.message);
    }
  }

  const attempted = pushed.length + failed.length;
  return { ok: attempted > 0 && failed.length === 0, pushed, failed };
}
