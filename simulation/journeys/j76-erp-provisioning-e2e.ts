/**
 * J76 — ERP provisioning e2e (W15 F5).
 *
 * NOTE (W15.1): this journey calls the ERP provisioning services/router
 * directly (scripted connector endpoints, no WhatsApp traffic), so the
 * transcript recorder captures no messages and transcripts/J76.json is
 * intentionally a header-only stub (messages: []).
 *
 * A tenant with Odoo + Twenty configured provisions its standard objects via
 * provisionErpTenantObjects against scripted connector endpoints (the REAL
 * integrationSync fetch path — metaMock's W15 per-host ERP handlers):
 *   1. First run: search-before-create ADOPTS a pre-existing Odoo partner
 *      category ('exists'), creates the rest; externalIds persist to
 *      tenants.settings.erpProvision and the run is audit-logged.
 *   2. Re-provision: every object returns 'exists', ZERO create calls.
 *   3. Failure isolation: Odoo auth down → its 3 objects 'failed', Twenty
 *      still provisions, overall ok=false, no partial state lost.
 *   4. dryRun: no network calls, no settings mutation.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { erp } from "../metaMock";

const ODOO_HOST = "odoo-j76.sim.local";
const TWENTY_HOST = "twenty-j76.sim.local";

/** Scripted Odoo JSON-RPC server. Pre-seeded `objects` simulate pre-existing
 *  records (adoption path); `creates` records every create call. */
function scriptOdoo(state: {
  failAuth: boolean;
  objects: Map<string, number>;
  creates: Array<{ model: string; name: string }>;
}) {
  let nextId = 1000;
  erp.script(ODOO_HOST, (body: any) => {
    const p = body?.params ?? {};
    if (p.service === "common" && p.method === "authenticate") {
      if (state.failAuth) return { json: { error: { data: { message: "sim: odoo auth endpoint down" } } } };
      return { json: { result: 42 } };
    }
    if (p.service === "object" && p.method === "execute_kw") {
      const [, , , model, method, args] = p.args as any[];
      if (method === "search") {
        const name = args?.[0]?.[0]?.[2];
        const found = state.objects.get(`${model}:${name}`);
        return { json: { result: found ? [found] : [] } };
      }
      if (method === "create") {
        const id = ++nextId;
        state.creates.push({ model, name: args?.[0]?.name });
        state.objects.set(`${model}:${args?.[0]?.name}`, id);
        return { json: { result: id } };
      }
    }
    return { json: { result: null } };
  });
}

/** Scripted Twenty GraphQL server (companies find/create + schema probe). */
function scriptTwenty(state: { failSchema: boolean; companies: Map<string, string>; creates: string[] }) {
  let n = 0;
  erp.script(TWENTY_HOST, (body: any) => {
    const q = String(body?.query ?? "");
    if (q.includes("__schema")) {
      if (state.failSchema) return { status: 400, json: { errors: [{ message: "sim: twenty down" }] } };
      return { json: { data: { __schema: { queryType: { name: "Query" } } } } };
    }
    if (q.includes("createCompany")) {
      const id = `cmp-j76-${++n}`;
      state.companies.set(body?.variables?.name, id);
      state.creates.push(id);
      return { json: { data: { createCompany: { id } } } };
    }
    if (q.includes("companies")) {
      const id = state.companies.get(body?.variables?.name);
      return { json: { data: { companies: { edges: id ? [{ node: { id } }] : [] } } } };
    }
    return { json: { data: {} } };
  });
}

