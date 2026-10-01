// === W50 IMAGES ===
/**
 * server/services/productImageGen.ts — W50 product images (Coder C)
 * ─────────────────────────────────────────────────────────────────────────────
 * Local AI product-image generation via a SELF-HOSTED Ollama instance running
 * a Qwen image model. This is the ONLY wired image-generation seam — the
 * Forge/GPT gateway in server/_core/imageGeneration.ts stays dormant by
 * binding product directive (zero external API cost).
 *
 * Provider contract:
 *   1. OpenAI-compatible: POST {OLLAMA_URL}/v1/images/generations
 *      { model, prompt, n: 1, size } → { data: [{ b64_json | url }] }
 *   2. If that endpoint 404s (older/native Ollama): POST {OLLAMA_URL}/api/generate
 *      { model, prompt, stream: false } → { images?: [b64] | image?: b64 | response?: b64 }
 *
 * Behavioural doctrine:
 *   - Fail-open everywhere: any provider/storage/DB error logs and returns
 *     null; the product save NEVER fails because image generation did.
 *   - Bounded: timeout via resilientFetch (default 60s, OLLAMA_IMAGE_TIMEOUT_MS).
 *   - Idempotent: skips when products.imageUrl is already set unless force=true.
 *   - Provenance: products.metadata.imageSource ∈
 *     "ai-ollama-qwen" | "upload" | "medusa" | "wa-photo" so send paths/UI can
 *     badge AI-generated images (NDPR / consumer transparency).
 *   - Tenant opt-out: tenants.settings.images.aiGenerate === false disables.
 *
 * Simulation journeys inject { putImpl } so no MinIO is needed; the Ollama
 * HTTP calls go through the metaMock global fetch like every other outbound.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { products, tenants } from "../../drizzle/schema";
import { fetchJson, IntegrationTimeoutError } from "./net/resilientFetch";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type ImageSource = "ai-ollama-qwen" | "upload" | "medusa" | "wa-photo";

export interface ImageGenDeps {
  /** Object-storage put (default: storagePut into the product-images namespace). */
  putImpl?: (key: string, data: Buffer, contentType: string) => Promise<{ key: string; url: string }>;
}

export interface GenerateResult {
  ok: boolean;
  imageUrl?: string | null;
  reason?: string;
}

const OLLAMA_URL = () => (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = () => process.env.OLLAMA_IMAGE_MODEL ?? "qwen-image";
const TIMEOUT_MS = () => {
  const n = Number(process.env.OLLAMA_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
};

/** Concise e-commerce prompt per the W50 directive. */
export function buildImagePrompt(input: { name: string; description?: string | null; variant?: string | null }): string {
  const desc = (input.description ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const variant = (input.variant ?? "").trim();
  const parts = [`Product photo of ${input.name.trim()}`];
  if (desc) parts.push(desc);
  if (variant) parts.push(variant);
  parts.push("clean studio white background, e-commerce catalog style");
  return parts.join(", ");
}

/** Tenant opt-out gate: settings.images.aiGenerate !== false (default ON). */
export async function aiImageGenerationEnabled(db: Db, tenantId: string): Promise<boolean> {
  const [t] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const images = (t as any)?.settings?.images;
  return images?.aiGenerate !== false;
}

/** Public storage key for a generated product image. */
export function productImageKey(tenantId: string, productId: string, ext = "png"): string {
  return `product-images/${tenantId}/${productId}.${ext}`;
}

async function defaultPut(key: string, data: Buffer, contentType: string) {
  const { storagePut } = await import("../storage");
  return storagePut(key, data, contentType);
}

/**
 * Call Ollama for an image. OpenAI-compatible endpoint first; on HTTP 404
 * falls back to the native /api/generate shape. Returns image bytes or null.
 * Never throws.
 */
export async function generateViaOllama(prompt: string, deps?: ImageGenDeps): Promise<Buffer | null> {
  const base = OLLAMA_URL();
  const model = OLLAMA_MODEL();
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024" }),
  };
  try {
    const res = await fetchJson<{ data?: Array<{ b64_json?: string; url?: string }> }>(
      `${base}/v1/images/generations`,
      {
        init,
        integration: "ollama-image",
        timeoutMs: TIMEOUT_MS(),
        retries: 0,
        noBreaker: true,
      },
    );
    if (res.status === 404) {
      // Native Ollama fallback.
      return await generateViaNativeApi(base, model, prompt, deps);
    }
    if (!res.ok || !res.data) return null;
    const first = res.data.data?.[0];
    if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
    if (first?.url) {
      const img = await fetch(first.url, { signal: AbortSignal.timeout(TIMEOUT_MS()) }).catch(() => null);
      if (img?.ok) return Buffer.from(await img.arrayBuffer());
    }
    return null;
  } catch (e: any) {
    if (e instanceof IntegrationTimeoutError) {
      console.warn(`[productImageGen] ollama timeout after ${e.timeoutMs}ms — fail-open`);
    } else {
      console.warn("[productImageGen] ollama images/generations failed:", e?.message ?? e);
    }
    return null;
  }
}

async function generateViaNativeApi(
  base: string,
  model: string,
  prompt: string,
  deps?: ImageGenDeps,
): Promise<Buffer | null> {
  try {
    const res = await fetchJson<{ images?: string[]; image?: string; response?: string }>(
      `${base}/api/generate`,
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt, stream: false }),
        },
        integration: "ollama-image-native",
        timeoutMs: TIMEOUT_MS(),
        retries: 0,
        noBreaker: true,
      },
    );
    if (!res.ok || !res.data) return null;
    const b64 = res.data.images?.[0] ?? res.data.image ?? res.data.response ?? null;
    if (!b64 || typeof b64 !== "string") return null;
    // Native models may wrap the payload in markdown/data-url noise.
    const cleaned = b64.replace(/^data:image\/[a-z]+;base64,/i, "").trim();
    return Buffer.from(cleaned, "base64");
  } catch (e: any) {
    console.warn("[productImageGen] ollama native /api/generate failed:", e?.message ?? e);
    return null;
  }
}

