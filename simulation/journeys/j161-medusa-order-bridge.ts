/**
 * J161 — W28 order bridge: storefront medusa purchase → platform order
 * (existing payment/escrow rails) → outbound Medusa order via the adapter
 * (deterministic mock) → fulfillment webhook → delivery/escrow release via
 * existing rails (DB state only — escrow.ts untouched).
 *
 *   1. Tenant connects a sync-enabled Medusa mapping; a medusa-sourced
 *      product is synced into the platform catalog.
 *   2. A buyer places a REAL chat order over that product and pays via the
 *      REAL paystack webhook → escrow_held (existing rails, unchanged).
 *   3. medusa.bridgeOrder mirrors the order to Medusa exactly once
 *      (idempotent; second call short-circuits, mock sees ONE createOrder).
 *   4. The fulfillment webhook (order.completed, HMAC-verified) marks the
 *      platform order delivered AND advances the escrow hold to
 *      delivery_confirmed — the same DB state escrow.confirmDelivery sets.
 *   5. The existing buyerConfirm rail then releases the escrow
 *      (settled / release_instructed) with no edits to escrow.ts.
 *   6. Bad-signature fulfillment webhooks are rejected (401).
 */
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, createChatOrderViaNlp, paystackChargeSuccess, tenantCaller } from "./helpers";

const SECRET = "sim-medusa-webhook-secret-0123456789";

async function postFulfillment(
  world: World,
  payload: Record<string, unknown>,
  opts: { badSignature?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const raw = JSON.stringify(payload);
  const sig = opts.badSignature
    ? "sha256=" + "0".repeat(64)
    : "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const res = await fetch(`${world.baseUrl}/api/webhooks/medusa-fulfillment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-medusa-signature": sig },
    body: raw,
  });
  const json = await res.json().catch(() => null);
  await world.settle(200);
  return { status: res.status, json };
}

export const journey: Journey = {
  id: "J161",
  name: "storefront order → medusa order → fulfillment → escrow release",
  feature: "order bridge + idempotent outbound create + fulfillment webhook → existing release rails",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { mockMedusaAdapter } = await import("../../server/services/medusa/adapter");
    const caller = await tenantCaller(TENANT_ID, { userId: 1611 });

    // ── 1. Sync-enabled mapping + one medusa-sourced product ────────────
    await caller.medusa.upsertMapping({
      baseUrl: "https://medusa.sim.local",
      apiKey: "sk_sim_j161",
      medusaSalesChannelId: "sc_j161",
      syncEnabled: true,
    });
    await world.db.insert(schema.products).values({
      id: "j161-med-prod",
      tenantId: TENANT_ID,
      sku: "med:prod_j161",
      name: "Jollof Rice Deluxe", // distinct name — the synced medusa catalog entry
      price: "2500.00",
      currency: "NGN",
      stockQuantity: 20,
      status: "active",
      metadata: { source: "medusa", medusaId: "prod_j161", medusaVariantId: "var_j161" },
    }).onConflictDoNothing();

    // ── 2. Real chat order + real paystack payment → escrow_held ────────
    const phone = world.newPhone("j161");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice Deluxe", quantity: 1 }],
    });
    assert(order.paymentRef, "payment reference captured");

    // The order item must reference the synced medusa product (provenance is
    // read from the products table by the bridge).
    const [orderRow] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert((orderRow.items as any[]).some((i) => i.productId === "j161-med-prod"), "chat order resolved the medusa-synced product");

    const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);
    let escrow: any = null;
    await world.waitFor(async () => {
      const [e] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
      escrow = e ?? null;
      return !!escrow && escrow.state === "escrow_held";
    }, 10000, "escrow hold created in escrow_held");

    // ── 3. Outbound bridge — exactly once ───────────────────────────────
    const bridged = await caller.medusa.bridgeOrder({ orderId: order.orderId });
    assert(bridged.bridged === true && !!bridged.medusaOrderId, `order bridged (got ${JSON.stringify(bridged)})`);
    assert(mockMedusaAdapter.createOrderCalls.length === 1, "mock saw exactly one createOrder");
    const createCall = mockMedusaAdapter.createOrderCalls[0];
    assert(createCall.platformOrderId === order.orderId, "createOrder references the platform order");
    assert(createCall.items.length === 1 && createCall.items[0].variantId === "var_j161", "medusa variant resolved from provenance");
    assert(createCall.items[0].unitPriceCents === 250000, `integer cents unit price (got ${createCall.items[0].unitPriceCents})`);
    assert(Number.isInteger(createCall.totalCents), "integer cents total");

    const linkState = await caller.medusa.getOrderBridge({ orderId: order.orderId });
    assert(linkState.link?.medusaOrderId === bridged.medusaOrderId, "link row persisted");
    const [orderAfter] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(orderAfter.erpOrderId === bridged.medusaOrderId, "erpOrderId reverse-lookup set");

    // Idempotent re-bridge: no second Medusa order.
    const rebridge = await caller.medusa.bridgeOrder({ orderId: order.orderId });
    assert(rebridge.bridged === false && rebridge.reason === "already-bridged", "re-bridge short-circuits");
    assert(mockMedusaAdapter.createOrderCalls.length === 1, "still exactly one outbound order");

    // Cross-tenant guard: another tenant cannot bridge this order.
    const stranger = await tenantCaller("j161-other", { userId: 1612 });
    const foreign = await stranger.medusa.bridgeOrder({ orderId: order.orderId }).catch(() => null);
    assert(!foreign || foreign.bridged === false, "cross-tenant bridge refused");

    // ── 4. Bad signature rejected; valid fulfillment webhook advances ───
    const bad = await postFulfillment(world, { event: "order.completed", data: { id: bridged.medusaOrderId } }, { badSignature: true });
    assert(bad.status === 401, `bad signature → 401 (got ${bad.status})`);

    const fulfilled = await postFulfillment(world, { event: "order.completed", data: { id: bridged.medusaOrderId } });
    assert(fulfilled.status === 200 && fulfilled.json?.action === "updated", `fulfillment applied (got ${JSON.stringify(fulfilled.json)})`);
    assert(fulfilled.json?.newStatus === "delivered", "order marked delivered");
    assert(fulfilled.json?.escrowAdvanced === true, "escrow advanced via DB state");

    const [deliveredOrder] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(deliveredOrder.status === "delivered", "platform order delivered");
    const [escrowMid] = await world.db.select().from(schema.escrowTransactions)
      .where(and(eq(schema.escrowTransactions.orderId, order.orderId))).limit(1);
    assert(escrowMid.state === "delivery_confirmed", `escrow at delivery_confirmed (got ${escrowMid.state})`);

    // Replay of the same webhook is a no-op for the escrow checkpoint.
    const replayed = await postFulfillment(world, { event: "order.completed", data: { id: bridged.medusaOrderId } });
    assert(replayed.json?.escrowAdvanced === false, "webhook replay does not re-advance escrow");

    // ── 5. Existing release rail completes (buyerConfirm — escrow.ts) ───
    const admin = await adminCaller();
    const released = await admin.escrow.buyerConfirm({ escrowId: escrowMid.id, autoConfirmed: true });
    assert(["settled", "release_instructed"].includes((released as any)?.state ?? (released as any)?.escrow?.state),
      `escrow released via existing rail (got ${JSON.stringify(released).slice(0, 200)})`);
    const [escrowFinal] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrowMid.id)).limit(1);
    assert(["settled", "release_instructed"].includes(escrowFinal.state), `final escrow state ${escrowFinal.state}`);
  },
};
