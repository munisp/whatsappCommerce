// === W52 SHARE ===
/**
 * J531 — share button tap on the WA promo card → bundle message.
 *
 *   1. Tenant with an active promo + public WA phone: an inquiry turn sends
 *      the promo spotlight card whose buttons (3-button cap) are
 *      [Shop now][View deal][📤 Share] — the Popular-items button yields.
 *   2. Tapping 📤 Share (promo_share:SHARE31) mints the sharer's referral
 *      code and replies with the bundle message carrying the wa.me share URL
 *      (text = blurb + ctwaLink with the DEAL/REF prefilled grammar).
 *   3. Settings restored afterwards.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J531",
  name: "WA promo card share tap → bundle with wa.me share URL",
  feature: "W52 share: share button + bundle",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const before = await world.tenantSettings();
    const phone = world.newPhone("1");
    try {
      await world.patchTenantSettings({
        promos: [{ code: "SHARE31", type: "percent", value: 25 }],
        whatsapp: { ...(before as any)?.whatsapp, displayPhone: "2349000000531" },
      });
      await world.grantConsent(phone);
      world.llm.when(/shoes/i, {
        reply: "Yes — we have shoes in stock.",
        intent: "search", nextState: "product_detail",
        extractedItems: [], extractedProduct: null,
        extractedQuantity: null, extractedAddress: null, confidence: 0.9,
      });

      await world.text(phone, "do you have shoes?");
      const cards = world.outbound.ofType("interactive", phone)
        .map((c) => (c.body as any).interactive);
      const promo = cards.find((i) =>
        JSON.stringify(i?.action?.buttons ?? {}).includes("promo_deal:SHARE31"));
      assert(promo, `promo spotlight card sent (got ${JSON.stringify(cards.map((c) => c?.body?.text))})`);
      const ids = promo.action.buttons.map((b: any) => b.reply.id);
      assert(ids.includes("promo_share:SHARE31"), `share button on the card (got ${ids})`);
      assert(ids.includes("promo_shop") && ids.includes("promo_deal:SHARE31"), "shop + deal buttons kept");
      assert(ids.length <= 3, `within the WA 3-button cap (got ${ids.length})`);

      // Tap 📤 Share → bundle message with the wa.me share URL.
      world.outbound.reset();
      await world.buttonReply(phone, "promo_share:SHARE31", "📤 Share");
      const texts = world.outbound.ofType("text", phone).map((c) => String((c.body as any)?.text?.body ?? (c.body as any)?.text ?? ""));
      const bundle = texts.find((t) => t.includes("https://wa.me/?text="));
      assert(bundle, `bundle message with wa.me share URL (got ${JSON.stringify(texts)})`);
      // Decode only the share URL token (the blurb's bare "%" breaks a
      // whole-message decodeURIComponent).
      const shareUrl = /https:\/\/wa\.me\/\?text=\S+/.exec(bundle!)?.[0] ?? "";
      assert(shareUrl, "wa.me share URL token extracted");
      const decoded = decodeURIComponent(shareUrl.slice("https://wa.me/?text=".length));
      const inner = /https:\/\/wa\.me\/2349000000531\?text=\S+/.exec(decoded)?.[0] ?? "";
      assert(inner, `share text carries the merchant ctwa link (got ${decoded.slice(0, 200)})`);
      assert(decodeURIComponent(inner).includes("DEAL SHARE31 REF"), `prefilled DEAL/REF grammar (got ${inner})`);
      assert(bundle!.includes("Telegram: https://t.me/share/url?url="), "TG share URL present");
      assert(bundle!.includes("Forward:"), "forward text present");

      // Referral code minted for the sharer.
      const rows = await world.db.select().from(schema.referralCodes);
      const mine = rows.filter((r: any) => r.customerId === phone && r.tenantId === TENANT_ID);
      assert(mine.length === 1, `referral code minted for the sharer (got ${mine.length})`);
      assert(bundle!.includes(mine[0].code), "bundle carries the sharer's referral code");

      // Share tap counted on the agent_events rail.
      const taps = (await world.db.select().from(schema.agentEvents))
        .filter((e: any) => e.eventType === "promo_share_tap" && e.intentType === "SHARE31");
      assert(taps.length === 1, `share tap analytics row (got ${taps.length})`);
    } finally {
      world.llm.reset();
      await world.patchTenantSettings({
        promos: (before as any)?.promos ?? [],
        whatsapp: (before as any)?.whatsapp ?? {},
      });
    }
  },
};
