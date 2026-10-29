/**
 * J609 — shared platform WhatsApp number (W50 phase 2).
 *
 * One platform number serves many shops. A customer messaging it:
 *   - types a shop's slug/name  → enters that shop (active-shop pointer set)
 *   - then chats                 → routed to THAT shop's bot, replies going out
 *                                  via the platform number's own creds
 *   - "home"                     → leaves the shop, back to the directory
 *   - unrecognized text          → directory prompt (product→nearest-shops is
 *                                  phase 3)
 * Shops that bring their OWN number (BYO) are unaffected. Gated by
 * WHATSAPP_PLATFORM_NUMBER_ID (set here for the journey only, so other journeys
 * stay inert).
 */
import { eq } from "drizzle-orm";
import { assert, bodyText, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";
import { approveKyb } from "./helpers";

const PLATFORM_PN = "pn_sim_platform_001";
const PLATFORM_TOKEN = "sim-platform-token";

export const journey: Journey = {
  id: "J609",
  name: "shared platform number",
  feature: "W50: one platform number → enter a shop by name, chat routes to it (platform creds), home exits",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const onboarding = await import("../../server/services/onboarding");
    const lc = await import("../../server/services/onboardingLifecycle");
    const pn = await import("../../server/services/platformNumber");

    process.env.WHATSAPP_PLATFORM_NUMBER_ID = PLATFORM_PN;
    process.env.WHATSAPP_PLATFORM_TOKEN = PLATFORM_TOKEN;
    pn.__clearActiveShopMemory();
    try {
      // ── Seed a SHARED, live shop: active, own number NULL, default menu ────
      const { tenantId, slug } = await onboarding.createTenant({ name: "Corner Store", businessType: "retail" });
      assert(slug === "corner-store", `slug derived from name (got ${slug})`);
      await onboarding.setOnboardingStatus(tenantId, "validating", { validationPassed: true });
      await approveKyb(world, tenantId);
      await lc.goLiveTenant(tenantId, { actorId: "1", actorRole: "admin", source: "j609" });
      const [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
      assert(row.status === "active", `shop is active (got ${row.status})`);
      assert(row.whatsappPhoneNumberId == null, "shop has NO own number (shared)");

      const DIRECTORY_MARK = "I can help you shop from local stores";

      // ── 1. Cold contact / unrecognized → directory prompt (via platform #) ─
      const cold = world.newPhone("plat-cold");
      await world.inbound(payloads.inbound.text(PLATFORM_PN, cold, "hello there"));
      await world.settle();
      const coldReply = world.outbound.lastTo(cold);
      assert(coldReply, "directory replied to a cold contact");
      assert(new URL(coldReply.url).pathname.includes(PLATFORM_PN), "directory reply sent via the PLATFORM number");
      assert(bodyText(coldReply).includes(DIRECTORY_MARK), "cold contact got the directory prompt");
      assert((await pn.getActiveShop(cold)) === null, "cold contact has no active shop");

      // ── 2. Type the shop slug → enter it (active-shop pointer set) ─────────
      const shopper = world.newPhone("plat-shopper");
      await world.inbound(payloads.inbound.text(PLATFORM_PN, shopper, "corner-store"));
      await world.settle();
      const enterReply = world.outbound.lastTo(shopper);
      assert(enterReply && new URL(enterReply.url).pathname.includes(PLATFORM_PN), "enter-shop ack via the platform number");
      assert(bodyText(enterReply).toLowerCase().includes("corner store"), "ack names the shop entered");
      assert((await pn.getActiveShop(shopper)) === tenantId, "active-shop pointer now set to Corner Store");

      // ── 3. Next message routes to THE SHOP (not the directory) ────────────
      await world.inbound(payloads.inbound.text(PLATFORM_PN, shopper, "hi"));
      await world.settle();
      const shopReply = world.outbound.lastTo(shopper);
      assert(shopReply && new URL(shopReply.url).pathname.includes(PLATFORM_PN), "shop reply still via the platform number");
      assert(!bodyText(shopReply).includes(DIRECTORY_MARK), "message routed to the shop, NOT the directory");

      // ── 4. "home" → leave the shop, back to the directory ─────────────────
      await world.inbound(payloads.inbound.text(PLATFORM_PN, shopper, "home"));
      await world.settle();
      assert((await pn.getActiveShop(shopper)) === null, "'home' cleared the active shop");
      assert(bodyText(world.outbound.lastTo(shopper)).includes(DIRECTORY_MARK), "'home' returned the directory prompt");
    } finally {
      delete process.env.WHATSAPP_PLATFORM_NUMBER_ID;
      delete process.env.WHATSAPP_PLATFORM_TOKEN;
      pn.__clearActiveShopMemory();
    }
  },
};
