// === W37 telegram (Coder A) ===
/**
 * J233 — channelSender facade routing + honest capability matrix.
 *
 *   1. Capability matrix: whatsapp (templates, 3 buttons, 24h window,
 *      delivery receipts) vs telegram (no templates, paged keyboards, NO
 *      session window, no delivery receipts) — degrade honestly.
 *   2. Routing: same text payload → waSender for whatsapp (Graph /messages)
 *      and telegramSender for telegram (api.telegram.org sendMessage).
 *   3. Honest degrade: template on telegram → plain-text render flagged
 *      degraded; contact_request on whatsapp → text degrade; telegram
 *      recipient normalization strips the `telegram:` session-key prefix.
 *   4. Unsupported channel throws; status report fn is honest (telegram
 *      disabled by default → mode "disabled").
 */
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";
import { meta, outbound } from "../metaMock";

const CHAT = "770201";

export const journey: Journey = {
  id: "J233",
  name: "channelSender facade: routing + capability matrix honest degrade",
  feature: "W37 telegram outbound: channel-agnostic send facade",
  async run(world: World) {
    const cs = await import("../../server/services/channelSender");

    // ── 1. Capability matrix ───────────────────────────────────────────
    const waCap = cs.capabilitiesFor("whatsapp")!;
    const tgCap = cs.capabilitiesFor("telegram")!;
    assert(waCap.supportsTemplates === true && tgCap.supportsTemplates === false, "templates: wa only");
    assert(waCap.maxButtons === 3, "wa 3-button cap");
    assert(tgCap.supportsButtons === true && tgCap.maxButtons > 3, "telegram inline keyboards exceed wa cap");
    assert(waCap.requiresSessionWindow === true && tgCap.requiresSessionWindow === false, "24h window is wa-only");
    assert(cs.requiresSessionWindow("telegram") === false && cs.requiresSessionWindow("whatsapp") === true,
      "requiresSessionWindow helper (cron nudges must not suppress telegram)");
    assert(tgCap.supportsDeliveryReceipts === false, "telegram honestly reports no delivery receipts");
    assert(tgCap.supportsContactRequest === true && waCap.supportsContactRequest === false,
      "contact request is telegram-native");
    assert(cs.capabilitiesFor("carrier-pigeon") === null, "unknown channel → null capabilities");

    // ── 2. Routing ─────────────────────────────────────────────────────
    process.env.TELEGRAM_ENABLED = "true";
    meta.hostStatus.set("api.telegram.org", 200);
    const { encryptSecret } = await import("../../server/services/crypto/secrets");
    const tgCfg = JSON.stringify({ telegram: { botToken: encryptSecret("123456:SIM_BOT_TOKEN"), enabled: true } });
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${tgCfg}'::jsonb WHERE id = '${TENANT_ID}'`,
    );

    const waBefore = outbound.waMessages().length;
    const waRes = await cs.sendChannelMessage(TENANT_ID, "whatsapp", "2348012345678", { kind: "text", text: "routing check wa" });
    assert(waRes.channel === "whatsapp" && waRes.sent === true, "whatsapp routed to waSender");
    const waNew = outbound.waMessages().slice(waBefore);
    assert(waNew.some((c: any) => String(c.body?.text?.body ?? "").includes("routing check wa")), "hit Graph /messages");

    const tgBefore = outbound.all().filter((c: any) => String(c.url).includes("api.telegram.org")).length;
    const tgRes = await cs.sendChannelMessage(TENANT_ID, "telegram", CHAT, { kind: "text", text: "routing check tg" });
    assert(tgRes.channel === "telegram" && tgRes.sent === true, "telegram routed to telegramSender");
    const tgNew = outbound.all().filter((c: any) => String(c.url).includes("api.telegram.org")).slice(tgBefore);
    assert(tgNew.some((c: any) => String(c.url).includes("/sendMessage") && String(c.body?.text ?? "").includes("routing check tg")),
      "hit Bot API sendMessage");

    // Keyboard routing preserves ids on both channels.
    await cs.sendChannelMessage(TENANT_ID, "telegram", CHAT, {
      kind: "keyboard",
      text: "Actions",
      buttons: [{ id: "menu_1", title: "Menu" }, { id: "order_view:ord_9", title: "View order" }],
    });
    const tgKb = outbound.all().filter((c: any) => JSON.stringify(c.body ?? {}).includes("order_view:ord_9")).pop();
    assert(tgKb && String(tgKb.url).includes("api.telegram.org"), "telegram keyboard keeps order_* id");

    // ── 3. Honest degrade ──────────────────────────────────────────────
    const tpl = await cs.sendChannelMessage(TENANT_ID, "telegram", CHAT, {
      kind: "template",
      templateName: "wac_order_confirmation",
      languageCode: "en_US",
      fallbackText: "Order confirmed: #42",
    });
    assert(tpl.degraded === "template→text", `template degrades to text on telegram (got ${tpl.degraded})`);
    const tplCall = outbound.all().filter((c: any) => String(c.url).includes("/sendMessage") && String(c.body?.text ?? "").includes("Order confirmed: #42")).pop();
    assert(tplCall, "fallback text actually sent");

    const cr = await cs.sendChannelMessage(TENANT_ID, "whatsapp", "2348012345678", { kind: "contact_request", text: "Please share your number" });
    assert(cr.degraded === "contact_request→text", "wa contact_request degrades to text");

    // telegram:<chat_id> session-key prefix is normalized.
    const prefixed = await cs.sendChannelMessage(TENANT_ID, "telegram", `telegram:${CHAT}`, { kind: "text", text: "prefixed" });
    assert(prefixed.sent === true, "prefixed recipient accepted");
    const prefCall = outbound.all().filter((c: any) => String(c.url).includes("/sendMessage") && String(c.body?.text ?? "") === "prefixed").pop();
    assert(String((prefCall.body as any).chat_id) === CHAT, "telegram: prefix stripped before Bot API call");

    // ── 4. Errors + honest status ──────────────────────────────────────
    let threw = false;
    try {
      await cs.sendChannelMessage(TENANT_ID, "carrier-pigeon" as any, "x", { kind: "text", text: "hi" });
    } catch (e: any) {
      threw = /unsupported channel/.test(e?.message ?? "");
    }
    assert(threw, "unsupported channel throws honestly");

    delete process.env.TELEGRAM_ENABLED;
    const status = await cs.getChannelSenderStatus(TENANT_ID);
    assert(status.telegram.mode === "disabled" && status.telegram.globallyEnabled === false,
      `telegram honestly disabled by default (got ${status.telegram.mode})`);
    assert(status.whatsapp.channel === "whatsapp" && typeof status.whatsapp.configured === "boolean",
      "whatsapp status reported");

    meta.hostStatus.delete("api.telegram.org");
  },
};
