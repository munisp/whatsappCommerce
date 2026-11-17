/**
 * File storage — thin delegates onto the Apache OpenDAL facade
 * (server/services/opendalStorage.ts, W67). The backend is selected by
 * OPENDAL_SCHEME (fs for dev/sim, s3 for prod/MinIO); the export signatures
 * and semantics below are unchanged from the direct-MinIO implementation,
 * including the GDPR throw-on-unreachable delete contract (W40 TEN-5) and
 * the /api/storage/{key} app-proxied URL shape.
 */
import { ENV } from "./_core/env";
import crypto from "crypto";
import * as od from "./services/opendalStorage";

// ENV import retained: s3 fallback env (S3_ENDPOINT/S3_BUCKET/…) is still
// honored by the facade when OPENDAL_S3_* is unset.
void ENV;

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
  const key = relKey.replace(/^\/+/, "");
  await od.put(key, buf, contentType);
  return { key, url: `/api/storage/${key}` };
}

/**
 * W40 TEN-5: delete an object (GDPR erasure of KYC document scans).
 * Throws when the object store is unreachable so callers can tombstone +
 * retry via the scheduled kyc-erasure-sweep instead of silently losing the
 * deletion. Deleting a non-existent key is treated as success (idempotent).
 */
export async function storageDelete(relKey: string): Promise<{ key: string }> {
  const key = relKey.replace(/^\/+/, "");
  await od.deleteObject(key);
  return { key };
}

export async function storageGet(relKey: string, expiresIn = 3600): Promise<{ key: string; url: string }> {
  const key = relKey.replace(/^\/+/, "");
  // Native presign on the s3 scheme; fs scheme (or any presign failure)
  // falls back to the app-proxied route URL — same as before.
  const url = await od.presignRead(key, expiresIn, `/api/storage/${key}`);
  return { key, url };
}

export async function storageGetSignedUrl(relKey: string, expiresIn = 3600): Promise<string> {
  const { url } = await storageGet(relKey, expiresIn);
  return url;
}

export function generateStorageKey(filename: string): string {
  const ext = filename.split(".").pop() ?? "bin";
  const hash = crypto.randomBytes(8).toString("hex");
  return `uploads/${hash}.${ext}`;
}

/**
 * Stream an object back for the /api/storage/:key route below. storagePut's
 * returned url is `/api/storage/{key}` — a permanent, app-proxied path (as
 * opposed to storageGet's presigned URL, which expires) — so callers that
 * persist the URL (e.g. a tenant's logo, stored in Postgres) need a route
 * that actually serves it. Throws if the object doesn't exist.
 */
export async function storageServe(
  relKey: string
): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
  return od.serveStream(relKey.replace(/^\/+/, ""));
}
