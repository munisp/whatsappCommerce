// === W50 SMS ===
/**
 * J512 — pcm locale over SMS: consent chrome renders from the pidgin locale
 * pack (with the WhatsApp→SMS channel swap), not English.
 *
 *   1. A pidgin first-contact SMS resolves locale pcm (detector) and the
 *      consent prompt is the pcm pack string (word "SMS" swapped in).
 *   2. "YES" opt-in reply also renders the pcm granted copy.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { sms, smsBodyParams } from "../metaMock";

export const journey: Journey = {
  id: "J512",
  name: "pcm locale SMS consent chrome",
  feature: "W50 SMS: resolveLocale + locale packs on the sms reply loop",
  async run(world: World) {
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"sms":{"provider":"africa_talking","username":"sandbox","apiKey":"at-key-512","senderId":"SIMSHOP"}}'::jsonb WHERE id = '${TENANT_ID}'`,
    );
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({ user: null } as any);
    const i18n = await import("../../server/services/i18n");
    const phone = world.newPhone("512");

    const pcmPrompt = i18n.tr("pcm", "consentPrompt").replace(/WhatsApp/g, "SMS");
    const enPrompt = i18n.tr("en", "consentPrompt").replace(/WhatsApp/g, "SMS");
    assert(pcmPrompt !== enPrompt, "pcm pack has its own consent prompt");
    assert(pcmPrompt.includes("fit"), "pcm prompt carries pidgin markers");

    // ── 1. Pidgin first contact → pcm consent prompt over SMS ──────────
    assert(i18n.detectLocale("Abeg how far, wetin dey for shop?") === "pcm", "pidgin text detects pcm");
    const r1 = await caller.channels.processSms({ from: phone, to: "40404", body: "Abeg how far, wetin dey for shop?", tenantId: TENANT_ID });
    assert(r1.status === "replied" && r1.intent === "consent", "pidgin first contact answered by consent gate");
    // The prompt is segmented into concatenated SMS parts — reassemble and
    // compare against the pcm pack string (whitespace-normalized).
    const joined = sms.calls.map((c) => smsBodyParams(c).message ?? "").join(" ").replace(/\s+/g, " ").replace(/…$/, "").trim();
    const expect = pcmPrompt.replace(/\s+/g, " ").trim();
    assert(joined.includes("fit") && joined.includes("YES"), `pcm consent prompt over SMS (got: ${joined.slice(0, 100)})`);
    assert(!joined.includes("WhatsApp"), "pcm prompt channel-swapped to SMS");
    // Word-level fidelity: every word of the (truncated) pcm prompt appears.
    for (const w of expect.split(" ").slice(0, 6)) assert(joined.includes(w), `prompt word "${w}" present`);

    // ── 2. YES → pcm granted copy ──────────────────────────────────────
    const pcmGranted = i18n.tr("pcm", "consentGranted").replace(/WhatsApp/g, "SMS");
    const before = sms.calls.length;
    const r2 = await caller.channels.processSms({ from: phone, to: "40404", body: "YES", tenantId: TENANT_ID });
    assert(r2.status === "replied", "YES answered");
    const grantedJoined = sms.calls.slice(before).map((c) => smsBodyParams(c).message ?? "").join(" ").replace(/\s+/g, " ").trim();
    assert(grantedJoined.includes("don opt in") || grantedJoined === pcmGranted, `pcm granted copy sent (got: ${grantedJoined.slice(0, 80)})`);
  },
};
