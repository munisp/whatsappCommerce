/**
 * File storage — self-hosted MinIO (S3-compatible).
 * Replaces Manus built-in storage API.
 */
import { Client as MinioClient } from "minio";
import { ENV } from "./_core/env";
import crypto from "crypto";

let _client: MinioClient | null = null;

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
  const key = relKey.replace(/^\/+/, "");
  await client.putObject(ENV.s3Bucket, key, buf, buf.length, { "Content-Type": contentType });
  return { key, url: `/api/storage/${key}` };
}

export async function storageGet(relKey: string, expiresIn = 3600): Promise<{ key: string; url: string }> {
  await ensureBucket();
  const client = getClient();
  const key = relKey.replace(/^\/+/, "");
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
