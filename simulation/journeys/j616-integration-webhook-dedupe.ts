// === W62 findings ===
/**
 * J616 — F12: /integrations/:system/webhook insert-first dedupe regression.
 * Identical redeliveries (integration partners retry until 200) previously
 * re-applied the payload. The handler now claims sha256(system+tenant+body)
 * against the processed_webhook_events ledger first: the second identical
 * POST returns applied:'duplicate' and writes nothing new, while a DISTINCT
 * update to the same entity still applies.
 */
import { createHmac } from "node:crypto";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

const SECRET = "j616-integration-webhook-secret";

async function postIntegrationWebhook(world: World, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
  const res = await fetch(`${world.baseUrl}/integrations/medusa/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-integration-signature": `sha256=${sig}`,
      "x-tenant-id": TENANT_ID,
    },
    body: raw,
  });
  const json = await res.json().catch(() => null);
  await world.settle(200);
  return { status: res.status, json };
}

const event = (price: number) => ({
  entity: "product",
  action: "updated",
  data: { id: "med_j616", title: "J616 Widget", variants: [{ sku: "J616", prices: [{ amount: price }], inventory_quantity: 3 }] },
});

export const journey: Journey = {
  id: "J616",
  name: "integrations webhook: identical redelivery deduped, distinct update applies",
  feature: "W62 findings F12: webhook dedupe",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { eq, sql } = await import("drizzle-orm");
    const { encryptSecret } = await import("../../server/services/crypto/secrets");
    // Configure the tenant's medusa integration webhook secret (encrypted).
    const cfg = JSON.stringify({ integrations: { medusa: { webhookSecret: encryptSecret(SECRET) } } });
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${cfg}'::jsonb WHERE id = '${TENANT_ID}'`,
    );
    try {
      // ── First delivery applies ─────────────────────────────────────────
      const first = await postIntegrationWebhook(world, event(100));
      assert(first.status === 200, `first delivery 200 (got ${first.status}: ${JSON.stringify(first.json)})`);
      assert(first.json?.applied === "created" || first.json?.applied === "updated", `applied (got ${first.json?.applied})`);
      const countRows = async () =>
        (await world.db.select({ id: schema.products.id }).from(schema.products)
          .where(sql`${schema.products.metadata}->>'medusaId' = 'med_j616'`)).length;
      assert((await countRows()) === 1, "one product row after first delivery");

      // ── Identical redelivery → duplicate, no re-apply ──────────────────
      const replay = await postIntegrationWebhook(world, event(100));
      assert(replay.status === 200 && replay.json?.applied === "duplicate", `identical replay deduped (got ${JSON.stringify(replay.json)})`);
      assert((await countRows()) === 1, "replay wrote nothing new");

      // ── Distinct update to the same entity still applies ───────────────
      const distinct = await postIntegrationWebhook(world, event(250));
      assert(distinct.status === 200 && distinct.json?.applied === "updated", `distinct update applies (got ${JSON.stringify(distinct.json)})`);
      const [p] = await world.db.select().from(schema.products)
        .where(sql`${schema.products.metadata}->>'medusaId' = 'med_j616'`).limit(1);
      assert(p.price === "250.00", `price updated (got ${p.price})`);
    } finally {
      await world.db.execute(`DELETE FROM products WHERE metadata->>'medusaId' = 'med_j616'`).catch(() => {});
      await world.db.execute(`DELETE FROM "processed_webhook_events" WHERE id IN (SELECT id FROM "processed_webhook_events" WHERE type LIKE 'integration:medusa:%')`).catch(() => {});
    }
  },
};
