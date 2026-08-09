/**
 * J8 — Receipt screenshot: image inbound matching a pending order ±₦100 →
 * auto-confirmed through paymentConfirm; mismatch → manual review reply,
 * order NOT confirmed. Vision LLM is scripted via the media bytes.
 */
import { eq } from "drizzle-orm";
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

/** Script the receipt-scan LLM: decode the (mock) image bytes out of the data URL. */
function scriptReceiptVision(world: World) {
  world.llm.when(
    (userText) => userText.includes("[image:"),
    (userText) => {
      const m = /\[image:data:[^;]+;base64,([^\]\s]+)/.exec(userText);
      let amount = "0.00";
      if (m) {
        const decoded = Buffer.from(m[1], "base64").toString("utf8");
        const a = /amount=([\d.]+)/.exec(decoded);
        if (a) amount = a[1];
      }
      return {
        receiptType: "bank_transfer_receipt",
        summary: "Simulated receipt scan",
        confidence: 0.96,
        keyFields: { amount, currency: "NGN", sender: "SIM USER", reference: "SIM-TRF-1" },
        extractedText: `Paid ${amount}`,
      };
    },
  );
}

export const journey: Journey = {
  id: "J08",
  name: "receipt screenshot verify",
  feature: "receiptVerification ±₦100",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // ── Matching receipt → auto-confirm ──────────────────────────────────
    const phoneA = world.newPhone("a");
    await world.grantConsent(phoneA);
    const orderA = await createChatOrderViaNlp(world, phoneA, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    assert(orderA.total === 2500, "order A total 2500");

    scriptReceiptVision(world);
    scriptMedia("m-receipt-ok", "SIMIMG receipt amount=2500.00");
    await world.image(phoneA, "m-receipt-ok");

    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderA.orderId)).limit(1);
      return o?.status === "confirmed";
    }, 15000, "order A auto-confirmed by matching receipt");
    const replyA = bodyText(world.outbound.lastOfType("text", phoneA));
    assert(replyA.includes("Payment received") || replyA.includes("confirmed"), "buyer told payment was received");

    // ── Mismatched receipt → manual review, NOT confirmed ────────────────
    const phoneB = world.newPhone("b");
    await world.grantConsent(phoneB);
    const orderB = await createChatOrderViaNlp(world, phoneB, { items: [{ product: "Jollof Rice", quantity: 1 }] });

    scriptMedia("m-receipt-bad", "SIMIMG receipt amount=999.00");
    await world.image(phoneB, "m-receipt-bad");
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderB.orderId)).limit(1);
      return (o?.metadata as any)?.receiptReview === true;
    }, 15000, "order B flagged for manual review");

    const [oB] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderB.orderId)).limit(1);
    assert(oB.status === "pending", `mismatched order stays pending (got ${oB.status})`);
    assert(oB.paymentStatus !== "completed", "mismatched order not paid");
    const replyB = bodyText(world.outbound.lastOfType("text", phoneB));
    assertIncludes(replyB, "manual review", "buyer told receipt is under manual review");
    assertIncludes(replyB, "999", "mismatch reply quotes the scanned amount");

    // ── Within-tolerance receipt (±₦100) also confirms ───────────────────
    const phoneC = world.newPhone("c");
    await world.grantConsent(phoneC);
    const orderC = await createChatOrderViaNlp(world, phoneC, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    scriptMedia("m-receipt-close", "SIMIMG receipt amount=2575.00");
    await world.image(phoneC, "m-receipt-close");
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderC.orderId)).limit(1);
      return o?.status === "confirmed";
    }, 15000, "order C confirmed within ±₦100 tolerance");
  },
};
