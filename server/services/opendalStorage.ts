// === W67 opendal ===
/**
 * opendalStorage.ts — single storage facade over Apache OpenDAL
 * (https://opendal.apache.org/, npm package `opendal`). ALL object/file
 * storage in the server goes through this module:
 *
 *   - server/storage.ts (MinIO replacement) delegates here,
 *   - uc-docs / tax-statement PDF writers use the docs-namespace helpers,
 *   - JSONL append/rewrite state (DLQ fallback, few-shot examples) uses the
 *     JSONL helpers,
 *   - lakehouse bronze batches use the fs-rooted helper (shared-root
 *     contract with the python ml-stack pipeline — see docs/storage-opendal.md).
 *
 * Backend selected by env:
 *   OPENDAL_SCHEME=fs   (default OUTSIDE production) — root ./data/opendal or
 *                        OPENDAL_ROOT; legacy doc namespaces keep their
 *                        historical dirs (UC_DOCS_DIR / TAX_STATEMENTS_DIR)
 *                        so the sim/on-disk contract is unchanged.
 *   OPENDAL_SCHEME=s3   (prod / MinIO) — OPENDAL_S3_BUCKET/ENDPOINT/
 *                        ACCESS_KEY_ID/SECRET_ACCESS_KEY/REGION, falling back
 *                        to the legacy S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/
 *                        S3_SECRET_KEY vars. Path-style addressing (MinIO
 *                        compatible). FAIL-CLOSED in production when
 *                        OPENDAL_SCHEME is unset or s3 is unconfigured.
 *
 * Presign: native `presignRead`/`presignWrite` for the s3 scheme. The fs
 * service has no presign capability — presignRead falls back to the
 * app-proxied route URL (/api/storage/{key}), which preserves the existing
 * capability-token/session auth behavior exactly (the old MinIO code fell
 * back the same way when presign failed).
 *
 * The native binding is imported LAZILY so a missing/broken binding produces
 * a clear error at first storage use instead of crashing server boot.
 */
import { Readable } from "stream";
import { createRequire } from "module";

// Native binding is loaded lazily via createRequire (the package is external
// in the esbuild bundle; a plain `require` would not exist in ESM output).
const _require = createRequire(import.meta.url);

export type OpendalScheme = "fs" | "s3";

type OpendalOperator = import("opendal").Operator;

let _opendal: typeof import("opendal") | null = null;
function opendal(): typeof import("opendal") {
  if (!_opendal) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _opendal = _require("opendal");
    } catch (e: any) {
      throw new Error(
        `[opendal] failed to load the opendal native binding (${e?.message ?? e}). `
        + "Install the `opendal` npm package with a supported platform binary.",
      );
    }
  }
  return _opendal!;
}

/** Resolve the active scheme. Fail-closed in production when unset. */
export function opendalScheme(): OpendalScheme {
  const raw = (process.env.OPENDAL_SCHEME ?? "").trim().toLowerCase();
  if (raw === "fs" || raw === "s3") return raw;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[opendal] OPENDAL_SCHEME is not set in production — refusing to guess a storage backend (fail-closed). "
      + "Set OPENDAL_SCHEME=s3 (with OPENDAL_S3_* env) for the object store.",
    );
  }
  return "fs"; // dev/sim default
}

/** fs-scheme root for the generic object namespace. */
export function opendalRoot(): string {
  return (process.env.OPENDAL_ROOT ?? "data/opendal").trim() || "data/opendal";
}