export const journey: Journey = {
  id: "J76",
  name: "erp provisioning e2e",
  feature: "provisionErpTenantObjects: adopt/create, idempotent, isolated failure, dry-run",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { provisionErpTenantObjects } = await import("../../server/services/erpProvision");

    const odoo = { failAuth: false, objects: new Map<string, number>(), creates: [] as Array<{ model: string; name: string }> };
    const twenty = { failSchema: false, companies: new Map<string, string>(), creates: [] as string[] };
    scriptOdoo(odoo);
    scriptTwenty(twenty);

    // A partner category created OUTSIDE this flow — must be adopted, not duplicated.
    odoo.objects.set("res.partner.category:WhatsApp Commerce", 777);

    const erpState = async () =>
      ((await world.tenantSettings()) as Record<string, any>).erpProvision ?? null;

    try {
      await world.db.insert(schema.odooIntegrations).values({
        id: "odoo-j76",
        tenantId: TENANT_ID,
        baseUrl: `http://${ODOO_HOST}`,
        database: "simdb",
        username: "sim@odoo.local",
        apiKey: "sim-odoo-key",
        status: "connected",
      });
      await world.db.insert(schema.twentyIntegrations).values({
        id: "twenty-j76",
        tenantId: TENANT_ID,
        baseUrl: `http://${TWENTY_HOST}`,
        apiKey: "sim-twenty-key",
        status: "connected",
      });

      // ── 1. First run: adopt + create ─────────────────────────────────────
      const run1 = await provisionErpTenantObjects({ tenantId: TENANT_ID });
      assert(run1.ok === true && run1.dryRun === false, `run 1 ok (${JSON.stringify(run1).slice(0, 300)})`);
      const r1 = new Map(run1.results.map((r) => [`${r.erp}:${r.object}`, r]));
      assert(r1.get("odoo:partner-category")?.status === "exists"
        && r1.get("odoo:partner-category")?.externalId === "777",
        "pre-existing partner category ADOPTED via search-before-create");
      assert(r1.get("odoo:partner")?.status === "created", "odoo partner created");
      assert(r1.get("odoo:price-list")?.status === "created", "odoo price list created");
      assert(r1.get("twenty:company")?.status === "created", "twenty company created");
      assert(r1.get("twenty:pipeline")?.status === "created", "twenty pipeline mapping recorded");
      assert(r1.get("medusa:sales-channel")?.status === "skipped", "unconfigured medusa skipped, not failed");
      assert(
        odoo.creates.map((c) => c.model).join(",") === "res.partner,product.pricelist",
        `odoo created exactly partner + pricelist (got ${odoo.creates.map((c) => c.model).join(",")})`,
      );

      const state1 = await erpState();
      assert(state1 && typeof state1.lastRunAt === "string", "erpProvision state persisted");
      for (const key of ["odoo:partner-category", "odoo:partner", "odoo:price-list", "twenty:company", "twenty:pipeline"]) {
        assert(state1.objects[key], `externalId persisted for ${key}`);
      }
      assert(state1.objects["odoo:partner-category"].externalId === "777", "adopted externalId persisted");
      assert(state1.runs.length === 1, "run recorded for operator visibility");

      const audit = await world.db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "erp_provision.run"));
      assert(audit.length === 1, "provisioning run audit-logged");

      // ── 2. Re-provision: everything 'exists', zero duplicates ────────────
      const createsBefore = odoo.creates.length + twenty.creates.length;
      const run2 = await provisionErpTenantObjects({ tenantId: TENANT_ID });
      assert(run2.ok === true, "run 2 ok");
      assert(
        run2.results.filter((r) => r.status === "exists").length === 5,
        `all 5 configured objects exist on re-run (got ${run2.results.map((r) => `${r.erp}:${r.object}=${r.status}`).join(",")})`,
      );
      assert(
        odoo.creates.length + twenty.creates.length === createsBefore,
        "ZERO create calls on re-provision (no duplicates)",
      );

      // ── 3. Failure isolation: Odoo down, Twenty unaffected ───────────────
      odoo.failAuth = true;
      const run3 = await provisionErpTenantObjects({ tenantId: TENANT_ID });
      assert(run3.ok === false, "overall run reports failure");
      const odooR3 = run3.results.filter((r) => r.erp === "odoo");
      assert(odooR3.length === 3 && odooR3.every((r) => r.status === "failed"), "all odoo objects failed in isolation");
      assert(
        odooR3.every((r) => /connection test failed/.test(r.error ?? "")),
        "honest connection-test error per odoo object",
      );
      const twentyR3 = run3.results.filter((r) => r.erp === "twenty");
      assert(
        twentyR3.length === 2 && twentyR3.every((r) => r.status === "exists"),
        "twenty still provisions while odoo is down",
      );
      // Previously-persisted objects survive the failed run.
      const state3 = await erpState();
      assert(state3.objects["odoo:partner"].externalId === state1.objects["odoo:partner"].externalId,
        "prior externalIds survive a failed re-run");
      odoo.failAuth = false;

      // ── 4. Dry-run: no network, no state mutation ────────────────────────
      const callsBefore = erp.calls.length;
      const dry = await provisionErpTenantObjects({ tenantId: TENANT_ID }, { dryRun: true });
      assert(dry.ok === true && dry.dryRun === true, "dry-run reports");
      assert(erp.calls.length === callsBefore, "dry-run made ZERO connector calls");
      const state4 = await erpState();
      assert(state4.lastRunAt === state3.lastRunAt && state4.runs.length === state3.runs.length,
        "dry-run persisted nothing");
      assert(
        dry.results.filter((r) => r.status === "exists").length === 5,
        "dry-run reports existing objects accurately",
      );
    } finally {
      await world.db.delete(schema.odooIntegrations).where(eq(schema.odooIntegrations.id, "odoo-j76")).catch(() => {});
      await world.db.delete(schema.twentyIntegrations).where(eq(schema.twentyIntegrations.id, "twenty-j76")).catch(() => {});
      const s = { ...(await world.tenantSettings()) } as Record<string, any>;
      delete s.erpProvision;
      await world.db
        .update(schema.tenants)
        .set({ settings: s, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID));
      erp.reset();
    }
  },
};
