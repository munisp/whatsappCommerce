/**
 * === W37 telegram (Coder C) ===
 * J246 — Parity matrix snapshot: the channelParity category registry covers
 * ALL 15 categories from the scout's checklist (SPEC_W37 Coder C §1), each
 * with an honest telegram support level and notes; any "wa-only" category
 * must carry a written justification.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

/** The binding 15-category checklist (SPEC_W37 Coder C §1 order). */
const EXPECTED_CATEGORY_IDS = [
  "order_status",
  "payment_receipt",
  "payment_link",
  "delivery_pin",
  "po_approval",
  "cart_abandonment",
  "broadcast",
  "dunning",
  "escalation",
  "finance_qa",
  "ops_alert",
  "annual_statement",
  "installment_receipt",
  "refund",
  "delivery_status",
  // === W43 fulfillment (Coder A): additive categories (SPEC_W43 requires
  // every customer-facing notification category to be registered) ==========
  "partial_fulfillment",
  "backorder_filled",
  // === END W43 fulfillment ===
];

export const journey: Journey = {
  id: "J246",
  name: "parity matrix: registry covers all 15 checklist categories",
  feature: "W37 caller parity: PARITY_CATEGORIES registry snapshot",
  async run(_world: World) {
    const parity = await import("../../server/services/channelParity");

    // 1. Coverage — all 15 checklist categories present, no duplicates.
    // === W43 exchanges (Coder B): the registry is now ADDITIVE — later waves
    // append categories (e.g. W43 'exchange_status', 'backorder_filled'), so
    // the binding assertion is "checklist ⊆ registry", not exact equality. ===
    const ids = new Set(parity.PARITY_CATEGORY_IDS);
    for (const required of EXPECTED_CATEGORY_IDS) {
      assert(ids.has(required), `registry missing checklist category: ${required}`);
    }
    assert(parity.PARITY_CATEGORIES.length >= 15, `expected at least 15 categories, got ${parity.PARITY_CATEGORIES.length}`);
    assert(ids.size === parity.PARITY_CATEGORY_IDS.length, "duplicate category ids");
    // === END W43 exchanges ===

    // 2. Every entry is honest: description + notes + valid support level;
    //    wa-only MUST be justified in notes.
    for (const c of parity.PARITY_CATEGORIES) {
      assert(c.description.length > 10, `${c.id}: description missing`);
      assert(["full", "adapter", "wa-only"].includes(c.telegram), `${c.id}: invalid telegram level ${c.telegram}`);
      assert(c.notes.length > 20, `${c.id}: notes missing`);
      if (c.telegram === "wa-only") {
        assert(/gap|specific|only|never/i.test(c.notes), `${c.id}: wa-only without written justification`);
      }
    }

    // 3. Known documented gaps stay documented.
    const delivery = parity.getParityCategory("delivery_status");
    assert(delivery!.notes.includes("GAP"), "delivery_status must document the no-read-receipts telegram gap");
    const payLink = parity.getParityCategory("payment_link");
    assert(payLink!.telegram === "adapter" && payLink!.notes.includes("wa.me"), "payment_link adapter must explain the wa.me replacement");

    // 4. Adapters exist and behave for every category (no throw, WA = identity).
    for (const c of parity.PARITY_CATEGORIES) {
      const p = { text: "probe", notifType: c.id };
      assert(parity.adaptForChannel(c.id, "whatsapp", p) === p, `${c.id}: WA adaptation must be identity`);
      const tg = parity.adaptForChannel(c.id, "telegram", p);
      assert(typeof tg.text === "string", `${c.id}: telegram adaptation must keep text`);
    }
  },
};
