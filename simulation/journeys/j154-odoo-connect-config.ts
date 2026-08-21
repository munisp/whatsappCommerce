/**
 * J154 — W28 odoo-sync: tenant connects Odoo + config validation.
 * Saves a mock:// connection via the tenant-guarded router (api key stored
 * encrypted, never echoed back), runs "test connection" (deterministic mock
 * auth), validates syncMode/account-mapping/enable toggle, rejects bad urls,
 * and confirms the surface is tenant-scoped (public callers rejected; the
 * api key never leaves the server).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, publicCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J154",
  name: "odoo connect + config validation",
  feature: "W28 odoo-sync connection config",
  async run(world: World) {
    const tenant = await tenantCaller(TENANT_ID);

    // No config yet.
    const initial = await tenant.odooSync.getConfig();
    assert(initial.config === null, "no odoo config initially");
    assert(initial.stats.pending === 0 && initial.stats.sent === 0, "empty outbox stats");

    // Invalid url rejected (must be http(s):// or mock://).
    await expectTrpcError(
      tenant.odooSync.saveConfig({ url: "ftp://evil", db: "sim" }),
      "BAD_REQUEST", "non-http url rejected",
    );

    // Save a mock connection with an api key + account mapping.
    const saved = await tenant.odooSync.saveConfig({
      url: "mock://odoo",
      db: "sim-db",
      username: "api@sim.local",
      apiKey: "super-secret-key-154",
      syncMode: "batch",
      accountMapping: { incomeAccountId: 10, expenseAccountId: 20 },
    });
    assert(saved.config.tenantId === TENANT_ID, "config scoped to tenant");
    assert(saved.config.hasApiKey === true, "api key recorded (redacted)");
    assert((saved.config as any).apiKey === undefined, "api key never returned to client");
    assert(saved.config.syncMode === "batch", "sync mode persisted");
    assert(saved.config.enabled === false, "disabled by default");

    // Test connection (deterministic mock authenticate).
    const test = await tenant.odooSync.testConnection();
    assert(test.ok === true, `mock connection test ok (got ${JSON.stringify(test)})`);
    assert(typeof test.uid === "number" && test.uid > 0, "uid returned");
    const afterTest = await tenant.odooSync.getConfig();
    assert(afterTest.config?.lastTestOk === true, "test result recorded");

    // Enable + switch mode + update mapping via the dedicated mutations.
    await tenant.odooSync.setEnabled({ enabled: true });
    await tenant.odooSync.setSyncMode({ syncMode: "push" });
    await tenant.odooSync.setAccountMapping({ accountMapping: { incomeAccountId: 11 } });
    const cfg = (await tenant.odooSync.getConfig()).config;
    assert(cfg?.enabled === true, "enabled");
    assert(cfg?.syncMode === "push", "push mode set");
    assert((cfg?.accountMapping as any)?.incomeAccountId === 11, "mapping updated");

    // Saving without apiKey keeps the stored (encrypted) key.
    await tenant.odooSync.saveConfig({ url: "mock://odoo", db: "sim-db" });
    const kept = (await tenant.odooSync.getConfig()).config;
    assert(kept?.hasApiKey === true, "api key kept when omitted");
    assert(kept?.username === null, "username cleared on explicit save");

    // At-rest encryption: the raw row must NOT carry plaintext.
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [raw] = await world.db.select().from(schema.odooConfigs)
      .where(eq(schema.odooConfigs.tenantId, TENANT_ID)).limit(1);
    assert(raw.apiKey && raw.apiKey.startsWith("v1:"), `api key encrypted at rest (got ${raw.apiKey?.slice(0, 12)}…)`);
    assert(!raw.apiKey.includes("super-secret"), "plaintext key never persisted");

    // Authz: unauthenticated callers are rejected.
    const pub = await publicCaller();
    await expectTrpcError(pub.odooSync.getConfig(), "UNAUTHORIZED", "public getConfig rejected");
    await expectTrpcError(
      pub.odooSync.saveConfig({ url: "mock://x", db: "y" }),
      "UNAUTHORIZED", "public saveConfig rejected",
    );

    // WhatsApp: "odoo status" from the seeded admin phone reports the config.
    const { ADMIN_PHONE, bodyText } = await import("../world");
    await world.text(ADMIN_PHONE, "odoo status");
    const reply = bodyText(world.outbound.lastOfType("text", ADMIN_PHONE));
    assert(reply.includes("Odoo sync status"), `status reply (got: ${reply})`);
    assert(reply.includes("push mode"), "mode echoed in status");

    // A non-admin phone gets no Odoo surface (falls through, not handled).
    const outsider = world.newPhone("j154");
    const { handleOdooCommand } = await import("../../server/services/odoo/odooWhatsApp");
    const out = await handleOdooCommand({ db: world.db, tenantId: TENANT_ID, waPhoneNumber: outsider, text: "ODOO STATUS" });
    assert(out.handled === false, "non-admin phone cannot run odoo commands");
  },
};
