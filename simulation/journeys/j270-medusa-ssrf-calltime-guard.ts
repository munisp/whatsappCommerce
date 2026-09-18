/**
 * === W39 web security (Coder B, PLT-4) ===
 * J270 — Medusa SSRF guard at CALL time (defense in depth). Even a baseUrl
 * that predates (or bypasses) the write-time guard must never be fetched
 * with the admin API key attached:
 *   1. A tenant_integrations row seeded directly with baseUrl =
 *      http://169.254.169.254 → fetchMedusaCatalog returns [] (blocked,
 *      logged) and syncOrderToMedusa returns null — no outbound fetch.
 *   2. HttpMedusaAdapter with a metadata-IP baseUrl rejects every call with
 *      "SSRF guard rejected" before fetch — the key never leaves.
 *   3. Allowed host passes the guard (evaluateOutboundUrl ok), and the
 *      seeded dangerous row is cleaned up.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J270",
  name: "Medusa baseUrl SSRF rejected at call time",
  feature: "PLT-4 ssrfGuard at dispatch (adapter + integrationSync)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { HttpMedusaAdapter } = await import("../../server/services/medusa/adapter");
    const { fetchMedusaCatalog, syncOrderToMedusa } = await import("../../server/services/integrationSync");
    const { evaluateOutboundUrl } = await import("../../server/services/ssrfGuard");

    // Seed a DANGEROUS config row directly (simulates a baseUrl persisted
    // before the write-time guard existed).
    const dangerousId = "1a270000-0000-4000-8000-000000000001";
    await world.db.delete(schema.tenantIntegrations)
      .where(and(
        eq(schema.tenantIntegrations.tenantId, TENANT_ID),
        eq(schema.tenantIntegrations.integrationType, "medusa"),
      ));
    await world.db.insert(schema.tenantIntegrations).values({
      id: dangerousId,
      tenantId: TENANT_ID,
      integrationType: "medusa",
      displayName: "Medusa Commerce",
      baseUrl: "http://169.254.169.254",
      apiKey: "sk_plaintext_legacy", // decryptSecret legacy plaintext passthrough
      status: "active",
      enabledAt: new Date(),
    });

    // 1. Call-time dispatch paths fail closed — no outbound fetch happens.
    const catalog = await fetchMedusaCatalog(TENANT_ID);
    assert(Array.isArray(catalog) && catalog.length === 0,
      "fetchMedusaCatalog fails closed (empty) for metadata-IP baseUrl");
    const syncResult = await syncOrderToMedusa(TENANT_ID, {
      id: "1a270000-0000-4000-8000-000000000010",
      orderNumber: "SIM-J270",
      total: 100,
      currency: "NGN",
      phone: "+234000",
      address: null,
      items: [],
    });
    assert(syncResult === null, "syncOrderToMedusa fails closed (null) for metadata-IP baseUrl");

    // 2. Adapter call-time guard rejects before fetch.
    const adapter = new HttpMedusaAdapter("http://169.254.169.254/latest/meta-data", "sk_admin_secret");
    let threw = false;
    try {
      await adapter.listProducts();
    } catch (err: any) {
      threw = true;
      assert(String(err?.message ?? err).includes("SSRF guard rejected"),
        `adapter rejection cites the SSRF guard (got ${err?.message})`);
    }
    assert(threw, "HttpMedusaAdapter.listProducts rejects metadata-IP baseUrl");

    // 3. Allowed host passes the guard evaluation.
    assert(evaluateOutboundUrl("https://medusa.example.com").ok === true,
      "public https host passes the SSRF guard");

    // Cleanup: remove the dangerous row so later journeys see a clean tenant.
    await world.db.delete(schema.tenantIntegrations)
      .where(eq(schema.tenantIntegrations.id, dangerousId));
  },
};
