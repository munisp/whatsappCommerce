/**
 * J80 — Shopify order bridge e2e (W16 F7).
 *
 * NOTE (W16): this journey drives the REAL /api/webhooks/shopify Express
 * route over HTTP (raw body + X-Shopify-Hmac-Sha256), but no WhatsApp
 * messages flow, so transcripts/J80.json is intentionally a header-only
 * stub (messages: []). Same convention as J75–J77.
 *
 * Flow:
 *   1. Invalid-HMAC delivery is rejected 401 BEFORE any payload processing
 *      (a malformed body is additionally 400'd by the global JSON parser
 *      before the route ever runs — either way, nothing is bridged).
 *   2. Valid-HMAC orders/create → platform order with integer-KOBO totals,
 *      paid → confirmed/completed, known SKU linked to the product row,
 *      unknown SKU captured-but-unmatched (flagged in metadata, NOT inserted
 *      into order_items), customer matched by phone.
 *   3. Duplicate delivery (Shopify at-least-once retry) → exactly-once:
 *      action 'duplicate', same platform order id, no second order.
 *   4. Second order for the same phone links the SAME customer; totals fall
 *      back to the line-sum when Shopify's total is absent (kobo math).
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { assert, SHOPIFY_API_SECRET_VALUE, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

function shopifyPost(world: World, raw: string, opts: { sign?: boolean; topic?: string; tenant?: string } = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-Topic": opts.topic ?? "orders/create",
  };
  if (opts.sign !== false) {
    headers["X-Shopify-Hmac-Sha256"] = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET_VALUE)
      .update(raw)
      .digest("base64");
  }
  return fetch(`${world.baseUrl}/api/webhooks/shopify?t=${opts.tenant ?? TENANT_ID}`, {
    method: "POST",
    headers,
    body: raw,
  });
}

export const journey: Journey = {
  id: "J80",
  name: "shopify order bridge e2e",
  feature: "HMAC fail-closed → kobo totals → exactly-once dedupe → unknown-SKU capture → customer link by phone",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j80");

    const orderRows = async () =>
      world.db.select().from(schema.orders).where(eq(schema.orders.orderNumber, "SHOPIFY-1001"));

    // ── 1. Invalid HMAC rejected PRE-PARSE ────────────────────────────────
    // Valid JSON + missing signature → the route's timing-safe verifier
    // rejects 401 before any payload processing.
    const rawWrongSig = JSON.stringify({ id: 77000, order_number: 1000, line_items: [] });
    const wrongSig = await shopifyPost(world, rawWrongSig, { sign: false });
    assert(wrongSig.status === 401, `invalid HMAC → 401 (got ${wrongSig.status})`);
    const wrongSigBody = await wrongSig.json();
    assert(wrongSigBody?.error === "invalid-signature", "honest invalid-signature error");
    // A well-formed body signed with the WRONG secret is equally rejected.
    const rawOther = JSON.stringify({ id: 77000, order_number: 1000, line_items: [] });
    const otherSig = crypto.createHmac("sha256", "not-the-app-secret").update(rawOther).digest("base64");
    const otherRes = await fetch(`${world.baseUrl}/api/webhooks/shopify?t=${TENANT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": otherSig },
      body: rawOther,
    });
    assert(otherRes.status === 401, "wrong-secret signature → 401");
    // Malformed JSON never reaches the bridge either (the global JSON parser
    // 400s it before the route handler runs — see journey header/PR notes).
    const garbage = await shopifyPost(world, "{not-json");
    assert(garbage.status === 400 || garbage.status === 401, `malformed body rejected pre-bridge (got ${garbage.status})`);
    assert((await orderRows()).length === 0, "no order created from rejected deliveries");

    // ── 2. Valid order bridges with kobo math + unknown SKU ───────────────
    const payload1 = {
      id: 77001,
      order_number: 1001,
      name: "#1001",
      currency: "ngn",
      total_price: "6500.50",
      financial_status: "paid",
      customer: { phone: `+${phone}`, email: "j80@sim.local", first_name: "Ada", last_name: "J80" },
      shipping_address: { phone: `+${phone}`, address1: "12 Sim St", city: "Lagos" },
      line_items: [
        { id: 1, sku: "SIM-JOLLOF", title: "Jollof Rice", quantity: 2, price: "2500.00" },
        { id: 2, sku: "SIM-NOPE", title: "Mystery Item", quantity: 1, price: "1500.50" },
      ],
    };
    const res1 = await shopifyPost(world, JSON.stringify(payload1));
    assert(res1.status === 200, `valid HMAC accepted (got ${res1.status})`);
    const body1 = await res1.json();
    assert(body1?.action === "created" && typeof body1.orderId === "string", "order bridged");
    assert(
      Array.isArray(body1.unmatchedItems) && body1.unmatchedItems.join(",") === "SIM-NOPE",
      "unknown SKU captured-but-unmatched",
    );

    const [order1] = await orderRows();
    assert(order1, "order persisted");
    assert(order1.totalAmount === "6500.50", `kobo math total (got ${order1.totalAmount})`);
    assert(order1.currency === "NGN", "currency normalized to uppercase ISO");
    assert(order1.status === "confirmed" && order1.paymentStatus === "completed", "paid → confirmed/completed");
    assert(order1.metadata?.totalKobo === 650050, "integer kobo total in metadata");
    assert(order1.metadata?.shopifyOrderId === "77001", "shopify order id in metadata");
    assert(order1.metadata?.unmatchedItems?.join(",") === "SIM-NOPE", "unmatched flagged in metadata");
    assert(order1.erpOrderId === "77001", "erpOrderId back-reference set");
    const items1 = Array.isArray(order1.items) ? order1.items : [];
    assert(items1.length === 2, "both lines captured on the order items json");
    const jollofLine = items1.find((i: any) => i.sku === "SIM-JOLLOF");
    const mysteryLine = items1.find((i: any) => i.sku === "SIM-NOPE");
    assert(jollofLine?.productId === "p-jollof" && jollofLine?.unmatched === false, "known SKU linked to product");
    assert(mysteryLine?.productId === null && mysteryLine?.unmatched === true, "unknown SKU flagged unmatched");
    const oiRows = await world.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order1.id));
    assert(oiRows.length === 1 && oiRows[0].productId === "p-jollof", "only matched SKUs enter order_items (FK-safe)");

    // ── 3. Duplicate delivery → exactly-once ──────────────────────────────
    const res2 = await shopifyPost(world, JSON.stringify(payload1));
    const body2 = await res2.json();
    assert(res2.status === 200 && body2?.action === "duplicate", "replay answered 200/duplicate (Shopify stops retrying)");
    assert(body2.orderId === order1.id, "duplicate resolves to the SAME platform order");
    assert((await orderRows()).length === 1, "exactly one order across the redelivery");
    const oiAfter = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order1.id));
    assert(oiAfter.length === 1, "order_items not duplicated");

    // ── 4. Second order: same phone → same customer; line-sum fallback ────
    const customerId1 = order1.customerId;
    assert(typeof customerId1 === "string" && customerId1.length > 0, "placeholder customer created for first order");
    const payload2 = {
      id: 77002,
      order_number: 1002,
      currency: "NGN",
      financial_status: "pending",
      customer: { phone: `+${phone}` },
      line_items: [
        { id: 3, sku: "SIM-CHICKEN", title: "Grilled Chicken", quantity: 3, price: "19.99" },
      ],
      // no total_price → totals fall back to integer line-sum (5997 kobo)
    };
    const res3 = await shopifyPost(world, JSON.stringify(payload2));
    const body3 = await res3.json();
    assert(res3.status === 200 && body3?.action === "created", "second order bridged");
    const [order2] = await world.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.orderNumber, "SHOPIFY-1002"));
    assert(order2?.customerId === customerId1, "second order LINKS the same customer by phone");
    assert(order2.totalAmount === "59.97", `line-sum kobo fallback (3 × 1999 = 5997; got ${order2.totalAmount})`);
    assert(order2.status === "pending" && order2.paymentStatus === "unpaid", "unpaid shopify order stays pending");

    // Dedupe ledger persisted in tenant settings.
    const s = (await world.tenantSettings()) as any;
    assert(
      s.shopifyIntegration?.orders?.processedIds?.["77001"] === order1.id &&
        s.shopifyIntegration?.orders?.processedIds?.["77002"] === order2.id,
      "dedupe map records both shopify order ids",
    );

    const audit = await world.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "shopify.order.bridged"));
    assert(audit.length === 2, "exactly two bridge audit rows (duplicate not re-audited)");
  },
};
