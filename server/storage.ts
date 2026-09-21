/**
 * File storage — self-hosted MinIO (S3-compatible).
 * Replaces Manus built-in storage API.
 */
import { Client as MinioClient } from "minio";
import { ENV } from "./_core/env";
import crypto from "crypto";

let _client: MinioClient | null = null;

/**
 * QA follow-up (defense in depth): callers build keys from user-influenced
 * segments (e.g. a merchant-chosen product class name), and this module only
 * used to strip leading slashes — object stores don't treat keys as
 * filesystem paths, but the same key flows to /api/storage/* serving and
 * other consumers that might. Reject traversal segments outright rather than
 * rely on every caller (and the object store) to be careful.
 */
export function normalizeStorageKey(relKey: string): string {
  const key = relKey.replace(/^\/+/, "");
  if (key.length === 0 || key.includes("\0") || key.includes("\\") || key.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`invalid storage key: ${JSON.stringify(relKey.slice(0, 80))}`);
  }
  return key;
}

function getClient(): MinioClient {
  if (!_client) {
    const rawUrl = ENV.s3Endpoint.startsWith("http") ? ENV.s3Endpoint : `http://${ENV.s3Endpoint}`;
    const url = new URL(rawUrl);
    _client = new MinioClient({
      endPoint: url.hostname,
      port: parseInt(url.port || (url.protocol === "https:" ? "443" : "80")),
      useSSL: url.protocol === "https:",
      accessKey: ENV.s3AccessKey,
      secretKey: ENV.s3SecretKey,
    });
  }
  return _client;
}

async function ensureBucket(): Promise<void> {
  try {
    const client = getClient();
    const exists = await client.bucketExists(ENV.s3Bucket).catch(() => false);
    if (!exists) await client.makeBucket(ENV.s3Bucket, "us-east-1");
  } catch { /* MinIO not available in dev — graceful degradation */ }
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  await ensureBucket();
  const client = getClient();
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
  const key = normalizeStorageKey(relKey);
  await client.putObject(ENV.s3Bucket, key, buf, buf.length, { "Content-Type": contentType });
  return { key, url: `/api/storage/${key}` };
}

/**
 * W40 TEN-5: delete an object (GDPR erasure of KYC document scans).
 * Throws when the object store is unreachable so callers can tombstone +
 * retry via the scheduled kyc-erasure-sweep instead of silently losing the
 * deletion. Deleting a non-existent key is treated as success (idempotent).
 */
export async function storageDelete(relKey: string): Promise<{ key: string }> {
  await ensureBucket();
  const client = getClient();
  const key = normalizeStorageKey(relKey);
  await client.removeObject(ENV.s3Bucket, key);
  return { key };
}

export async function storageGet(relKey: string, expiresIn = 3600): Promise<{ key: string; url: string }> {
  await ensureBucket();
  const client = getClient();
  const key = normalizeStorageKey(relKey);
  const url = await client.presignedGetObject(ENV.s3Bucket, key, expiresIn).catch(() => `/api/storage/${key}`);
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
 * opposed to storageGet's presigned MinIO URL, which expires) — so callers
 * that persist the URL (e.g. a tenant's logo, stored in Postgres) need a
 * route that actually serves it. Throws if the object doesn't exist.
 */
export async function storageServe(
  relKey: string
): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
  const client = getClient();
  const key = normalizeStorageKey(relKey);
  const stat = await client.statObject(ENV.s3Bucket, key);
  const stream = await client.getObject(ENV.s3Bucket, key);
  return { stream, contentType: stat.metaData?.["content-type"] ?? "application/octet-stream" };
}
