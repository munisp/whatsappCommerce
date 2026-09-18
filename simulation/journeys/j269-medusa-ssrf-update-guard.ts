/**
 * === W39 web security (Coder B, PLT-4) ===
 * J269 — Medusa SSRF guard at tenant-config UPDATE time. Tenant-controlled
 * Medusa baseUrls previously passed only z.string().url() and were persisted
 * + fetched with the admin API key attached. Now every write path routes
 * through ssrfGuard.assertSafeOutboundUrl:
 *   1. medusa.configure with a metadata-IP baseUrl → BAD_REQUEST, nothing
 *      persisted.
 *   2. medusa.upsertMapping with loopback / RFC1918 / localhost → BAD_REQUEST.
 *   3. medusa.testConnection with a metadata IP → BAD_REQUEST BEFORE any
 *      fetch (the admin key is never sent to the unvalidated host).
 *   4. A legitimate public https baseUrl → accepted and persisted.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller, expectTrpcError } from "./helpers";

export const journey: Journey = {
  id: "J269",
  name: "Medusa baseUrl SSRF rejected at config update",
  feature: "PLT-4 ssrfGuard on medusa.configure/upsertMapping/testConnection",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const tenant = await tenantCaller(TENANT_ID);

    // 1. configure: cloud metadata IP → BAD_REQUEST, no row persisted.
    await expectTrpcError(
      admin.medusa.configure({
        tenantId: TENANT_ID,
        baseUrl: "http://169.254.169.254/latest/meta-data",
        apiKey: "sk_admin_secret",
      }),
      "BAD_REQUEST",
      "configure metadata IP",
    );
    const leaked = await world.db
      .select({ id: schema.tenantIntegrations.id, baseUrl: schema.tenantIntegrations.baseUrl })
      .from(schema.tenantIntegrations)
      .where(and(
        eq(schema.tenantIntegrations.tenantId, TENANT_ID),
        eq(schema.tenantIntegrations.integrationType, "medusa"),
      ));
    assert(!leaked.some((r) => r.baseUrl?.includes("169.254.169.254")),
      "no tenant_integrations row persisted with the metadata IP");

    // 2. upsertMapping: loopback / private / localhost variants → BAD_REQUEST.
    for (const bad of ["http://127.0.0.1:9000", "http://10.0.0.8", "http://192.168.0.1", "http://localhost:9000"]) {
      await expectTrpcError(
        tenant.medusa.upsertMapping({ baseUrl: bad, apiKey: "sk_admin_secret" }),
        "BAD_REQUEST",
        `upsertMapping ${bad}`,
      );
    }

    // 3. testConnection with metadata IP → BAD_REQUEST before any fetch.
    await expectTrpcError(
      tenant.medusa.testConnection({ baseUrl: "http://169.254.169.254", apiKey: "sk_admin_secret" }),
      "BAD_REQUEST",
      "testConnection metadata IP",
    );

    // 4. Legitimate public https host → accepted and persisted.
    const ok = await tenant.medusa.upsertMapping({
      baseUrl: "https://medusa.example.com/",
      apiKey: "sk_admin_secret",
      medusaStoreId: "store_j269",
    });
    assert(ok.ok === true, "allowed host upsertMapping succeeds");
    const [row] = await world.db
      .select({ baseUrl: schema.tenantIntegrations.baseUrl })
      .from(schema.tenantIntegrations)
      .where(and(
        eq(schema.tenantIntegrations.tenantId, TENANT_ID),
        eq(schema.tenantIntegrations.integrationType, "medusa"),
      ))
      .limit(1);
    assert(row?.baseUrl === "https://medusa.example.com",
      `allowed baseUrl persisted normalized (got ${row?.baseUrl})`);
  },
};
