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
      ssl: { rejectUnauthorized: false },
      requestTimeout: 10000,
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

/** Search documents with a query string. */
export async function osSearch(index: string, query: string, size = 20): Promise<unknown[]> {
  const client = await getClient();
  if (!client) return [];
  try {
    const resp = await client.search({
      index,
      body: {
        query: { multi_match: { query, fields: ["*"], fuzziness: "AUTO" } },
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
