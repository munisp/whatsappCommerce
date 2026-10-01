// === W55 parity (PARITY-7) ===
/**
 * J565 — i18n completeness: ig/am `paymentPending` render their own
 * translations (not the English fallback), and the USSD_MENUS browse +
 * checkout_address states render in fr/sw/am through the REAL
 * nlp.processMessage ussdMode path (session-locale pinned — the J559 seam).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J565",
  name: "ig/am paymentPending + fr/sw/am USSD browse/checkout_address",
  feature: "W55 parity: i18n completeness (PARITY-7)",
  async run(world: World) {
    const i18n = await import("../../server/services/i18n");
    const { appRouter } = await import("../../server/routers");
    const { nlpSessions } = await import("../../drizzle/schema");
    const caller = appRouter.createCaller({ user: null } as any);

    // ── 1. paymentPending translated in ig + am (catalog level) ─────────
    assert(i18n.t27("ig", "paymentPending") === i18n.MESSAGE_CATALOG.ig.paymentPending,
      "ig paymentPending renders the Igbo pack string");
    assert(i18n.t27("am", "paymentPending") === i18n.MESSAGE_CATALOG.am.paymentPending,
      "am paymentPending renders the Amharic pack string");
    assert(i18n.t27("ig", "paymentPending") !== i18n.MESSAGE_CATALOG.en.paymentPending,
      "ig paymentPending is NOT the English fallback");
    assert(i18n.t27("am", "paymentPending") !== i18n.MESSAGE_CATALOG.en.paymentPending,
      "am paymentPending is NOT the English fallback");
    assert(i18n.t27("ig", "paymentPending").length > 10 && i18n.t27("am", "paymentPending").length > 10,
      "translations are non-trivial");
    // Full catalog completeness: every locale now has every key.
    const keys = Object.keys(i18n.MESSAGE_CATALOG.en);
    for (const loc of i18n.SUPPORTED_LOCALES) {
      const missing = keys.filter((k) => typeof (i18n.MESSAGE_CATALOG as any)[loc]?.[k] !== "string");
      assert(missing.length === 0, `${loc} catalog complete (${missing.length} missing: ${missing.slice(0, 3).join(",")})`);
    }

    // ── 2. USSD browse + checkout_address states in fr/sw/am ────────────
    const pinAndAsk = async (tag: string, sessionLanguage: string, state: string, message: string) => {
      const phone = world.newPhone(tag);
      const first = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone, message: "hi", ussdMode: true,
      });
      await world.db.update(nlpSessions)
        .set({ language: sessionLanguage, state })
        .where(eq(nlpSessions.id, first.sessionId));
      return caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone, message, ussdMode: true,
      });
    };

    const frBrowse = await pinAndAsk("565a", "french", "browse", "zzz");
    assert(String(frBrowse.reply).startsWith("Menu produits"),
      `fr browse state (got ${String(frBrowse.reply).slice(0, 80)})`);
    assert(String(frBrowse.reply).includes("Rechercher par nom"), "fr browse options localized");

    const swBrowse = await pinAndAsk("565b", "swahili", "browse", "zzz");
    assert(String(swBrowse.reply).startsWith("Menyu ya bidhaa"),
      `sw browse state (got ${String(swBrowse.reply).slice(0, 80)})`);

    const amBrowse = await pinAndAsk("565c", "amharic", "browse", "zzz");
    assert(String(amBrowse.reply).startsWith("የምርቶች ምናሌ"),
      `am browse state (got ${String(amBrowse.reply).slice(0, 80)})`);

    const frCheckout = await pinAndAsk("565d", "french", "checkout_address", "zzz");
    assert(String(frCheckout.reply).startsWith("Paiement"),
      `fr checkout_address state (got ${String(frCheckout.reply).slice(0, 80)})`);
    assert(String(frCheckout.reply).includes("adresse de livraison"), "fr checkout options localized");

    const swCheckout = await pinAndAsk("565e", "swahili", "checkout_address", "zzz");
    assert(String(swCheckout.reply).startsWith("Malipo"),
      `sw checkout_address state (got ${String(swCheckout.reply).slice(0, 80)})`);

    const amCheckout = await pinAndAsk("565f", "amharic", "checkout_address", "zzz");
    assert(String(amCheckout.reply).startsWith("ክፍያ"),
      `am checkout_address state (got ${String(amCheckout.reply).slice(0, 80)})`);

    // English control unchanged.
    const enBrowse = await pinAndAsk("565g", "english", "browse", "zzz");
    assert(String(enBrowse.reply).startsWith("Products menu"), "en browse unchanged");
  },
};
