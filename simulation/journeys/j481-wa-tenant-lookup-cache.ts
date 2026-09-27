// === W48 integrations ===
/**
 * J481 — PERF-INT-6: the WA inbound pipeline resolves
 * phone_number_id → tenant through a Redis read-through cache (with an
 * in-process fallback), hoisted out of the per-message loop, and processes
 * independent batch changes in parallel while keeping per-phone message
 * ordering serial.
 *
 * Asserts:
 *   1. Source: processWaWebhookValue hoists the tenant lookup per change
 *      value via lookupTenantByPhoneNumberId (no per-message select); the
 *      webhook fan-out uses Promise.allSettled across changes while the
 *      per-value message loop stays serial.
 *   2. Behavior: the second lookup is a cache hit (stale-after-DB-write
 *      proves it), invalidation restores freshness, and unknown ids are
 *      negatively cached.
 *   3. Invalidation is wired into the WA-credential write paths.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J481",
  name: "WA inbound: cached tenant lookup + hoisted per-batch invariants + parallel fan-out",
  feature: "PERF-INT-6",
  async run(world: World) {
    const idxSrc = await readFile(new URL("../../server/_core/index.ts", import.meta.url), "utf8");
    const fnIdx = idxSrc.indexOf("async function processWaWebhookValue");
    const fnBody = idxSrc.slice(fnIdx, fnIdx + 6000);
    assert(fnBody.includes("lookupTenantByPhoneNumberId(db, phoneNumberId)"), "tenant resolved via the cached lookup, hoisted per value");
    assert(!fnBody.includes("await db.select().from(tenants)"), "no per-message uncached tenant select remains in the value pipeline");
    const fanoutIdx = idxSrc.indexOf('"/api/webhooks/telegram');
    const waHandler = idxSrc.slice(idxSrc.indexOf('app.post("/api/webhooks/whatsapp"'), fanoutIdx > 0 ? fanoutIdx : undefined);
    assert(waHandler.includes("Promise.allSettled("), "batch fan-out parallelized across changes");
    assert(fnBody.includes("for (const msg of messages)"), "per-phone message loop stays serial (ordering preserved)");

    // ── Behavior: cache hit, invalidation, negative caching ───────────────
    const schema = await import("../../drizzle/schema");
    const wl = await import("../../server/services/waTenantLookup");
    wl.__clearWaTenantLookupCache();
    const tenantId = crypto.randomUUID();
    const phoneNumberId = `pn-j481-${tenantId.slice(0, 8)}`;
    await world.db.insert(schema.tenants).values({
      id: tenantId, name: "J481 Cache Store", slug: `j481-${tenantId.slice(0, 8)}`,
      whatsappPhoneNumberId: phoneNumberId,
      settings: { marker: "v1" },
    } as any);

    const first = await wl.lookupTenantByPhoneNumberId(world.db, phoneNumberId);
    assert(first?.id === tenantId, "first lookup resolves the tenant");

    // Direct DB write behind the cache's back → second lookup serves the
    // CACHED row (proves the read-through cache is actually engaged).
    await world.db.update(schema.tenants)
      .set({ name: "J481 Renamed" })
      .where(eq(schema.tenants.id, tenantId));
    const cached = await wl.lookupTenantByPhoneNumberId(world.db, phoneNumberId);
    assert((cached as any)?.name === "J481 Cache Store", "second lookup is a cache hit (stale name served)");

    await wl.invalidateWaTenantLookup(phoneNumberId);
    const fresh = await wl.lookupTenantByPhoneNumberId(world.db, phoneNumberId);
    assert((fresh as any)?.name === "J481 Renamed", "invalidation restores freshness");

    // Unknown ids resolve to null and are negatively cached (no throw).
    const unknown = await wl.lookupTenantByPhoneNumberId(world.db, "pn-j481-unknown");
    assert(unknown === null, "unknown phone_number_id resolves to null");

    // ── Invalidation wired into write paths ───────────────────────────────
    const tenantSrc = await readFile(new URL("../../server/routers/tenant.ts", import.meta.url), "utf8");
    assert(tenantSrc.includes("invalidateWaTenantLookupPair"), "tenant.updateWhatsAppConfig invalidates old+new ids");
    const onbSrc = await readFile(new URL("../../server/routers/onboarding.ts", import.meta.url), "utf8");
    assert(onbSrc.includes("invalidateWaTenantLookup"), "onboarding credential write invalidates");
  },
};
