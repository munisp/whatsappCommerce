/**
 * J83 — Marketplace lite lifecycle (W16 F7).
 *
 * NOTE (W16): this journey drives the marketplace service + router seams
 * directly (scripted Odoo endpoint via the W15 erp host handlers) — no
 * WhatsApp traffic, so transcripts/J83.json is intentionally a header-only
 * stub (messages: []). Same convention as J75–J77.
 *
 * Flow:
 *   1. listConnectors enriches the 4-connector catalog with per-tenant
 *      status (all not_installed).
 *   2. installConnector('shopify') without credentials → awaiting_config
 *      with required fields (fail-closed: nothing activates).
 *      KNOWN PRODUCT BUG (reported, not fixed): the marketplace shopify
 *      descriptor (marketplace/connectors.ts) probes the shopifyIntegration
 *      module for `isConfigured`/`testConnection`/`getInstallUrl` exports
 *      that the module never provides (it exports `shopifyConnector`
 *      instead), so installUrl is always null and isConfigured falls back
 *      to a settings.integrations.shopify block the OAuth flow never
 *      writes — a fully-OAuth-connected tenant STILL shows awaiting_config.
 *      This journey pins the observed behavior as evidence.
 *   3. Odoo configured but UNHEALTHY → install fails closed
 *      (status 'failed', audit 'marketplace.connector.install_failed', no
 *      active state); flips healthy → install activates ('active',
 *      audit-logged, listing shows 'configured').
 *   4. marketplaceHealth caches probes for 60s (second call serves
 *      cached:true entries with ZERO new connector calls).
 *   5. uninstallConnector deactivates with the data-retention note + audit;
 *      state record preserved as 'uninstalled'; repeat uninstall is a quiet
 *      idempotent no-op.
 *   6. Cross-tenant read via tRPC → FORBIDDEN.
 */
