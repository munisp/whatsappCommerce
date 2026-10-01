/**
 * server/opensearch.ts — OpenSearch client module
 *
 * Uses the @opensearch-project/opensearch SDK.
 * Provides helpers for:
 *   - Indexing products, orders, conversations
 *   - Full-text search with filters
 *   - Health check
 *
 * Falls back gracefully when OPENSEARCH_URL is not configured.
 */
import { ENV } from "./_core/env";
import { buildTlsOptions } from "./_core/tlsConfig";

type OSClient = import("@opensearch-project/opensearch").Client;

let _client: OSClient | null = null;
let _connectAttempted = false;

async function getClient(): Promise<OSClient | null> {
  if (_client) return _client;
  if (_connectAttempted) return null;
  _connectAttempted = true;
  if (!process.env.OPENSEARCH_URL) {
    console.info("[OpenSearch] OPENSEARCH_URL not set — search features disabled");
    return null;
  }
  try {
    const { Client } = await import("@opensearch-project/opensearch");
    _client = new Client({
      node: ENV.opensearchUrl,
      auth: { username: ENV.opensearchUser, password: ENV.opensearchPass },
      // W42 (PLT-14): verify certs by default; OPENSEARCH_TLS_CA provides a
      // private-CA bundle (docs/TLS.md).
      ssl: buildTlsOptions("OpenSearch", "OPENSEARCH"),
      // === W48 integrations (PERF-INT-8): interactive-search timeout ===
      // 10s turned OpenSearch slowness into API latency on request paths
      // (search mutations await osIndex/osSearch). 3s keeps interactive
      // search inside the p95 budget; bulk indexing paths use osBulk with
      // their own bounded timeout.
      requestTimeout: Number(process.env.OPENSEARCH_REQUEST_TIMEOUT_MS ?? 3000),
    });
    return _client;
  } catch (err: any) {
    console.warn("[OpenSearch] Failed to init:", err.message);
    return null;
  }
}

/** Index a document. Best-effort — never throws. */
export async function osIndex(index: string, id: string, body: Record<string, unknown>): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    await client.index({ index, id, body, refresh: "false" });
  } catch (err: any) {
    console.warn(`[OpenSearch] index ${index}/${id} failed:`, err.message);
  }
}

// === W48 integrations (PERF-INT-8) ===
/**
 * Bulk-index documents (one `_bulk` call per chunk of 500) — ~10-50x the
 * throughput of per-doc osIndex for the async pipeline. Best-effort; never
 * throws. Individual document failures are logged, not raised.
 */
export async function osIndexBulk(
  index: string,
  docs: { id: string; body: Record<string, unknown> }[],
): Promise<{ indexed: number; failed: number }> {
  const client = await getClient();
  if (!client || docs.length === 0) return { indexed: 0, failed: docs.length };
  let indexed = 0;
  let failed = 0;
  const CHUNK = 500;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    try {
      const resp = await client.bulk({
        refresh: "false",
        body: chunk.flatMap((d) => [{ index: { _index: index, _id: d.id } }, d.body]),
      });
      const items = (resp.body as any)?.items ?? [];
      for (const item of items) {
        const st = item?.index?.status ?? 500;
        if (st >= 200 && st < 300) indexed++; else failed++;
      }
    } catch (err: any) {
      failed += chunk.length;
      console.warn(`[OpenSearch] bulk index ${index} chunk@${i} failed:`, err.message);
    }
  }
  return { indexed, failed };
}

/**
 * Search documents with a query string, scoped to a single tenant.
 * tenantId is required — every indexed document here carries a tenantId
 * field, and results must never cross tenant boundaries.
 */
export async function osSearch(index: string, query: string, tenantId: string, size = 20): Promise<unknown[]> {
  const client = await getClient();
  if (!client) return [];
  try {
    const resp = await client.search({
      index,
      body: {
        query: {
          bool: {
            // === W48 integrations (PERF-INT-8): cheap query shape ===
            // Was: multi_match over fields:["*"] with fuzziness:"AUTO" —
            // all-fields fuzzy is one of the most expensive query shapes and
            // degrades superlinearly with index size. Now: explicit
            // high-value fields with a boost on the text body, fuzziness
            // capped at 1 (AUTO explodes on short strings); tenant filter
            // unchanged (never cross tenant boundaries).
            must: {
              multi_match: {
                query,
                fields: ["text^2", "body^2", "fromAddress", "from", "customerName", "orderNumber", "title", "name"],
                fuzziness: 1,
                prefix_length: 2,
              },
            },
            filter: { term: { tenantId } },
          },
        },
        size,
      },
    });
    return (resp.body.hits?.hits ?? []).map((h: any) => ({ id: h._id, ...h._source }));
  } catch (err: any) {
    console.warn(`[OpenSearch] search ${index} failed:`, err.message);
    return [];
  }
}

/** Delete a document by ID. Best-effort. */
export async function osDelete(index: string, id: string): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    await client.delete({ index, id });
  } catch { /* ignore 404 */ }
}

/** Health check */
export async function opensearchHealthCheck(): Promise<{ online: boolean; latencyMs?: number; error?: string }> {
  if (!process.env.OPENSEARCH_URL) return { online: false, error: "not_configured" };
  try {
    const client = await getClient();
    if (!client) return { online: false, error: "init_failed" };
    const t0 = Date.now();
    const resp = await client.cluster.health({});
    const status = resp.body?.status;
    if (status === "green" || status === "yellow") {
      return { online: true, latencyMs: Date.now() - t0 };
    }
    return { online: false, error: `cluster status: ${status}` };
  } catch (err: any) {
    return { online: false, error: err.message };
  }
}
