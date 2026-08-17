/**
 * Catalog-extraction adapters (W15, roadmap F5 — price-list-photo → catalog
 * bootstrap). Mirrors the compliance/bureau.ts adapter pattern.
 *
 * Providers:
 *   - 'disabled'   (default) — no network; bootstrapCatalogFromImage returns
 *                  { ok: false, error: 'extraction_disabled' }.
 *   - 'customHttp' — declarative REST adapter: POSTs
 *                  { imageUrl | imageBase64, mimeType, hints } to
 *                  CATALOG_EXTRACTION_ENDPOINT (bearer
 *                  CATALOG_EXTRACTION_API_KEY) and parses { items: [...] }.
 *
 * Guarantees:
 *   - 8s default timeout, CATALOG_EXTRACTION_TIMEOUT_MS override.
 *   - Secrets redaction: the API key never appears in thrown error text or
 *     logs (redactSecrets from compliance/fakeHttp).
 *   - Adapter output is untrusted — normalization/parsing lives in parse.ts.
 *
 * Tests inject makeFakeHttp — no real network.
 */

import {
  nodeFetchHttp,
  redactSecrets,
  DEFAULT_TIMEOUT_MS,
  type HttpClient,
} from "../compliance/fakeHttp";

// ── Types ───────────────────────────────────────────────────────────────────

export type CatalogExtractionProvider = "disabled" | "customHttp";

/** One raw item as returned by an extraction endpoint (all fields optional —
 * the endpoint is untrusted; parse.ts normalizes). */
export interface RawExtractedItem {
  name?: unknown;
  price?: unknown; // string like "₦1,500" | "500-700" | number (major units)
  priceCents?: unknown;
  currency?: unknown;
  sku?: unknown;
  unit?: unknown;
  confidence?: unknown;
  rawText?: unknown;
}

export interface ExtractionRequest {
  tenantId: string;
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
  hints?: { currency?: string };
}

export interface ExtractionResult {
  items: RawExtractedItem[];
  /** Upstream trace/model id, if provided, for audit only. */
  upstreamRef?: string;
}

export interface CatalogExtractionAdapter {
  name: CatalogExtractionProvider;
  /** Extract raw items from an image. Throws on transport/HTTP failure. */
  extract(req: ExtractionRequest): Promise<ExtractionResult>;
}

export interface ExtractionDeps {
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
}

// ── Config ──────────────────────────────────────────────────────────────────

export function extractionProvider(
  env: NodeJS.ProcessEnv = process.env,
): CatalogExtractionProvider {
  const raw = (env.CATALOG_EXTRACTION_PROVIDER ?? "disabled").trim().toLowerCase();
  return raw === "customhttp" ? "customHttp" : "disabled";
}

export function extractionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CATALOG_EXTRACTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS; // 8s default
}

// ── Adapters ────────────────────────────────────────────────────────────────

function customHttpAdapter(deps: ExtractionDeps): CatalogExtractionAdapter {
  const env = deps.env ?? process.env;
  const http = deps.http ?? nodeFetchHttp;
  return {
    name: "customHttp",
    async extract(req) {
      const endpoint = (env.CATALOG_EXTRACTION_ENDPOINT ?? "").trim();
      if (!endpoint) throw new Error("CATALOG_EXTRACTION_ENDPOINT is required for provider 'customHttp'");
      const apiKey = (env.CATALOG_EXTRACTION_API_KEY ?? "").trim();
      const res = await http.request({
        url: endpoint,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...(req.imageUrl ? { imageUrl: req.imageUrl } : {}),
          ...(req.imageBase64 ? { imageBase64: req.imageBase64 } : {}),
          ...(req.mimeType ? { mimeType: req.mimeType } : {}),
          hints: { currency: req.hints?.currency ?? "NGN" },
        }),
        timeoutMs: extractionTimeoutMs(env),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          redactSecrets(`catalog extraction 'customHttp' responded HTTP ${res.status}`, [apiKey]),
        );
      }
      const body = res.body as { items?: unknown; ref?: unknown } | unknown;
      const items =
        body && typeof body === "object" && Array.isArray((body as any).items)
          ? ((body as any).items as RawExtractedItem[])
          : [];
      const upstreamRef =
        body && typeof body === "object" && typeof (body as any).ref === "string"
          ? ((body as any).ref as string)
          : undefined;
      return { items, upstreamRef };
    },
  };
}

/** Resolve the configured adapter. 'disabled' (default) is an explicit no-op. */
export function getExtractionAdapter(deps: ExtractionDeps = {}): CatalogExtractionAdapter {
  const provider = extractionProvider(deps.env);
  switch (provider) {
    case "customHttp":
      return customHttpAdapter(deps);
    default:
      return {
        name: "disabled",
        async extract() {
          throw new Error("extraction_disabled");
        },
      };
  }
}
