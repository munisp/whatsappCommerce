// === W50 IMAGES ===
/**
 * J519 — W50 images (Coder C): fail-open doctrine.
 *   1. Ollama hang → bounded timeout (OLLAMA_IMAGE_TIMEOUT_MS, here 50ms)
 *      aborts the request; maybeGenerateProductImage returns
 *      { ok:false, reason:"generation_failed" } and the product row is
 *      untouched (imageUrl stays NULL) — the product save path NEVER fails
 *      because image generation did.
 *   2. Tenant opt-out: tenants.settings.images.aiGenerate === false disables
 *      generation entirely (no outbound call, reason "disabled_by_tenant").
 */
import { eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const HOST = "ollama-j519-timeout.example.com";
const OPTOUT_HOST = "ollama-j519-optout.example.com";

export const journey: Journey = {
  id: "J519",
  name: "Ollama timeout fails open; tenant opt-out disables generation",
  feature: "W50 IMAGES: bounded timeout + fail-open + tenant opt-out",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { maybeGenerateProductImage } = await import("../../server/services/productImageGen");

    await world.db.insert(schema.products).values({
      id: "p-j519", tenantId: TENANT_ID, sku: "SIM-J519-A", name: "J519 Timeout Item",
      price: "10.00", currency: "NGN", status: "active", stockQuantity: 1,
    }).onConflictDoNothing();

    // ── 1. Hung Ollama → bounded timeout → fail-open ─────────────────────
    process.env.OLLAMA_URL = `http://${HOST}`;
    process.env.OLLAMA_IMAGE_TIMEOUT_MS = "50";
    // Journey-local mock: never-resolving fetch for the hung host, delegate
    // everything else to the installed metaMock interceptor.
    const delegate = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (String(url).includes(HOST)) {
        // Hang forever UNLESS the caller aborts — proves the timeout budget
        // (AbortController in resilientFetch) is what bounds the call.
        return new Promise<Response>((_, reject) => {
          const sig: AbortSignal | undefined = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          if (sig?.aborted) return reject(new DOMException("Aborted", "AbortError"));
          sig?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      return delegate(input, init);
    }) as typeof fetch;
    try {
      const started = Date.now();
      const res = await maybeGenerateProductImage(world.db, { tenantId: TENANT_ID, productId: "p-j519" });
      assert(res.ok === false && res.reason === "generation_failed",
        `timeout fails open (got ${JSON.stringify(res)})`);
      assert(Date.now() - started < 5000, "timeout is bounded (no 60s hang)");
    } finally {
      globalThis.fetch = delegate;
      delete process.env.OLLAMA_IMAGE_TIMEOUT_MS;
    }
    const [p] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-j519")).limit(1);
    assert(p.imageUrl === null, "product row untouched on timeout (imageUrl NULL)");
    assert(p.name === "J519 Timeout Item", "product itself saved fine");

    // ── 2. Tenant opt-out: settings.images.aiGenerate === false ──────────
    process.env.OLLAMA_URL = `http://${OPTOUT_HOST}`;
    let optOutCalls = 0;
    erp.script(OPTOUT_HOST, () => { optOutCalls += 1; return { json: { data: [{ b64_json: "eA==" }] } }; });
    const [t] = await world.db.select({ settings: schema.tenants.settings }).from(schema.tenants)
      .where(eq(schema.tenants.id, TENANT_ID)).limit(1);
    const prev = (t as any)?.settings ?? null;
    await world.db.update(schema.tenants)
      .set({ settings: { ...(prev ?? {}), images: { ...(prev?.images ?? {}), aiGenerate: false } } })
      .where(eq(schema.tenants.id, TENANT_ID));
    try {
      const off = await maybeGenerateProductImage(world.db, { tenantId: TENANT_ID, productId: "p-j519" });
      assert(off.ok === false && off.reason === "disabled_by_tenant",
        `tenant opt-out honored (got ${JSON.stringify(off)})`);
      assert(optOutCalls === 0, "no outbound call when opted out");
    } finally {
      await world.db.update(schema.tenants).set({ settings: prev }).where(eq(schema.tenants.id, TENANT_ID));
      erp.handlers.delete(OPTOUT_HOST);
      delete process.env.OLLAMA_URL;
    }
  },
};
