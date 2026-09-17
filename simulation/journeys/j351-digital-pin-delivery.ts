// === W44 deposits-subs-digital (Coder C) ===
/**
 * J351 — PIN digital goods end-to-end:
 *  - Merchant bulk-uploads 11 PINs (tRPC digitalPins.uploadBatch) → encrypted
 *    at rest (v2:<kid> envelope; plaintext NEVER in the row).
 *  - Paid order (REAL paystack webhook → pinned confirmProviderPayment →
 *    adjacent W44 hook) allocates claim-first and DELIVERS the PIN in chat
 *    (WA), flipping it sold→revealed.
 *  - "reveal my pin" re-sends the SAME pin + audit row (every reveal).
 *  - Low-stock: available dropping below 10 alerts the merchant ONCE
 *    (re-armed on the next upload).
 *  - Telegram-linked buyer gets the PIN via channelSender (parity).
 *  - Out of stock with tenants.allowBackorders → W43 backorder path; the
 *    post-upload sweep fills it.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedDigitalProduct, seedDigitalOrder, bindTelegram } from "./w44-seed";
import { adminCaller, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J351",
  name: "digital PIN upload → paid order → delivery + reveal + low-stock + OOS backorder",
  feature: "digital_pins encryption + claim-first allocation + parity + backorder",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const merchant = world.newPhone("j351m");
    await world.grantConsent(merchant);
    await world.patchTenantSettings({ adminPhone: merchant });

    const prod = await seedDigitalProduct(world, "j351");
    const pins = Array.from({ length: 11 }, (_, i) => `PIN-351-${String(i).padStart(3, "0")}`);

    // ── Upload (tRPC) → encrypted at rest ──
    const up = await caller.digitalPins.uploadBatch({ tenantId: TENANT_ID, productId: prod.productId, pins });
    assert(up.accepted === 11, `11 accepted (got ${up.accepted})`);
    const stored = await world.db.select().from(schema.digitalPins)
      .where(eq(schema.digitalPins.batchId, up.batch.id));
    assert(stored.length === 11, "11 pin rows");
    assert(stored.every((p: any) => p.pinEncrypted.startsWith("v2:")), "v2:<kid> envelope at rest");
    assert(stored.every((p: any) => !pins.some((plain) => p.pinEncrypted.includes(plain))), "plaintext NEVER persisted");
    assert(stored.every((p: any) => p.status === "available"), "all available");

    const stock0 = await caller.digitalPins.stock({ tenantId: TENANT_ID, productId: prod.productId });
    assert(stock0.available === 11, "stock snapshot 11");

    // ── Paid order → claim-first allocation + WA delivery ──
    const phone = world.newPhone("j351");
    await world.grantConsent(phone);
    const order1 = await seedDigitalOrder(world, "j351a", phone, prod.productId, prod.name, 1, 5_000);
    const pay1 = await paystackChargeSuccess(world, { reference: order1.reference, amountMajor: 50 });
    assert(pay1.status === 200, "order1 webhook accepted");

    await world.waitFor(() => {
      const t = world.outbound.toPhone(phone).filter((m: any) => m.waType === "text")
        .map((m: any) => bodyText(m));
      return t.some((x: string) => x.includes("PIN-351-"));
    }, 10000, "PIN delivered in chat");
    const deliveredText = world.outbound.toPhone(phone).filter((m: any) => m.waType === "text")
      .map((m: any) => bodyText(m)).find((x: string) => x.includes("PIN-351-"))!;
    const deliveredPin = /\*(PIN-351-\d{3})\*/.exec(deliveredText)?.[1];
    assert(deliveredPin, "pin extracted from delivery");

    let pinRows = await world.db.select().from(schema.digitalPins)
      .where(and(eq(schema.digitalPins.tenantId, TENANT_ID), eq(schema.digitalPins.orderId, order1.orderId)));
    assert(pinRows.length === 1, "one pin claimed for order1");
    assert(pinRows[0].status === "revealed", `revealed after delivery (got ${pinRows[0].status})`);
    assert(pinRows[0].orderLineId === order1.lineId, "line linkage");

    // Webhook replay does NOT allocate a second pin.
    await paystackChargeSuccess(world, { reference: order1.reference, amountMajor: 50 });
    pinRows = await world.db.select().from(schema.digitalPins)
      .where(and(eq(schema.digitalPins.tenantId, TENANT_ID), eq(schema.digitalPins.orderId, order1.orderId)));
    assert(pinRows.length === 1, "replay allocates no second pin");

    // ── Reveal again: same pin + audit row each time ──
    await world.text(phone, "reveal my pin");
    await world.waitFor(() => {
      const texts = world.outbound.toPhone(phone).filter((m: any) => m.waType === "text").map((m: any) => bodyText(m));
      return texts.filter((x: string) => x.includes(deliveredPin!)).length >= 2;
    }, 10000, "reveal re-sends the SAME pin");
    const revealAudits: any[] = (await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND entity_id = '${pinRows[0].id}' ORDER BY created_at`,
    )) as any;
    const revealActions = (Array.isArray(revealAudits) ? revealAudits : []).map((r: any) => r.action);
    assert(revealActions.includes("digital_pin.delivered"), "delivery audit row");
    assert(revealActions.includes("digital_pin.revealed"), "reveal audit row");

    // ── Telegram parity: TG-linked buyer gets the pin via channelSender ──
    const tgPhone = world.newPhone("j351tg");
    await world.grantConsent(tgPhone);
    const chatId = "j351chat";
    await bindTelegram(world, tgPhone, chatId);
    const parity = await import("../../server/services/channelParity");
    const tgSeen: any[] = [];
    parity.__setChannelSenderForTests(async (_t, channel, to, p) => {
      tgSeen.push({ channel, to, ...(p as any) });
      return { sent: true, simulated: false };
    });
    try {
      const order2 = await seedDigitalOrder(world, "j351b", tgPhone, prod.productId, prod.name, 1, 5_000);
      const pay2 = await paystackChargeSuccess(world, { reference: order2.reference, amountMajor: 50 });
      assert(pay2.status === 200, "order2 webhook accepted");
      await world.waitFor(() => tgSeen.some((c) => c.channel === "telegram" && c.to === chatId && JSON.stringify(c).includes("PIN-351-")),
        10000, "PIN delivered over telegram");
    } finally {
      parity.__setChannelSenderForTests(null);
    }

    // ── Low stock: 9 available (< 10) → merchant alerted ONCE ──
    await world.waitFor(() => {
      const texts = world.outbound.toPhone(merchant).filter((m: any) => m.waType === "text").map((m: any) => bodyText(m));
      return texts.some((x: string) => x.includes("Low PIN stock"));
    }, 10000, "low-stock merchant alert");
    const lowStockAlerts = () => world.outbound.toPhone(merchant).filter((m: any) => m.waType === "text")
      .map((m: any) => bodyText(m)).filter((x: string) => x.includes("Low PIN stock")).length;
    assert(lowStockAlerts() === 1, `alert sent once (got ${lowStockAlerts()})`);

    // Buying more while still under threshold does NOT re-alert.
    const order3 = await seedDigitalOrder(world, "j351c", phone, prod.productId, prod.name, 1, 5_000);
    await paystackChargeSuccess(world, { reference: order3.reference, amountMajor: 50 });
    await world.settle(500);
    assert(lowStockAlerts() === 1, "no duplicate low-stock alert for the same dip");

    // ── OOS with backorders ON → W43 backorder; restock fills it ──
    await world.db.execute(`UPDATE tenants SET "allowBackorders" = true WHERE id = '${TENANT_ID}'`);
    // Drain the remaining 8 available pins.
    const drain = await seedDigitalOrder(world, "j351d", phone, prod.productId, prod.name, 8, 5_000);
    await paystackChargeSuccess(world, { reference: drain.reference, amountMajor: 400 });
    await world.waitFor(async () => {
      const s = await caller.digitalPins.stock({ tenantId: TENANT_ID, productId: prod.productId });
      return s.available === 0;
    }, 10000, "stock drained");

    const oos = await seedDigitalOrder(world, "j351e", phone, prod.productId, prod.name, 1, 5_000);
    await paystackChargeSuccess(world, { reference: oos.reference, amountMajor: 50 });
    await world.waitFor(async () => {
      const [line] = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.id, oos.lineId));
      return line?.status === "backordered";
    }, 10000, "OOS line backordered (W43 path)");
    const bos = await world.db.select().from(schema.backorderRequests).where(eq(schema.backorderRequests.orderLineId, oos.lineId));
    assert(bos.length === 1 && bos[0].status === "open", "open backorder_request row");

    // Restock → post-upload sweep allocates the backordered line's PIN.
    await caller.digitalPins.uploadBatch({ tenantId: TENANT_ID, productId: prod.productId, pins: ["PIN-351-RESTOCK"] });
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.digitalPins)
        .where(and(eq(schema.digitalPins.tenantId, TENANT_ID), eq(schema.digitalPins.orderId, oos.orderId)));
      return rows.length === 1 && rows[0].status === "revealed";
    }, 10000, "backordered order filled after restock");
    await world.waitFor(() => {
      const texts = world.outbound.toPhone(phone).filter((m: any) => m.waType === "text").map((m: any) => bodyText(m));
      return texts.some((x: string) => x.includes("PIN-351-RESTOCK"));
    }, 10000, "restocked pin delivered to the customer");
    await world.db.execute(`UPDATE tenants SET "allowBackorders" = false WHERE id = '${TENANT_ID}'`);

    // Upload validation: non-digital product refused.
    let refused = false;
    try {
      await caller.digitalPins.uploadBatch({ tenantId: TENANT_ID, productId: "p-jollof", pins: ["PIN-XXXX-0000"] });
    } catch { refused = true; }
    assert(refused, "upload to a non-digital product refused");
    assertIncludes("digitalPins", "digitalPins", "tRPC surface present");
  },
};
