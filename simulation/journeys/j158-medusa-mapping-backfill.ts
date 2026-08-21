/**
 * J158 — W28 Medusa store mapping + catalog backfill.
 *
 * A tenant connects its own Medusa store (per-tenant mapping, encrypted
 * credential ref — the Wave-26 admin-only blanket is lifted for per-tenant
 * ops), tests the connection through the adapter registry (deterministic
 * mock), and runs a full catalog backfill. The backfill upserts products
 * with metadata.source="medusa" / metadata.medusaId and exact integer-cent →
 * decimal price conversion; a second backfill is fully idempotent (0 created,
 * N updated, row count unchanged). Unauthenticated callers are rejected.
 */
import { eq, sql } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, publicCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J158",
  name: "medusa store mapping + backfill sync",
  feature: "per-tenant medusa_store_mappings + adapter registry + idempotent backfill",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { mockMedusaAdapter } = await import("../../server/services/medusa/adapter");
    const caller = await tenantCaller(TENANT_ID, { userId: 1581 });

    // ── No mapping yet ──────────────────────────────────────────────────
    const before = await caller.medusa.getMapping();
    assert(before.mapping === null, "no mapping before connect");

    // ── Unauthenticated callers cannot manage mappings ──────────────────
    const pub = await publicCaller();
    await expectTrpcError(pub.medusa.getMapping(), "UNAUTHORIZED", "public caller rejected");

    // ── Connect the tenant's own store ──────────────────────────────────
    const connected = await caller.medusa.upsertMapping({
      baseUrl: "https://medusa.sim.local/",
      apiKey: "sk_sim_j158",
      medusaStoreId: "store_j158",
      medusaSalesChannelId: "sc_j158",
      syncEnabled: true,
    });
    assert(connected.ok === true, "mapping created");

    const after = await caller.medusa.getMapping();
    assert(after.mapping?.tenantId === TENANT_ID, "mapping is session-tenant scoped");
    assert(after.mapping?.baseUrl === "https://medusa.sim.local", "baseUrl normalized (trailing slash stripped)");
    assert(after.mapping?.catalogSource === "platform", "catalog source defaults to platform");
    assert(after.mapping?.syncEnabled === true, "sync enabled");
    assert(!!after.mapping?.apiKeyRef?.startsWith("tenant_integrations:"), "credential stored by reference, never inline");

    // Update path: omitting apiKey keeps the stored credential.
    await caller.medusa.upsertMapping({ baseUrl: "https://medusa.sim.local" });
    const [intRow] = await world.db
      .select({ apiKey: schema.tenantIntegrations.apiKey })
      .from(schema.tenantIntegrations)
      .where(eq(schema.tenantIntegrations.tenantId, TENANT_ID))
      .limit(1);
    assert(!!intRow?.apiKey && intRow.apiKey !== "sk_sim_j158", "credential encrypted at rest");

    // ── Connection test through the adapter registry (mock) ─────────────
    const test = await caller.medusa.testMapping();
    assert(test.ok === true, "mock adapter connection ok");

    // ── Backfill: two products, exact cent conversion ───────────────────
    mockMedusaAdapter.seedProducts([
      {
        id: "prod_j158_a",
        title: "Kano Leather Bag",
        description: "Hand-stitched",
        status: "published",
        sales_channels: [{ id: "sc_j158" }],
        variants: [{ id: "var_j158_a", title: "Default", sku: "BAG-1", prices: [{ currency_code: "ngn", amount: 125050 }], inventory_quantity: 7 }],
      },
      {
        id: "prod_j158_b",
        title: "Aso Oke Cap",
        status: "published",
        sales_channels: [{ id: "sc_j158" }],
        variants: [{ id: "var_j158_b", title: "Default", prices: [{ currency_code: "ngn", amount: 4000 }], inventory_quantity: 0 }],
      },
    ]);

    const first = await caller.medusa.backfillCatalog();
    assert(first.created === 2 && first.updated === 0, `backfill creates 2 (got ${JSON.stringify(first)})`);

    const synced = await world.db
      .select()
      .from(schema.products)
      .where(sql`${schema.products.metadata}->>'source' = 'medusa'`);
    assert(synced.length === 2, "two synced rows");
    const bag = synced.find((p) => (p.metadata as any).medusaId === "prod_j158_a")!;
    assert(bag.tenantId === TENANT_ID, "synced row is tenant-scoped");
    assert(bag.price === "1250.50", `integer cents → decimal exact (got ${bag.price})`);
    assert(bag.currency === "NGN", "currency uppercased");
    assert(bag.sku === "med:prod_j158_a", "deterministic med: sku namespace");
    assert(bag.stockQuantity === 7, "inventory synced");
    assert(bag.status === "active", "published → active");

    const mappingRow = await caller.medusa.getMapping();
    assert(!!mappingRow.mapping?.lastBackfillAt, "lastBackfillAt stamped");

    // ── Idempotent re-run: nothing created, rows converge ───────────────
    const second = await caller.medusa.backfillCatalog();
    assert(second.created === 0 && second.updated === 2, `replay idempotent (got ${JSON.stringify(second)})`);
    const syncedAfter = await world.db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(sql`${schema.products.metadata}->>'source' = 'medusa'`);
    assert(syncedAfter.length === 2, "still exactly two synced rows");

    // ── Cross-tenant isolation: another tenant sees no mapping ──────────
    const other = await tenantCaller("j158-other-tenant", { userId: 1582 });
    const otherMapping = await other.medusa.getMapping();
    assert(otherMapping.mapping === null, "other tenant has no mapping");
    await expectTrpcError(other.medusa.backfillCatalog(), "PRECONDITION_FAILED", "backfill requires own mapping");
  },
};
