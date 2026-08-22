/**
 * J132 — W27 bookkeeping: expense capture via receipt photo.
 * Merchant texts "expense" → sends a supplier-receipt photo → the shared
 * receipt-vision OCR (scripted via media bytes) parses amount/vendor/date →
 * a pending_confirm record is created and the merchant confirms via
 * "confirm expense". Also covers: stray photos are NOT claimed (no open
 * session) and "cancel expense" discards a pending record.
 */
import { and, desc, eq } from "drizzle-orm";
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

/** Script the expense-receipt vision LLM (decodes mock image bytes). */
function scriptExpenseVision(world: World) {
  // Match ONLY this journey's scripted receipt bytes (base64 of the
  // scriptMedia payload) — earlier journeys register generic "[image:"
  // vision mocks that would otherwise answer first (suite-order safety).
  const needle = Buffer.from("SIMIMG receipt").toString("base64").slice(0, 12);
  world.llm.when(
    (userText) => userText.includes("[image:") && userText.includes(needle),
    (userText) => {
      const m = /\[image:data:[^;]+;base64,([^\]\s]+)/.exec(userText);
      let amount = "0.00";
      let vendor = "UNKNOWN";
      let date = "2026-02-10";
      if (m) {
        const decoded = Buffer.from(m[1], "base64").toString("utf8");
        amount = /amount=([\d.]+)/.exec(decoded)?.[1] ?? amount;
        vendor = /vendor=([^;]+)/.exec(decoded)?.[1] ?? vendor;
        date = /date=([\d-]+)/.exec(decoded)?.[1] ?? date;
      }
      return {
        isReadable: true,
        clarityScore: 95,
        clarityIssues: [],
        documentType: "receipt",
        extractedText: `${vendor} receipt dated ${date} total NGN ${amount}`,
        keyFields: {
          date, amount, orderNumber: "", sellerName: vendor,
          buyerName: "", deliveryAddress: "", trackingNumber: "",
        },
        confidence: 92,
        summary: "Supplier receipt",
      };
    },
  );
}

export const journey: Journey = {
  id: "J132",
  name: "expense receipt photo",
  feature: "W27 bookkeeping expenses",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    // Suite-order safety: earlier stock-take journeys (J85/J106) may leave
    // visualInventoryWhatsAppEnabled on, which claims inbound images BEFORE
    // the expense hook. Force it off for this journey.
    await world.patchTenantSettings({ visualInventoryWhatsAppEnabled: false });
    const merchant = world.newPhone("merchant");
    await world.grantConsent(merchant);

    // ── Stray photo with no open session is NOT claimed ──────────────────
    scriptMedia("m-stray", "SIMIMG receipt amount=500.00;vendor=Stray Shop;date=2026-02-09");
    await world.image(merchant, "m-stray");
    const strayRows = await world.db.select().from(schema.expenses)
      .where(eq(schema.expenses.tenantId, TENANT_ID));
    assert(strayRows.length === 0, "stray photo creates no expense");

    // ── Open a capture session ───────────────────────────────────────────
    await world.text(merchant, "expense");
    const prompt = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(prompt, "photo of the supplier receipt", "capture prompt sent");

    // ── Photo the receipt → OCR → pending_confirm ────────────────────────
    scriptExpenseVision(world);
    scriptMedia("m-exp-1", "SIMIMG receipt amount=15000.50;vendor=Chidi Supplies;date=2026-02-10");
    await world.image(merchant, "m-exp-1");
    await world.waitFor(async () => {
      const [row] = await world.db.select().from(schema.expenses)
        .where(and(eq(schema.expenses.tenantId, TENANT_ID), eq(schema.expenses.status, "pending_confirm")))
        .orderBy(desc(schema.expenses.createdAt)).limit(1);
      return !!row;
    }, 15000, "expense pending_confirm after OCR");

    const confirmPrompt = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(confirmPrompt, "Expense captured", "OCR result quoted back");
    assertIncludes(confirmPrompt, "₦15,000.50", "exact amount with kobo");
    assertIncludes(confirmPrompt, "Chidi Supplies", "vendor quoted");
    assertIncludes(confirmPrompt, "2026-02-10", "date quoted");

    // ── Confirm flow ─────────────────────────────────────────────────────
    await world.text(merchant, "confirm expense");
    const confirmed = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(confirmed, "Expense confirmed", "confirmation reply");
    const [row] = await world.db.select().from(schema.expenses)
      .where(eq(schema.expenses.tenantId, TENANT_ID)).limit(1);
    assert(row.status === "confirmed", `expense confirmed (got ${row.status})`);
    assert(row.amountCents === 1500050, `integer cents stored (got ${row.amountCents})`);
    assert(row.vendor === "Chidi Supplies", "vendor stored");
    assert(row.source === "receipt_photo", "source recorded");
    assert(row.expenseDate.toISOString().slice(0, 10) === "2026-02-10", "OCR date stored");

    // ── Cancel flow discards a pending capture ───────────────────────────
    await world.text(merchant, "expense");
    scriptMedia("m-exp-2", "SIMIMG receipt amount=200.00;vendor=Kola Kiosk;date=2026-02-11");
    await world.image(merchant, "m-exp-2");
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.expenses)
        .where(and(eq(schema.expenses.tenantId, TENANT_ID), eq(schema.expenses.status, "pending_confirm")));
      return rows.length === 1;
    }, 15000, "second capture pending_confirm");
    await world.text(merchant, "cancel expense");
    const cancelReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(cancelReply, "discarded", "cancel acknowledged");
    const [rejected] = await world.db.select().from(schema.expenses)
      .where(and(eq(schema.expenses.tenantId, TENANT_ID), eq(schema.expenses.status, "rejected"))).limit(1);
    assert(rejected.vendor === "Kola Kiosk", "cancelled capture marked rejected");
  },
};
