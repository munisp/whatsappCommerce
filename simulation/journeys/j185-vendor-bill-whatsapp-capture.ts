/**
 * J185 — W31 vendor-bills (Coder A): WhatsApp capture. The merchant forwards
 * a supplier invoice image with a "bill ..." caption → the shared
 * receipt-vision OCR extracts vendor/amount/date → a vendor_bills row with
 * capture_source='whatsapp' + a confirmation reply quoting the fields. An
 * image WITHOUT a bill caption is not claimed by this path.
 */
import { and, desc, eq } from "drizzle-orm";
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

/** Script the vision LLM for this journey's scripted invoice bytes. */
function scriptBillVision(world: World) {
  const needle = Buffer.from("SIMIMG vbill").toString("base64").slice(0, 12);
  world.llm.when(
    (userText) => userText.includes("[image:") && userText.includes(needle),
    (userText) => {
      const m = /\[image:data:[^;]+;base64,([^\]\s]+)/.exec(userText);
      let amount = "0.00";
      let vendor = "UNKNOWN";
      let date = "2026-03-01";
      if (m) {
        const decoded = Buffer.from(m[1], "base64").toString("utf8");
        amount = /amount=([\d.]+)/.exec(decoded)?.[1] ?? amount;
        vendor = /vendor=([^;]+)/.exec(decoded)?.[1] ?? vendor;
        date = /date=([\d-]+)/.exec(decoded)?.[1] ?? date;
      }
      return {
        isReadable: true,
        clarityScore: 90,
        clarityIssues: [],
        documentType: "invoice",
        extractedText: `${vendor} invoice dated ${date} total NGN ${amount}`,
        keyFields: {
          date, amount, invoiceNumber: "INV-185", sellerName: vendor,
        },
        confidence: 90,
        summary: "Supplier invoice",
      };
    },
  );
}

export const journey: Journey = {
  id: "J185",
  name: "whatsapp bill capture",
  feature: "W31 vendor-bills AP inbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    // Earlier journeys may leave visual stocktake enabled; it claims images
    // BEFORE the vendor-bill hook, so force it off (mirrors J132).
    await world.patchTenantSettings({ visualInventoryWhatsAppEnabled: false });
    const merchant = world.newPhone("merchant");
    await world.grantConsent(merchant);

    // ── Image WITHOUT a bill caption is NOT claimed by the bill path ────
    scriptMedia("m-vb-stray", "SIMIMG vbill amount=999.00;vendor=Stray Co;date=2026-03-01");
    await world.image(merchant, "m-vb-stray", "look at this");
    const stray = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.tenantId, TENANT_ID));
    assert(stray.length === 0, "no bill without a bill caption");

    // ── Forward a supplier invoice with a "bill" caption ────────────────
    scriptBillVision(world);
    scriptMedia("m-vb-185", "SIMIMG vbill amount=45000.00;vendor=Adaeze Wholesale;date=2026-03-01");
    await world.image(merchant, "m-vb-185", "bill from Adaeze");
    await world.waitFor(async () => {
      const [row] = await world.db.select().from(schema.vendorBills)
        .where(eq(schema.vendorBills.tenantId, TENANT_ID))
        .orderBy(desc(schema.vendorBills.createdAt)).limit(1);
      return !!row;
    }, 15000, "vendor bill created from whatsapp forward");

    const [bill] = await world.db.select().from(schema.vendorBills)
      .where(and(eq(schema.vendorBills.tenantId, TENANT_ID)))
      .orderBy(desc(schema.vendorBills.createdAt)).limit(1);
    assert(bill.captureSource === "whatsapp", `capture_source whatsapp (got ${bill.captureSource})`);
    assert(bill.vendorName === "Adaeze Wholesale", `OCR vendor (got ${bill.vendorName})`);
    assert(bill.amountCents === 4500000, `integer cents (got ${bill.amountCents})`);
    assert(bill.billNumber === "INV-185", `OCR invoice number (got ${bill.billNumber})`);
    assert(bill.status === "pending", `bill pending (got ${bill.status})`);
    assert(bill.ocrConfidence != null && parseFloat(String(bill.ocrConfidence)) >= 60, "ocr confidence stored");
    assert((bill.ocrRaw as any)?.keyFields?.sellerName === "Adaeze Wholesale", "ocr raw key fields stored");

    // ── Confirmation reply quotes the extracted fields ──────────────────
    const reply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(reply, "Vendor bill captured", "confirmation reply");
    assertIncludes(reply, "Adaeze Wholesale", "vendor quoted");
    assertIncludes(reply, "₦45,000", "exact amount quoted");

    // Audit event recorded.
    const events = await world.db.select().from(schema.vendorBillEvents)
      .where(eq(schema.vendorBillEvents.billId, bill.id));
    assert(events.some((e: any) => e.event === "captured"), "captured audit event");
  },
};