import { eq } from "drizzle-orm";
import { assert, SUPPLIER_TENANT_ID, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { erp } from "../metaMock";
import { tenantCaller, expectTrpcError } from "./helpers";

const ODOO_HOST = "odoo-j83.sim.local";

export const journey: Journey = {
  id: "J83",
  name: "marketplace lifecycle",
  feature: "catalog enrichment → awaiting_config → fail-closed health gate → cache → audited uninstall → FORBIDDEN",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const mk = await import("../../server/services/marketplace");

    let odooDown = true;
    erp.script(ODOO_HOST, (body: any) => {
      const p = body?.params ?? {};
      if (p.service === "common" && p.method === "authenticate") {
        if (odooDown) return { json: { error: { data: { message: "sim: odoo auth endpoint down" } } } };
        return { json: { result: 42 } };
      }
      return { json: { result: null } };
    });

    const marketplaceState = async () =>
      ((await world.tenantSettings()) as Record<string, any>).marketplace?.connectors ?? {};
    const auditRows = async (action: string) =>
      world.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action));

    try {
      // ── 1. Catalog with status enrichment ────────────────────────────────
      const list0 = await mk.listConnectors({ tenantId: TENANT_ID });
      assert(list0.length === 4, "4-connector catalog");
      assert(list0.map((c) => c.key).join(",") === "odoo,twenty,medusa,shopify", "catalog order stable");
      assert(list0.every((c) => c.status === "not_installed"), "everything not_installed initially");
      const shopify0 = list0.find((c) => c.key === "shopify")!;
      // KNOWN PRODUCT BUG (see header): descriptor↔module export mismatch —
      // installUrl is null even though app credentials are configured.
      assert(shopify0.installUrl === null, "observed: shopify installUrl null (descriptor seam mismatch)");

      // ── 2. Install without config → awaiting_config ─────────────────────
      const aw = await mk.installConnector({ tenantId: TENANT_ID, key: "shopify", actorId: "j83", actorRole: "admin" });
      assert(aw.status === "awaiting_config", "unconfigured install never activates");
      assert((aw as any).requiredFields?.join(",") === "shopDomain,accessToken", "required fields surfaced");
      assert(Object.keys(await marketplaceState()).length === 0, "awaiting_config persists no active state");

      // Bug evidence: even with a REAL OAuth connection persisted by the
      // shopifyIntegration flow, the marketplace still reports
      // awaiting_config (isConfigured reads settings.integrations.shopify,
      // which the OAuth flow never writes).
      const { encryptToken, updateShopifyState, getShopifyConnection } = await import("../../server/services/shopifyIntegration/state");
      await updateShopifyState(TENANT_ID, (s) => {
        s.connection = {
          shop: "shop-j83.myshopify.com",
          accessTokenEncrypted: encryptToken("shpat_j83"),
          scope: "read_products",
          installedAt: new Date().toISOString(),
        };
      });
      assert((await getShopifyConnection(TENANT_ID))?.shop === "shop-j83.myshopify.com", "real connection persisted");
      const aw2 = await mk.installConnector({ tenantId: TENANT_ID, key: "shopify", actorId: "j83", actorRole: "admin" });
      assert(aw2.status === "awaiting_config", "BUG pinned: connected shopify still awaiting_config in marketplace");
      // wipe the connection again so the rest of the journey is unaffected
      await updateShopifyState(TENANT_ID, (s) => {
        s.connection = null;
      });

      // ── 3. Fail-closed health gate, then healthy activation ─────────────
      await world.db.insert(schema.odooIntegrations).values({
        id: "odoo-j83",
        tenantId: TENANT_ID,
        baseUrl: `http://${ODOO_HOST}`,
        database: "simdb",
        username: "sim@odoo.local",
        apiKey: "sim-odoo-key",
        status: "connected",
      });
      const fail = await mk.installConnector({ tenantId: TENANT_ID, key: "odoo", actorId: "j83", actorRole: "admin" });
      assert(fail.status === "failed" && fail.health?.ok === false, "failing health check blocks activation");
      assert((await marketplaceState()).odoo === undefined, "failed install leaves NO active connector state");
      const failAudit = await auditRows("marketplace.connector.install_failed");
      assert(failAudit.length === 1, "blocked install audit-logged");

      odooDown = false;
      const okInstall = await mk.installConnector({ tenantId: TENANT_ID, key: "odoo", actorId: "j83", actorRole: "admin" });
      assert(okInstall.status === "active" && okInstall.health?.ok === true, "healthy connector activates");
      assert((await marketplaceState()).odoo?.status === "active", "active state persisted");
      const list1 = await mk.listConnectors({ tenantId: TENANT_ID });
      assert(list1.find((c) => c.key === "odoo")?.status === "configured", "listing enriches to configured");
      assert(list1.find((c) => c.key === "odoo")?.installedAt, "installedAt surfaced");

      // Idempotent re-install: no duplicate audit row.
      const again = await mk.installConnector({ tenantId: TENANT_ID, key: "odoo", actorId: "j83", actorRole: "admin" });
      assert(again.status === "active" && (again as any).alreadyInstalled === true, "re-install is idempotent");
      assert((await auditRows("marketplace.connector.install")).length === 1, "no duplicate install audit");

      // ── 4. 60s health cache ──────────────────────────────────────────────
      mk.clearHealthCache();
      const callsBefore = erp.calls.length;
      const h1 = await mk.marketplaceHealth({ tenantId: TENANT_ID });
      const odooH1 = h1.connectors.find((c) => c.key === "odoo")!;
      assert(odooH1.health.ok === true && odooH1.cached === false && odooH1.installed === true, "first probe live");
      const callsAfterFirst = erp.calls.length;
      assert(callsAfterFirst > callsBefore, "first probe hit the connector");
      const h2 = await mk.marketplaceHealth({ tenantId: TENANT_ID });
      const odooH2 = h2.connectors.find((c) => c.key === "odoo")!;
      assert(odooH2.cached === true, "second probe served from the 60s cache");
      assert(erp.calls.length === callsAfterFirst, "cached probe made ZERO connector calls");
      // Other tenants get their own cache entries (no cross-tenant bleed).
      const hOther = await mk.marketplaceHealth({ tenantId: SUPPLIER_TENANT_ID });
      assert(hOther.connectors.every((c) => c.cached === false), "other tenant misses the cache");

      // ── 5. Uninstall: audited, state preserved, idempotent ──────────────
      const un = await mk.uninstallConnector({ tenantId: TENANT_ID, key: "odoo", actorId: "j83", actorRole: "admin" });
      assert(un.status === "uninstalled" && un.dataRetention === mk.DATA_RETENTION_NOTE, "retention note returned");
      const rec = (await marketplaceState()).odoo;
      assert(rec?.status === "uninstalled" && typeof rec.uninstalledAt === "string" && rec.installedAt,
        "uninstall preserves the audit-trail record");
      const unAudit = await auditRows("marketplace.connector.uninstall");
      assert(unAudit.length === 1, "uninstall audit-logged");
      const list2 = await mk.listConnectors({ tenantId: TENANT_ID });
      assert(list2.find((c) => c.key === "odoo")?.status === "not_installed", "listing back to not_installed");
      const un2 = await mk.uninstallConnector({ tenantId: TENANT_ID, key: "odoo", actorId: "j83", actorRole: "admin" });
      assert(un2.status === "not_installed" && (un2 as any).alreadyUninstalled === true, "repeat uninstall is a quiet no-op");
      assert((await auditRows("marketplace.connector.uninstall")).length === 1, "no duplicate uninstall audit");

      // ── 6. Cross-tenant read → FORBIDDEN ────────────────────────────────
      const outsider = await tenantCaller(SUPPLIER_TENANT_ID, { userId: 777, role: "user" });
      await expectTrpcError(
        outsider.marketplace.listConnectors({ tenantId: TENANT_ID }),
        "FORBIDDEN",
        "cross-tenant listConnectors",
      );
      await expectTrpcError(
        outsider.marketplace.connectorHealth({ tenantId: TENANT_ID }),
        "FORBIDDEN",
        "cross-tenant connectorHealth",
      );
    } finally {
      await world.db.delete(schema.odooIntegrations).where(eq(schema.odooIntegrations.id, "odoo-j83")).catch(() => {});
      const s = { ...(await world.tenantSettings()) } as Record<string, any>;
      if ("marketplace" in s) {
        delete s.marketplace;
        await world.db
          .update(schema.tenants)
          .set({ settings: s, updatedAt: new Date() })
          .where(eq(schema.tenants.id, TENANT_ID));
      }
      mk.clearHealthCache();
      erp.reset();
    }
  },
};
