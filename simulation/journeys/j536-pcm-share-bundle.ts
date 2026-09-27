// === W52 SHARE ===
/**
 * J536 — pcm locale share bundle: the MESSAGE_CATALOG pcm pack drives the
 * share blurb / bundle message / forward line / button label, and the
 * DEAL/REF redemption replies are catalog-backed for every locale.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J536",
  name: "pcm locale share bundle rendering + catalog completeness",
  feature: "W52 share: i18n pcm",
  async run(_world: World) {
    const { buildDealShareBundle, renderShareBundleMessage } = await import("../../server/services/shareDeal");
    const { t27, MESSAGE_CATALOG } = await import("../../server/services/i18n");

    const promo = { kind: "promo" as const, title: "Promo PCM36", discountText: "36% off", code: "PCM36" };
    const bundle = buildDealShareBundle({
      settings: { whatsapp: { displayPhone: "2349000000536" } },
      promo, referralCode: "REF-PCM36A", locale: "pcm",
    });
    assert(bundle, "pcm bundle built");
    assert(bundle!.blurb.includes("for our shop"), `pcm blurb from the catalog (got ${bundle!.blurb})`);
    assert(bundle!.blurb.includes("PCM36") && bundle!.blurb.includes("REF-PCM36A"), "blurb carries both codes");
    assert(bundle!.forwardText.startsWith("Forward am:"), `pcm forward line (got ${bundle!.forwardText})`);
    const msg = renderShareBundleMessage("pcm", bundle!);
    assert(msg.includes("Share dis deal give your padi dem"), `pcm bundle message (got ${msg.slice(0, 120)})`);
    assert(msg.includes(bundle!.waShareUrl) && msg.includes(bundle!.tgShareUrl), "bundle message carries both share URLs");
    assert(t27("pcm", "shareButtonLabel").includes("Share am"), "pcm share button label");

    // Every locale carries the full W52 share key set (no silent en fallback).
    const keys = [
      "shareDealBlurb", "shareDealForward", "shareDealBundleMessage",
      "shareButtonLabel", "shareDealRedeemed", "shareDealSelfReferral", "shareDealBadPromo",
    ] as const;
    for (const locale of Object.keys(MESSAGE_CATALOG)) {
      const pack = (MESSAGE_CATALOG as any)[locale];
      for (const k of keys) {
        assert(typeof pack[k] === "string" && pack[k].length > 0, `${locale}.${k} present`);
      }
    }
  },
};
