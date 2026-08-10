/**
 * J40 — Edit path: the prospect taps onb_edit on the branding card, replies
 * with free-text feedback ("use purple colors and a warmer greeting"), the
 * stale proposal is rejected and the agent RE-DRAFTS the affected proposals
 * (branding with a purple palette, waMenu with a warmer greeting). Approving
 * the re-drafted cards applies the EDITED payloads — never the originals.
 *
 * Regression guard for the edit dead-end fixed in wave 9 (see README):
 * free-text feedback in 'approving' state previously fell through to a
 * generic "please review" reply and no re-draft ever happened.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { clearGraphObject, registerGraphObject } from "../metaMock";
import {
  approvePendingViaButtons,
  onboardingSessionById,
  onboardingSessionByPhone,
  tenantRowById,
} from "./helpers";

const J40_PHONE_NUMBER_ID = "109000987654321";
const FEEDBACK = "use purple colors and a warmer greeting";

export const journey: Journey = {
  id: "J40",
  name: "edit path re-draft",
  feature: "onb_edit → feedback → re-drafted proposals applied",
  async run(world) {
    const phone = world.newPhone("ed");
    const { paletteForVibe } = await import("../../server/services/brandStudio");
    const expectedPurple = paletteForVibe(FEEDBACK);
    assert(expectedPurple, "vibe palette derived for the purple feedback");

    // ── Intake → proposals ──────────────────────────────────────────────────
    await world.onboardingText(phone, "hello");
    await world.onboardingText(phone, "I own Kelechi Shoes in Aba, leather shoes + bags, delivery within Aba, cash");
    const s1 = await onboardingSessionByPhone(phone);
    assert(s1?.state === "approving", `proposals awaiting approval (got ${s1?.state})`);
    const branding = s1.proposals.find((p) => p.kind === "branding" && p.status === "pending");
    const originalWaMenu = s1.proposals.find((p) => p.kind === "waMenu" && p.status === "pending");
    assert(branding && originalWaMenu, "branding + waMenu proposals pending");
    const originalBrandingColor = (branding.payload as any).primaryColor;
    const originalGreeting = (originalWaMenu.payload as any).greeting as string;

    // ── onb_edit → prompt → free-text feedback ──────────────────────────────
    await world.onboardingButtonReply(phone, `onb_edit:${branding.id}`, "Edit");
    const editPrompt = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(editPrompt, "reply with your changes", "edit prompt asks for free-text changes");

    await world.onboardingText(phone, FEEDBACK);

    // ── Stale proposal rejected; agent re-drafted the affected kinds ────────
    const s2 = await onboardingSessionByPhone(phone);
    assert(s2, "session active after feedback");
    const stale = s2.proposals.find((p) => p.id === branding.id);
    assert(stale?.status === "rejected", `stale branding proposal rejected (got ${stale?.status})`);

    const revisedBranding = s2.proposals.find(
      (p) => p.kind === "branding" && p.status === "pending" && p.id !== branding.id,
    );
    assert(revisedBranding, "re-drafted branding proposal pending");
    assert(
      (revisedBranding.payload as any).primaryColor === expectedPurple.primaryColor,
      `re-drafted branding uses the requested purple (got ${(revisedBranding.payload as any).primaryColor})`,
    );
    assert(
      (revisedBranding.payload as any).primaryColor !== originalBrandingColor,
      "re-drafted color differs from the original monogram palette",
    );

    const revisedWaMenu = s2.proposals.find(
      (p) => p.kind === "waMenu" && p.status === "pending" && p.id !== originalWaMenu.id,
    );
    assert(revisedWaMenu, "re-drafted waMenu proposal pending");
    assertIncludes(String((revisedWaMenu.payload as any).greeting), "warm welcome", "re-drafted greeting is warmer");

    const reworkNote = world.outbound.findByBody("reworked the proposal", phone);
    assert(reworkNote.length > 0, "re-draft announcement delivered on the wire");

    // ── Approve every pending card (original waMenu + all re-drafts) ────────
    await approvePendingViaButtons(world, phone, ["waMenu", "useCases", "branding", "integrations"]);

    // ── Applied payload is the EDITED/re-drafted one, not the original ──────
    const s3 = await onboardingSessionByPhone(phone);
    assert(s3?.tenantId, "tenant provisioned");
    const tenant = await tenantRowById(world, s3.tenantId!);
    const settings = (tenant?.settings ?? {}) as Record<string, any>;
    assertIncludes(
      String(settings.waMenu?.greeting ?? ""),
      "warm welcome",
      "applied waMenu greeting is the re-drafted (warm) one",
    );
    assert(
      settings.waMenu?.greeting !== originalGreeting,
      "applied waMenu greeting is NOT the original",
    );
    assert(
      settings.branding?.primaryColor === expectedPurple.primaryColor,
      "applied branding primaryColor is the requested purple",
    );

    // ── Finish the flow: credentials → validation → go-live ────────────────
    registerGraphObject(J40_PHONE_NUMBER_ID);
    await world.onboardingText(phone, `phone number id is ${J40_PHONE_NUMBER_ID} token is EAAj40tokenabc123456`);
    const s4 = await onboardingSessionByPhone(phone);
    assert(s4?.state === "validating", `validation passed after credential fix (got ${s4?.state})`);
    const goLive = s4.proposals.find((p) => p.kind === "goLive" && p.status === "pending");
    assert(goLive, "goLive proposal emitted");
    await world.onboardingButtonReply(phone, `onb_approve:${goLive!.id}`, "Approve");
    const s5 = await onboardingSessionById(s4.id);
    assert(s5?.state === "live", `edited setup goes live (got ${s5?.state})`);
    clearGraphObject(J40_PHONE_NUMBER_ID);
  },
};
