/**
 * J159 — W28 Medusa catalog webhook: HMAC verification + replay-safe upsert.
 *
 * The /api/webhooks/medusa-catalog endpoint (HMAC-SHA256 over the raw body,
 * fail-closed secret) applies product.created/updated/deleted into the
 * platform products table keyed by metadata.medusaId:
 *   - replaying the same event converges to ONE row (idempotent),
 *   - updates rewrite only medusa-sourced rows,
 *   - deletes soft-archive only medusa-sourced rows,
 *   - platform-native products are NEVER clobbered,
 *   - bad signatures → 401, unresolvable tenant → 422.
 */
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const SECRET = "sim-medusa-webhook-secret-0123456789";

async function postCatalogWebhook(
  world: World,
  payload: Record<string, unknown>,
  opts: { badSignature?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const raw = JSON.stringify(payload);
  const sig = opts.badSignature
    ? "sha256=" + "0".repeat(64)
    : "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const res = await fetch(`${world.baseUrl}/api/webhooks/medusa-catalog`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-medusa-signature": sig },
    body: raw,
  });
  const json = await res.json().catch(() => null);
  await world.settle(200);
  return { status: res.status, json };
}

const medusaProduct = (over: Record<string, unknown> = {}) => ({
  id: "prod_j159",
  title: "Indigo Dye Kit",
  description: "Natural indigo",
  status: "published",
  sales_channels: [{ id: "sc_j159" }],
  variants: [{ id: "var_j159", title: "Default", prices: [{ currency_code: "ngn", amount: 25000 }], inventory_quantity: 5 }],
  ...over,
});

export const journey: Journey = {
  id: "J159",
  name: "medusa catalog webhook replay-safety",
  feature: "HMAC webhook → idempotent upsert; platform-native products untouched",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await tenantCaller(TENANT_ID, { userId: 1591 });
    await caller.medusa.upsertMapping({
      baseUrl: "https://medusa.sim.local",
      apiKey: "sk_sim_j159",
      medusaSalesChannelId: "sc_j159",
      syncEnabled: true,
    });

    // A platform-native product that must NEVER be clobbered by sync.
    await world.db.insert(schema.products).values({
      id: "j159-native",
      tenantId: TENANT_ID,
      sku: "NATIVE-INDIGO",
      name: "Indigo Dye Kit",
      description: "Merchant's own listing",
      price: "999.00",
      currency: "NGN",
      stockQuantity: 3,
      status: "active",
    }).onConflictDoNothing();

    const countSynced = async () =>
      (await world.db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(sql`${schema.products.metadata}->>'medusaId' = 'prod_j159'`)).length;

    // ── Bad signature rejected ──────────────────────────────────────────
    const bad = await postCatalogWebhook(world, { event: "product.created", data: medusaProduct() }, { badSignature: true });
    assert(bad.status === 401, `bad signature → 401 (got ${bad.status})`);
    assert((await countSynced()) === 0, "rejected webhook wrote nothing");

    // ── Unknown tenant (no mapping for the sales channel) → 422 ─────────
    const noTenant = await postCatalogWebhook(world, {
      event: "product.created",
      data: medusaProduct({ id: "prod_j159_x", sales_channels: [{ id: "sc_nowhere" }] }),
    });
    assert(noTenant.status === 422, `unresolvable tenant → 422 (got ${noTenant.status})`);

    // ── product.created → one synced row ────────────────────────────────
    const created = await postCatalogWebhook(world, { event: "product.created", data: medusaProduct() });
    assert(created.status === 200 && created.json?.action === "created", `created (got ${JSON.stringify(created.json)})`);
    assert((await countSynced()) === 1, "exactly one synced row");

    // ── Replay the SAME event → converges, no duplicate ─────────────────
    const replay = await postCatalogWebhook(world, { event: "product.created", data: medusaProduct() });
    assert(replay.json?.action === "updated", "replay is an update, not an insert");
    assert((await countSynced()) === 1, "replay did not duplicate");

    // ── product.updated → price/stock rewritten on the same row ─────────
    const updated = await postCatalogWebhook(world, {
      event: "product.updated",
      data: medusaProduct({
        variants: [{ id: "var_j159", title: "Default", prices: [{ currency_code: "ngn", amount: 30010 }], inventory_quantity: 2 }],
      }),
    });
    assert(updated.json?.action === "updated", "updated action");
    const [synced] = await world.db
      .select()
      .from(schema.products)
      .where(sql`${schema.products.metadata}->>'medusaId' = 'prod_j159'`)
      .limit(1);
    assert(synced.price === "300.10", `price updated exactly (got ${synced.price})`);
    assert(synced.stockQuantity === 2, "stock updated");
    assert((await countSynced()) === 1, "update stayed on one row");

    // ── Platform-native product untouched by all of the above ───────────
    const [native] = await world.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, "j159-native"))
      .limit(1);
    assert(native.price === "999.00" && native.description === "Merchant's own listing", "platform-native product never clobbered");
    assert(native.status === "active", "native product still active");

    // ── product.deleted → soft-archive the synced row only ──────────────
    const deleted = await postCatalogWebhook(world, { event: "product.deleted", data: medusaProduct() });
    assert(deleted.json?.action === "archived", "deleted → archived");
    const [archived] = await world.db
      .select()
      .from(schema.products)
      .where(sql`${schema.products.metadata}->>'medusaId' = 'prod_j159'`)
      .limit(1);
    assert(archived.status === "inactive", "synced row archived (soft delete)");
    const [nativeAfter] = await world.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, "j159-native"))
      .limit(1);
    assert(nativeAfter.status === "active", "native product survives deletes");

    // Deleting again is a no-op (replay-safe).
    const deleteReplay = await postCatalogWebhook(world, { event: "product.deleted", data: medusaProduct() });
    assert(deleteReplay.json?.action === "skipped", "delete replay skipped");
  },
};
