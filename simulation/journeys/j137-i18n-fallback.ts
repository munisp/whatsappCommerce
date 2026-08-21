/**
 * J137 — W27 multi-language framework: fallback to English for missing keys.
 *
 *   1. Catalog seam: keys intentionally untranslated in a locale (Igbo and
 *      Amharic `paymentPending`) render the English template; translated
 *      keys render the locale string; {vars} interpolate in both paths.
 *   2. Unknown/unsupported locale codes resolve to English wholesale.
 *   3. Tenant overrides win over the locale pack (durable
 *      tenant_i18n_overrides row via the i18n router), and removing the
 *      override restores the pack translation.
 *   4. Tenant default locale: i18n.setTenantLocale persists to
 *      tenants.settings.locale — the key resolveLocale already consults —
 *      and resolveLocale picks it up when no per-customer preference exists.
 *   5. Legacy pack seam (tr): every locale has all LocalePack keys; a
 *      garbage locale falls back to English.
 */
import { assert } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J137",
  name: "i18n fallback to en for missing keys",
  feature: "locale→en catalog fallback, tenant overrides, tenant default locale resolution",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const i18n = await import("../../server/services/i18n");

    // ── 1. Catalog fallback chain ────────────────────────────────────────
    assert(
      i18n.t27("ig", "paymentPending") === i18n.MESSAGE_CATALOG.en.paymentPending,
      "missing Igbo key falls back to English",
    );
    assert(
      i18n.t27("am", "paymentPending") === i18n.MESSAGE_CATALOG.en.paymentPending,
      "missing Amharic key falls back to English",
    );
    const haPay = i18n.t27("ha", "paymentPrompt", { total: "5,000", currency: "NGN" });
    assert(haPay.includes("5,000") && haPay.includes("NGN"), "vars interpolate in the translated template");
    assert(haPay !== i18n.t27("en", "paymentPrompt", { total: "5,000", currency: "NGN" }),
      "translated key renders the locale string, not English");
    assert(
      i18n.t27("en", "orderPlaced", { orderNumber: "A1", total: "100", currency: "NGN" }).includes("A1"),
      "English template interpolates",
    );

    // ── 2. Unknown locale → English wholesale ────────────────────────────
    assert(i18n.t27("zz", "cartEmpty") === i18n.MESSAGE_CATALOG.en.cartEmpty, "unknown locale → en");
    assert(i18n.t27(undefined, "cartEmpty") === i18n.MESSAGE_CATALOG.en.cartEmpty, "undefined locale → en");
    assert(i18n.isLocale("pcm") === false && i18n.isLocale("sw") === true, "isLocale covers the 7 locales");
    assert(i18n.localeFromSessionLanguage("swahili") === "sw", "session language name → sw");
    assert(i18n.localeFromSessionLanguage("amharic") === "am", "session language name → am");

    // ── 3. Tenant overrides win over the pack ────────────────────────────
    const admin = await adminCaller();
    const tenantId = (await admin.onboarding.start({ name: "J137 Override Shop" })).tenantId;
    const caller = await tenantCaller(tenantId, { userId: 1371 });
    await caller.i18n.setOverride({
      locale: "ha", key: "cartEmpty", text: "Kwandonka babu komai a cikinsa (custom).",
    });
    const rows = await world.db.select().from(schema.tenantI18nOverrides);
    const mine = rows.filter((r) => r.tenantId === tenantId);
    assert(mine.length === 1 && mine[0].key === "cartEmpty", "override row persisted");
    const overridden = i18n.t27("ha", "cartEmpty", {}, { cartEmpty: mine[0].text });
    assert(overridden === "Kwandonka babu komai a cikinsa (custom).", "tenant override beats the ha pack");
    await caller.i18n.removeOverride({ locale: "ha", key: "cartEmpty" });
    const after = await world.db.select().from(schema.tenantI18nOverrides);
    assert(after.filter((r) => r.tenantId === tenantId).length === 0, "override removed → pack fallback resumes");
    assert(i18n.t27("ha", "cartEmpty") === i18n.MESSAGE_CATALOG.ha.cartEmpty, "ha pack string after removal");

    // ── 4. Tenant default locale resolution ──────────────────────────────
    i18n.__clearMemoryLocales();
    await caller.i18n.setTenantLocale({ locale: "yo" });
    const [tenant] = await world.db.select().from(schema.tenants)
      .where((await import("drizzle-orm")).eq(schema.tenants.id, tenantId)).limit(1);
    assert((tenant.settings as any)?.locale === "yo", "tenant default persisted to settings.locale");
    const resolved = await i18n.resolveLocale({
      tenantId, phone: "+23400137000", tenantSettings: tenant.settings as any,
    });
    assert(resolved === "yo", `resolveLocale falls through to tenant default (got ${resolved})`);

    // ── 5. Legacy pack seam stays complete ───────────────────────────────
    for (const loc of i18n.SUPPORTED_LOCALES) {
      assert(typeof i18n.tr(loc, "greeting") === "string" && i18n.tr(loc, "greeting").length > 0,
        `${loc} greeting present`);
      assert(i18n.tr(loc, "consentPrompt").length > 10, `${loc} consent prompt present`);
    }
    assert(i18n.tr("klingon", "tracking") === i18n.LOCALE_PACKS.en.tracking, "tr garbage locale → en");
  },
};