/**
 * Store generated bytes and stamp the product row (imageUrl + provenance
 * metadata). Exported so callers that already hold bytes (tests) reuse it.
 */
export async function persistProductImage(
  db: Db,
  opts: { tenantId: string; productId: string; bytes: Buffer; contentType?: string; source: ImageSource },
  deps?: ImageGenDeps,
): Promise<string | null> {
  try {
    const ext = (opts.contentType ?? "image/png").split("/")[1]?.split(";")[0] ?? "png";
    const key = productImageKey(opts.tenantId, opts.productId, ext === "jpeg" ? "jpg" : ext);
    const put = deps?.putImpl ?? defaultPut;
    const stored = await put(key, opts.bytes, opts.contentType ?? "image/png");
    const imageUrl = stored.url ?? `/api/storage/${key}`;
    await db
      .update(products)
      .set({
        imageUrl,
        metadata: sql`COALESCE(${products.metadata}, '{}'::jsonb) || ${JSON.stringify({ imageSource: opts.source })}::jsonb`,
        updatedAt: new Date(),
      } as any)
      .where(and(eq(products.id, opts.productId), eq(products.tenantId, opts.tenantId)));
    return imageUrl;
  } catch (e: any) {
    console.warn("[productImageGen] persist failed (fail-open):", e?.message ?? e);
    return null;
  }
}

/**
 * Core trigger used by publish/create/update paths and the manual
 * products.generateImage mutation. Idempotent (skips when imageUrl set unless
 * force) and fail-open (returns { ok:false, reason } — never throws).
 */
export async function maybeGenerateProductImage(
  db: Db,
  opts: {
    tenantId: string;
    productId: string;
    name?: string;
    description?: string | null;
    variant?: string | null;
    force?: boolean;
  },
  deps?: ImageGenDeps,
): Promise<GenerateResult> {
  try {
    const [p] = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        imageUrl: products.imageUrl,
      })
      .from(products)
      .where(and(eq(products.id, opts.productId), eq(products.tenantId, opts.tenantId)))
      .limit(1)
      .catch(() => [] as any[]);
    if (!p) return { ok: false, reason: "not_found" };
    if (p.imageUrl && !opts.force) return { ok: true, imageUrl: p.imageUrl, reason: "already_has_image" };
    if (!(await aiImageGenerationEnabled(db, opts.tenantId))) {
      return { ok: false, reason: "disabled_by_tenant" };
    }
    const prompt = buildImagePrompt({
      name: opts.name ?? p.name,
      description: opts.description ?? p.description,
      variant: opts.variant ?? null,
    });
    const bytes = await generateViaOllama(prompt, deps);
    if (!bytes || bytes.length === 0) return { ok: false, reason: "generation_failed" };
    const imageUrl = await persistProductImage(
      db,
      { tenantId: opts.tenantId, productId: opts.productId, bytes, contentType: "image/png", source: "ai-ollama-qwen" },
      deps,
    );
    if (!imageUrl) return { ok: false, reason: "storage_failed" };
    return { ok: true, imageUrl };
  } catch (e: any) {
    console.warn("[productImageGen] maybeGenerateProductImage failed-open:", e?.message ?? e);
    return { ok: false, reason: "error" };
  }
}
// === END W50 IMAGES ===
