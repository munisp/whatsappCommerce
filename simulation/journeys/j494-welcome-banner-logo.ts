// === W49 RICHMEDIA ===
/**
 * J494 — RICH-9: welcome banner pushes the tenant logo on BOTH channels.
 *
 *   1. With settings.branding.logoUrl (relative tenant-branding URL), the WA
 *      banner is an image message with an ABSOLUTE link + greeting caption.
 *   2. TG parity: sendPhoto with the same caption.
 *   3. No logo configured → returns false, caller's plain text menu stands
 *      (fail-open, no broken image link ever sent).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J494",
  name: "welcome banner with tenant logo on WA + TG",
  feature: "RICH-9",
  async run(world: World) {
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    const { sendWhatsAppWelcomeBanner, sendTelegramWelcomeBanner, resolveTenantLogoUrl } = await import("../../server/services/richMedia");
    const phone = "+2348017000494";

    await world.patchTenantSettings({ branding: { logoUrl: "/api/storage/tenant-branding/sim-tenant/logo.png" } });

    const logo = await resolveTenantLogoUrl(world.db, TENANT_ID);
    assert(logo === "https://shop.example.com/api/storage/tenant-branding/sim-tenant/logo.png", "logo resolved + absolutized");

    // WA banner
    const sentWa = await sendWhatsAppWelcomeBanner(TENANT_ID, phone, "Welcome to Sim Store! 👋");
    assert(sentWa === true, "WA banner sent");
    const img = world.outbound.lastOfType("image", phone.replace("+", ""));
    assert(img?.body?.image?.link === logo, "WA image carries the absolute logo url");
    assert(String(img?.body?.image?.caption).includes("Welcome"), "greeting caption");

    // TG banner
    await ensureTelegramConfig(world);
    tg.reset();
    const sentTg = await sendTelegramWelcomeBanner(TENANT_ID, "494001", "Welcome to Sim Store! 👋");
    assert(sentTg === true, "TG banner sent");
    const photo = tg.callsFor("sendPhoto").pop();
    assert(photo?.body?.photo === logo, "TG photo carries the absolute logo url");

    // No logo → false, nothing sent.
    await world.patchTenantSettings({ branding: { logoUrl: "" }, logoUrl: "" });
    const n = world.outbound.toPhone(phone).length;
    const noLogo = await sendWhatsAppWelcomeBanner(TENANT_ID, phone, "hi");
    assert(noLogo === false, "no logo → honest false");
    assert(world.outbound.toPhone(phone).length === n, "nothing sent without a logo");
  },
};
