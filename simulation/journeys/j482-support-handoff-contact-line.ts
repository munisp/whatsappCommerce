/**
 * J482 — "Get support" and "Talk to a human" hand the buyer a real phone/email, not just a platitude.
 *
 * Found live 2026-09-25, testing the Telegram bot end to end: picking either menu option only ever replied with
 * "someone will be with you shortly" / "our team will get back to you" — nothing the buyer could act on
 * themselves. Worse, for this exact test tenant `settings.adminPhone` was null, so `notifyTenantAdmin` silently
 * no-op'd (confirmed live via `kubectl exec` + a direct DB query) — no admin was ever actually paged either, so
 * the promise was empty on BOTH ends.
 *
 * Fix: a new `settings.support` config (shared/tenantConfig.ts's supportConfigSchema, `tenantConfig.getSupportConfig`
 * / `setSupportConfig`, a new "Support" tab in TenantSettings.tsx) the tenant can fill in; `supportContactLine()`
 * in useCases.ts appends it to both the support-handler's opening reply and the handoff reply when configured.
 * Deliberately separate from `adminPhone` (who the bot pages internally) — this is what the bot tells the CUSTOMER.
 *
 * Covers: support's opening reply includes the phone/email; handoff's reply includes them too; a tenant that
 * never configured either still gets the plain platitude with no dangling "reach us directly" line (mutation
 * would be: comment out supportContactLine's call sites — both assertContains checks below fail immediately).
 */
import { assert, assertIncludes, bodyText, TENANT_ID, ADMIN_PHONE, type World } from "../world";
import type { Journey } from "../runner";

const SUPPORT_PHONE = "+234 900 123 4567";
const SUPPORT_EMAIL = "help@adastores.example";

export const journey: Journey = {
  id: "J482",
  name: "support/handoff replies hand the buyer a real phone + email when the tenant configured one",
  feature: "Buyer-facing support contact (settings.support)",
  async run(world: World) {
    // Other journeys repoint settings.adminPhone/waMenu at their own test merchant and never restore either —
    // set both back explicitly (same pattern J471/J479/J480 use) rather than assume they survived to this point.
    await world.patchTenantSettings({ adminPhone: ADMIN_PHONE });
    // TENANT_ID normally carries NO settings.waMenu override at all (loadMenuConfig then falls back to the code
    // defaults — confirmed live: an empty/absent useCases array short-circuits straight back to defaults, it does
    // NOT merge item-by-item). Build the patch off the real default template, not off whatever's on the tenant
    // right now, so enabling "support" actually sticks.
    const { defaultMenuConfig } = await import("../../server/services/waMenu");
    const waMenu = defaultMenuConfig();
    // "support" is disabled in the shared default template — turn it on so it gets a visible menu slot alongside
    // the already-enabled "handoff".
    waMenu.useCases = waMenu.useCases.map((u) => (u.id === "support" ? { ...u, enabled: true } : u));
    await world.patchTenantSettings({ waMenu, support: { phone: SUPPORT_PHONE, email: SUPPORT_EMAIL } });

    const phone = world.newPhone("482");
    await world.grantConsent(phone);
    const last = () => bodyText(world.outbound.lastTo(phone));

    // Menu renumbers to only the enabled entries, in order: shop(1) track(2) support(3) handoff(4) — see
    // waMenu.ts's buildMenuEntries (filter enabled, sort by `order`, then 1..n).
    await world.text(phone, "menu");
    assertIncludes(last(), "How can we help", "menu must render before selecting an option");

    // 1. "Get support" (3): the OPENING reply (before any issue is typed) must carry both the phone and email.
    await world.text(phone, "3");
    const supportReply = last();
    assertIncludes(supportReply, "describe your issue", "support's opening reply");
    assertIncludes(supportReply, SUPPORT_PHONE, "support reply must include the tenant's support phone");
    assertIncludes(supportReply, SUPPORT_EMAIL, "support reply must include the tenant's support email");

    // Finish the support flow (types an issue) so the session clears cleanly before re-opening the menu.
    await world.text(phone, "the delivery never arrived");
    assertIncludes(last(), "logged your issue", "support flow completes normally afterward");

    // 2. "Talk to a human" (4): same contact line on the handoff reply.
    await world.text(phone, "menu");
    await world.text(phone, "4");
    const handoffReply = last();
    assertIncludes(handoffReply, "human agent", "handoff reply");
    assertIncludes(handoffReply, SUPPORT_PHONE, "handoff reply must include the tenant's support phone");
    assertIncludes(handoffReply, SUPPORT_EMAIL, "handoff reply must include the tenant's support email");

    // 3. A tenant that never configured settings.support gets the plain reply, no dangling "reach us" line and
    //    no crash — proves the feature is additive, not a new hard requirement.
    await world.patchTenantSettings({ support: { phone: null, email: null } });
    const phone2 = world.newPhone("482b");
    await world.grantConsent(phone2);
    const last2 = () => bodyText(world.outbound.lastTo(phone2));
    await world.text(phone2, "menu");
    await world.text(phone2, "4");
    const plainHandoff = last2();
    assertIncludes(plainHandoff, "human agent", "handoff still replies normally with no support contact configured");
    assert(!/reach us directly/i.test(plainHandoff), "no dangling contact line when settings.support is unset");
  },
};