interface S3Config {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

function s3Config(bucketOverride?: string): S3Config {
  const cfg: S3Config = {
    bucket: (process.env.OPENDAL_S3_BUCKET ?? process.env.S3_BUCKET ?? "").trim(),
    endpoint: (process.env.OPENDAL_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "").trim(),
    accessKeyId: (process.env.OPENDAL_S3_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY ?? "").trim(),
    secretAccessKey: (process.env.OPENDAL_S3_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_KEY ?? "").trim(),
    region: (process.env.OPENDAL_S3_REGION ?? "us-east-1").trim() || "us-east-1",
  };
  if (bucketOverride) cfg.bucket = bucketOverride;
  return cfg;
}

/** opendal's s3 service wants a URL; legacy S3_ENDPOINT may be a bare host. */
function normalizeEndpoint(ep: string): string {
  return ep && !/^https?:\/\//.test(ep) ? `http://${ep}` : ep;
}

function assertS3Configured(cfg: S3Config): void {
  const missing: string[] = [];
  if (!cfg.bucket) missing.push("OPENDAL_S3_BUCKET");
  if (!cfg.endpoint) missing.push("OPENDAL_S3_ENDPOINT");
  if (!cfg.accessKeyId) missing.push("OPENDAL_S3_ACCESS_KEY_ID");
  if (!cfg.secretAccessKey) missing.push("OPENDAL_S3_SECRET_ACCESS_KEY");
  if (missing.length) {
    throw new Error(`[opendal] s3 scheme is not configured — missing ${missing.join(", ")} (fail-closed)`);
  }
}

// Operators are cached per (scheme, root/bucket) so repeated document
// writes don't rebuild the service. process.env is read ONCE per operator —
// tests that mutate env must call _resetOpendalForTests().
const _operators = new Map<string, OpendalOperator>();

function buildOperator(scheme: OpendalScheme, opts: { root?: string; bucketOverride?: string }): OpendalOperator {
  const { Operator } = opendal();
  if (scheme === "fs") {
    return new Operator("fs", { root: opts.root ?? opendalRoot() });
  }
  const cfg = s3Config(opts.bucketOverride);
  assertS3Configured(cfg);
  return new Operator("s3", {
    bucket: cfg.bucket,
    endpoint: normalizeEndpoint(cfg.endpoint),
    access_key_id: cfg.accessKeyId,
    secret_access_key: cfg.secretAccessKey,
    region: cfg.region,
    // No enable_virtual_host_style → path-style addressing (MinIO compatible).
  });
}

function operator(scheme: OpendalScheme, opts: { root?: string; bucketOverride?: string } = {}): OpendalOperator {
  const key = `${scheme}|${opts.root ?? ""}|${opts.bucketOverride ?? ""}`;
  let op = _operators.get(key);
  if (!op) {
    op = buildOperator(scheme, opts);
    _operators.set(key, op);
  }
  return op;
}

/** Test hook: drop cached operators (e.g. after mutating OPENDAL_* env). */
export function _resetOpendalForTests(): void {
  _operators.clear();
}

/** Best-effort availability probe — mirrors the old ensureBucket() which
 *  swallowed errors for dev graceful-degradation. Bucket PROVISIONING is an
 *  ops concern (docker-compose `minio-init` job / infra), not something the
 *  OpenDAL s3 service can do. */
async function probe(op: OpendalOperator): Promise<void> {
  try {
    await op.list("", { limit: 1 }); // probe only — non-recursive is fine
  } catch { /* backend not available in dev — graceful degradation */ }
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

export interface OpendalStat {
  contentLength: number;
  contentType: string | null;
  lastModified: string | null;
}

// ─── Generic object API (storage.ts delegates here) ─────────────────────────

export async function put(relKey: string, data: Buffer | Uint8Array | string, contentType?: string): Promise<void> {
  const scheme = opendalScheme();
  const op = operator(scheme);
  await probe(op);
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
  await op.write(normalizeKey(relKey), buf, contentType ? { contentType } : undefined);
}

export async function get(relKey: string): Promise<Buffer> {
  const scheme = opendalScheme();
  return operator(scheme).read(normalizeKey(relKey));
}

/** get() that returns null instead of throwing on a missing object. */
export async function getOrNull(relKey: string): Promise<Buffer | null> {
  try {
    return await get(relKey);
  } catch (e: any) {
    if (String(e?.message ?? e).includes("NotFound")) return null;
    throw e;
  }
}

/**
 * Idempotent delete. Throws when the backend is unreachable (GDPR erasure
 * contract, W40 TEN-5 — kycPrivacy tombstones + retries via the erasure
 * sweep). Deleting a non-existent key succeeds on both backends.
 */
export async function deleteObject(relKey: string): Promise<void> {
  const scheme = opendalScheme();
  await operator(scheme).delete(normalizeKey(relKey));
}

/** List object keys under a prefix (recursive). */
export async function list(prefix: string): Promise<string[]> {
  const scheme = opendalScheme();
  const entries = await operator(scheme).list(normalizeKey(prefix), { recursive: true });
  return entries.map((e) => e.path()).filter((p) => !p.endsWith("/"));
}

export async function stat(relKey: string): Promise<OpendalStat | null> {
  const scheme = opendalScheme();
  try {
    const meta = await operator(scheme).stat(normalizeKey(relKey));
    return {
      contentLength: Number(meta.contentLength),
      contentType: meta.contentType ?? null,
      lastModified: meta.lastModified ?? null,
    };
  } catch (e: any) {
    if (String(e?.message ?? e).includes("NotFound")) return null;
    throw e;
  }
}

/**
 * Presigned read URL. Native for the s3 scheme; for fs (no presign
 * capability) returns the app-proxied fallback URL (/api/storage/{key} or
 * caller-supplied), which flows through the existing session/capability-token
 * auth policy — identical to the old presign-failure fallback.
 */
export async function presignRead(relKey: string, expiresInSec = 3600, fallbackUrl?: string): Promise<string> {
  const key = normalizeKey(relKey);
  const scheme = opendalScheme();
  if (scheme === "s3") {
    try {
      const req = await operator(scheme).presignRead(key, expiresInSec);
      return req.url;
    } catch { /* fall through to the app-proxied URL */ }
  }
  return fallbackUrl ?? `/api/storage/${key}`;
}

/**
 * Presigned write URL. Native for s3; the fs scheme has no presign — callers
 * must keep uploading through the authenticated app endpoints
 * (capability-token/session routes), exactly as before this migration.
 */
export async function presignWrite(relKey: string, expiresInSec = 3600): Promise<string> {
  const key = normalizeKey(relKey);
  const scheme = opendalScheme();
  if (scheme !== "s3") {
    throw new Error("[opendal] presignWrite is not available on the fs scheme — upload via the authenticated app routes");
  }
  const req = await operator(scheme).presignWrite(key, expiresInSec);
  return req.url;
}

/** Extension-based type guess — the fs service does not persist
 *  content-type metadata, so serveStream falls back to this before
 *  defaulting to octet-stream (the route re-sniffs bytes anyway). */
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf", json: "application/json",
  jsonl: "application/x-ndjson", txt: "text/plain", csv: "text/csv",
  mp3: "audio/mpeg", mp4: "video/mp4", ogg: "audio/ogg", wav: "audio/wav",
};

function mimeFromKey(key: string): string | null {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? null;
}

/**
 * Buffered read as a Node stream for the /api/storage/* route (objects here
 * are small — KB images/PDFs — so buffer-then-stream is honest and keeps the
 * route's first-512-byte sniffing logic untouched). Throws when the object
 * does not exist.
 */
export async function serveStream(relKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
  const key = normalizeKey(relKey);
  const meta = await stat(key);
  if (!meta) throw new Error(`object not found: ${key}`);
  const buf = await get(key);
  return { stream: Readable.from(buf), contentType: meta.contentType ?? mimeFromKey(key) ?? "application/octet-stream" };
}

// ─── Document namespaces (uc-docs / tax-statements legacy local-fs writers) ──

export type DocsNamespace = "uc-docs" | "tax-statements";

/**
 * Historical on-disk dir for a docs namespace (fs scheme only). Keeping the
 * env-driven dirs means the fs scheme in dev/sim writes byte-identical paths
 * to the pre-OpenDAL layout (journeys assert files exist under UC_DOCS_DIR /
 * TAX_STATEMENTS_DIR).
 */
export function docsNamespaceDir(ns: DocsNamespace): string {
  if (ns === "uc-docs") return (process.env.UC_DOCS_DIR ?? "data/uc-docs").trim() || "data/uc-docs";
  return (process.env.TAX_STATEMENTS_DIR ?? "data/tax-statements").trim() || "data/tax-statements";
}

function docsOperator(ns: DocsNamespace): { op: OpendalOperator; key: (rel: string) => string } {
  const scheme = opendalScheme();
  if (scheme === "fs") {
    // Root the operator AT the namespace dir so keys stay the bare rel path
    // and files land exactly where they always have.
    const op = operator("fs", { root: docsNamespaceDir(ns) });
    return { op, key: (rel) => normalizeKey(rel) };
  }
  const op = operator("s3");
  return { op, key: (rel) => `${ns}/${normalizeKey(rel)}` };
}

export async function docsPut(ns: DocsNamespace, rel: string, data: Buffer | Uint8Array | string, contentType = "application/pdf"): Promise<void> {
  const { op, key } = docsOperator(ns);
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
  await op.write(key(rel), buf, { contentType });
}

export async function docsGet(ns: DocsNamespace, rel: string): Promise<Buffer | null> {
  const { op, key } = docsOperator(ns);
  try {
    return await op.read(key(rel));
  } catch (e: any) {
    if (String(e?.message ?? e).includes("NotFound")) return null;
    throw e;
  }
}

export async function docsExists(ns: DocsNamespace, rel: string): Promise<boolean> {
  const { op, key } = docsOperator(ns);
  try {
    await op.stat(key(rel));
    return true;
  } catch (e: any) {
    if (String(e?.message ?? e).includes("NotFound")) return false;
    throw e;
  }
}

/**
 * Delete every object under a docs-namespace prefix (used by GDPR erasure of
 * tenant documents). Idempotent; throws on backend failure.
 */
export async function docsDeletePrefix(ns: DocsNamespace, relPrefix: string): Promise<number> {
  const { op, key } = docsOperator(ns);
  const entries = await op.list(key(relPrefix), { recursive: true }).catch(() => [] as Awaited<ReturnType<OpendalOperator["list"]>>);
  let n = 0;
  for (const entry of entries) {
    await op.delete(entry.path());
    n++;
  }
  return n;
}

// ─── JSONL append/rewrite helpers (DLQ fallback, few-shot examples) ──────────
//
// These files are node-local state. fs scheme → the path is used AS-IS
// (byte-identical to the pre-OpenDAL behavior, including cwd-relative paths);
// append uses native O_APPEND semantics. s3 scheme → the path becomes an
// object key under `local/` and append is read-append-rewrite (object stores
// have no append; any claim/lock a caller holds today is unchanged — these
// helpers keep the exact same read-modify-write shape).

async function jsonlOperator(filePath: string): Promise<{ op: OpendalOperator; key: string }> {
  const scheme = opendalScheme();
  const path = await import("path");
  if (scheme === "fs") {
    // Root the operator at the file's dir and use the basename as the key —
    // resolution is identical to plain fs semantics for cwd-relative paths.
    const abs = path.resolve(filePath);
    const op = operator("fs", { root: path.dirname(abs) });
    return { op, key: path.basename(abs) };
  }
  const key = `local/${filePath.replace(/^\.?\//, "").replace(/\\/g, "/")}`;
  return { op: operator("s3"), key };
}

/** Read the whole JSONL file; "" when missing. */
export async function jsonlReadAll(filePath: string): Promise<string> {
  const { op, key } = await jsonlOperator(filePath);
  try {
    return (await op.read(key)).toString("utf8");
  } catch (e: any) {
    if (String(e?.message ?? e).includes("NotFound")) return "";
    throw e;
  }
}

/** Append one pre-serialized line (with trailing newline added if absent). */
export async function jsonlAppend(filePath: string, line: string): Promise<void> {
  const suffix = line.endsWith("\n") ? line : line + "\n";
  if (opendalScheme() === "fs") {
    // Native append preserves the old appendFileSync semantics exactly.
    const fs = await import("fs/promises");
    const path = await import("path");
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fs.appendFile(filePath, suffix, "utf8");
    return;
  }
  const { op, key } = await jsonlOperator(filePath);
  const existing = await jsonlReadAll(filePath);
  await op.write(key, existing + suffix, { contentType: "application/x-ndjson" });
}

/** Rewrite the whole file (replay-truncation path). */
export async function jsonlWriteAll(filePath: string, content: string): Promise<void> {
  if (opendalScheme() === "fs") {
    const fs = await import("fs/promises");
    const path = await import("path");
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return;
  }
  const { op, key } = await jsonlOperator(filePath);
  await op.write(key, content, { contentType: "application/x-ndjson" });
}

// ─── Lakehouse bronze (fs-rooted ALWAYS — shared-root contract) ─────────────
//
// The python ml-stack pipeline reads the same bronze partitions from disk;
// object-storage export would silently break that dual-writer contract, so
// lakehouse batches stay on the fs scheme rooted at LAKEHOUSE_DATA_DIR even
// when OPENDAL_SCHEME=s3. See docs/storage-opendal.md.

export async function lakehousePut(relKey: string, data: Buffer | string): Promise<void> {
  // Default mirrors lakehouseExport.bronzeDir() — the python ml-stack
  // pipeline shares this exact directory.
  const path = await import("path");
  const root = (process.env.LAKEHOUSE_DATA_DIR ?? path.resolve(process.cwd(), "services/ml-stack/data/lakehouse")).trim()
    || path.resolve(process.cwd(), "services/ml-stack/data/lakehouse");
  const op = operator("fs", { root });
  await op.write(normalizeKey(relKey), data, { contentType: "application/json" });
}

// ─── One-off bucket override (scripts/migrate-prod pre-migration dumps) ─────

/** Put into an explicit S3 bucket (pre-migration dump upload). Always s3 —
 *  a dump upload makes no sense against the fs scheme; callers keep their
 *  local-file fallback. Optional explicit creds override env (migrate-prod
 *  passes its injected env map). */
export async function putToBucket(
  bucket: string,
  relKey: string,
  data: Buffer,
  creds?: { endpoint?: string; accessKeyId?: string; secretAccessKey?: string; region?: string },
): Promise<void> {
  let op: OpendalOperator;
  if (creds) {
    const { Operator } = opendal();
    op = new Operator("s3", {
      bucket,
      endpoint: normalizeEndpoint(creds.endpoint ?? ""),
      access_key_id: creds.accessKeyId ?? "",
      secret_access_key: creds.secretAccessKey ?? "",
      region: creds.region ?? "us-east-1",
    });
  } else {
    op = operator("s3", { bucketOverride: bucket });
  }
  await op.write(normalizeKey(relKey), data, { contentType: "application/octet-stream" });
}

/** Diagnostic info for ops endpoints/tests. */
export function storageBackendInfo(): { scheme: OpendalScheme; root?: string; bucket?: string; endpoint?: string } {
  const scheme = opendalScheme();
  if (scheme === "fs") return { scheme, root: opendalRoot() };
  const cfg = s3Config();
  return { scheme, bucket: cfg.bucket || undefined, endpoint: cfg.endpoint || undefined };
}
// === END W67 opendal ===
