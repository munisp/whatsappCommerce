/**
 * J32 — PO build + submit: two line items through the chat flow → review
 * card (lines, subtotal) → credit payment choice → terms pick → CONFIRM →
 * PO row lands 'submitted'; the supplier's admin phone receives the
 * interactive approval card with po_number, buyer name, ₦ subtotal and terms.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_ADMIN_PHONE } from "../world";
import { buildProcurementPoViaChat, enableProcurementMenu, restoreMenu } from "./helpers";

export const journey: Journey = {
  id: "J32",
  name: "PO build + submit",
  feature: "poFlow chat → submitted PO + supplier approval card",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const before = await enableProcurementMenu(world);

    const po = await buildProcurementPoViaChat(world, phone, { paymentMode: "credit", termsPick: 2 });

    // ── PO row state ──────────────────────────────────────────────────────
    assert(po.subtotalCents === 2_900_000, `subtotal ₦29,000 in cents (got ${po.subtotalCents})`);
    assert(po.paymentMode === "credit", `payment mode credit (got ${po.paymentMode})`);
    assert(po.termsDays === 14, `terms net-14 picked from [7,14,30] (got ${po.termsDays})`);
    assert(po.poNumber.startsWith("PO-"), `human PO number (got ${po.poNumber})`);

    // ── Line items persisted ──────────────────────────────────────────────
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const items = await world.db.select().from(schema.poItems).where(eq(schema.poItems.poId, po.poId));
    assert(items.length === 2, `two PO line items (got ${items.length})`);
    const preforms = items.find((i: any) => i.name === "PET Preforms 500ml");
    const crates = items.find((i: any) => i.name === "Plastic Crates 20L");
    assert(preforms && preforms.qty === 100 && Number(preforms.unitPriceCents) === 4000, "preform line 100 × ₦40");
    assert(crates && crates.qty === 10 && Number(crates.unitPriceCents) === 250_000, "crate line 10 × ₦2,500");

    // ── Buyer confirmation message ────────────────────────────────────────
    const buyerReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(buyerReply, po.poNumber, "buyer told the PO number");
    assertIncludes(buyerReply, "submitted to Lagos Plastics Manufacturing", "buyer told the supplier");
    assertIncludes(buyerReply, "₦29,000.00", "buyer told the subtotal");
    assertIncludes(buyerReply, "net 14d", "buyer told the terms");

    // ── Supplier admin approval card ──────────────────────────────────────
    const card = world.outbound.lastOfType("interactive", SUPPLIER_ADMIN_PHONE);
    assert(card, "supplier admin received the approval card");
    const cardSerialized = JSON.stringify(card.body?.interactive ?? {});
    assertIncludes(cardSerialized, po.poNumber, "card carries the PO number");
    assertIncludes(cardSerialized, "Sim Store", "card names the buyer tenant");
    assertIncludes(cardSerialized, "₦29,000.00", "card shows the ₦ subtotal");
    assertIncludes(cardSerialized, "net 14d", "card shows credit terms");
    assertIncludes(cardSerialized, `po_approve:${po.poId}`, "card approve button id");
    assertIncludes(cardSerialized, `po_reject:${po.poId}`, "card reject button id");

    await restoreMenu(world, before);
  },
};
