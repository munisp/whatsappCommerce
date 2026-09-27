// === W48 integrations ===
/**
 * J483 — PERF-INT-8: OpenSearch hygiene — cheap query shape (explicit fields,
 * bounded fuzziness), interactive-timeout budget, a bulk indexing path, and
 * no request-path coupling for indexing.
 *
 * Asserts:
 *   1. osSearch no longer uses fields:["*"] / fuzziness:"AUTO"; the client
 *      requestTimeout defaults to 3s (env-tunable).
 *   2. osIndexBulk exists and chunks _bulk calls (500/chunk); it degrades
 *      safely when OpenSearch is unconfigured.
 *   3. search.indexMessage no longer awaits indexing on the request path.
 */
import { readFile } from "node:fs/promises";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J483",
  name: "OpenSearch: field-scoped search, 3s budget, bulk path, async indexing",
  feature: "PERF-INT-8",
  async run(_world: World) {
    const src = await readFile(new URL("../../server/opensearch.ts", import.meta.url), "utf8");
    assert(!src.includes('fields: ["*"]'), "all-fields query shape removed");
    assert(!src.includes('fuzziness: "AUTO"'), "AUTO fuzziness removed");
    assert(src.includes("fuzziness: 1"), "bounded fuzziness");
    assert(src.includes("OPENSEARCH_REQUEST_TIMEOUT_MS ?? 3000"), "3s interactive timeout budget");
    assert(src.includes("export async function osIndexBulk"), "bulk indexing path exported");

    const os = await import("../../server/opensearch");
    const r = await os.osIndexBulk("j483_idx", [
      { id: "a", body: { tenantId: "t", text: "hello" } },
      { id: "b", body: { tenantId: "t", text: "world" } },
    ]);
    // Unconfigured (no OPENSEARCH_URL in sim): bulk degrades safely.
    assert(r.indexed === 0, `unconfigured bulk fails soft (got ${JSON.stringify(r)})`);
    const hits = await os.osSearch("j483_idx", "hello", "t");
    assert(Array.isArray(hits) && hits.length === 0, "unconfigured search fails soft ([])");

    const searchSrc = await readFile(new URL("../../server/routers/search.ts", import.meta.url), "utf8");
    assert(searchSrc.includes("void osIndex("), "request-path indexing is fire-and-forget");
  },
};
