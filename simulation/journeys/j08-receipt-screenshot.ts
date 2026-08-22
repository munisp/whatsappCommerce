/**
 * J8 — Receipt screenshot (Wave 26 audit F2): an OCR receipt scan NEVER
 * auto-confirms a payment — attacker-controlled pixels are not money
 * movement. A matching receipt is flagged receiptReview (reason
 * amount-match-awaiting-human-review) and the buyer is told a human will
 * confirm; a mismatch (tolerance now ZERO — 2575 ≠ 2500) is flagged
 * amount-mismatch with the scanned amount quoted. Vision LLM is scripted
 * via the media bytes.
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
      return (o?.metadata as any)?.receiptReview === true;
    }, 15000, "order A flagged receiptReview by matching receipt");
    const [oA] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderA.orderId)).limit(1);
    // F2: OCR alone must NEVER confirm — the order stays pending/unpaid.
    assert(oA.status === "pending", `matching receipt does NOT auto-confirm (got ${oA.status})`);
    assert(oA.paymentStatus !== "completed", "matching receipt not marked paid");
    assert((oA.metadata as any)?.receiptReviewReason === "amount-match-awaiting-human-review",
      "review reason records the exact-match human-review queue");
    const replyA = bodyText(world.outbound.lastOfType("text", phoneA));
    assertIncludes(replyA, "matches the expected amount", "buyer told the amount matched");
    assertIncludes(replyA, "final confirmation", "buyer told a human confirms");

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

    // ── Near-miss receipt (₦2,575 vs ₦2,500): tolerance is now ZERO, so
    // this is a MISMATCH → manual review, never confirmed ─────────────────
    const phoneC = world.newPhone("c");
    await world.grantConsent(phoneC);
    const orderC = await createChatOrderViaNlp(world, phoneC, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    scriptMedia("m-receipt-close", "SIMIMG receipt amount=2575.00");
    await world.image(phoneC, "m-receipt-close");
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderC.orderId)).limit(1);
      return (o?.metadata as any)?.receiptReview === true;
    }, 15000, "order C flagged receiptReview (zero tolerance)");
    const [oC] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderC.orderId)).limit(1);
    assert(oC.status === "pending", `near-miss order stays pending (got ${oC.status})`);
    assert((oC.metadata as any)?.receiptReviewReason === "amount-mismatch",
      "zero tolerance: ₦75 off is a mismatch");
    const replyC = bodyText(world.outbound.lastOfType("text", phoneC));
    assertIncludes(replyC, "manual review", "buyer told near-miss is under manual review");
  },
};
