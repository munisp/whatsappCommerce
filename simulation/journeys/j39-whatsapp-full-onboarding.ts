/**
 * J39 — WhatsApp full agentic onboarding: a prospect texts the PLATFORM's
 * onboarding number and the copilot onboards them end-to-end in chat:
 * greeting → free-text intake (facts extracted by the scripted LLM) →
 * proposal cards (waMenu + useCases + branding + integrations) → per-card
 * onb_approve taps → tenant created with the approved waMenu/branding applied
 * → whatsapp_business_profile push captured in outbound[] → credential
 * collection → validation passes → goLive proposal → approve → live with the
 * congrats + portal-URL follow-up.
 *
 * The prospect's own WhatsApp credentials are collected mid-flow (the real
 * repair path): a fresh tenant row has no phone number id yet, so validation
 * fails once with a targeted question, the prospect pastes the credentials,
 * and the re-run passes (the harness Graph mock serves the registered id).
 */
import {
  assert,
  assertIncludes,
  bodyText,
  type World,
} from "../world";
import type { Journey } from "../runner";
import { registerGraphObject, clearGraphObject } from "../metaMock";
import {
  approvePendingViaButtons,
  graphCallsTo,
  onboardingSessionById,
  onboardingSessionByPhone,
  tenantRowById,
} from "./helpers";

const J39_PHONE_NUMBER_ID = "109000123456789";
const J39_WA_TOKEN = "EAAj39prospecttoken0123456789";

export const journey: Journey = {
  id: "J39",
  name: "whatsapp full onboarding",
  feature: "copilot intake → proposals → approve → tenant live",
  async run(world) {
    const phone = world.newPhone("onb");

    // The profile push happens during the configuration phase — before the
    // tenant has its own creds column populated, so resolveTenantWaCredentials
    // falls back to the platform env creds (the prospect's soon-to-be number).
    process.env.WAC_WHATSAPP_TOKEN = "sim-wa-access-token";
    process.env.WAC_WHATSAPP_PHONE_ID = J39_PHONE_NUMBER_ID;
    try {
      // ── 1. First contact → greeting ───────────────────────────────────────
      await world.onboardingText(phone, "hello", { profileName: "Ada" });
      const greeting = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(greeting, "onboarding assistant", "greeting from the copilot");

      const s1 = await onboardingSessionByPhone(phone);
      assert(s1, "session created after first contact");
      assert(s1.state === "intake", `session in intake state (got ${s1.state})`);
      assert(s1.channel === "whatsapp", "session on the whatsapp channel");

      // ── 2. Free-text intake → facts extracted → proposal cards ────────────
      await world.onboardingText(
        phone,
        "I run Ada's Fabrics in Enugu, ankara + lace, delivery within Enugu, bank transfer",
      );
      const s2 = await onboardingSessionByPhone(phone);
      assert(s2, "session still active after intake");
      assert(s2.state === "approving", `proposals awaiting approval (got ${s2.state})`);
      assert(s2.intake.facts.businessName === "Ada's Fabrics", `business name extracted (got ${s2.intake.facts.businessName})`);
      assert(s2.intake.facts.city === "Enugu", `city extracted (got ${s2.intake.facts.city})`);
      assert(
        (s2.intake.facts.paymentPrefs ?? []).some((p: string) => /transfer/.test(p)),
        "payment preference extracted",
      );

      const kinds = s2.proposals.map((p) => p.kind);
      for (const kind of ["waMenu", "useCases", "branding", "integrations"]) {
        assert(kinds.includes(kind as any), `proposal card for ${kind} exists (got ${kinds.join(",")})`);
      }
      for (const p of s2.proposals) {
        assert(p.status === "pending", `proposal ${p.kind} pending (got ${p.status})`);
        // The card went out on the wire with onb_approve:/onb_edit: buttons.
        assert(
          world.outbound.findByBody(`onb_approve:${p.id}`, phone).length > 0,
          `proposal ${p.kind} card delivered with onb_approve button`,
        );
      }
      const brandingProposal = s2.proposals.find((p) => p.kind === "branding")!;
      assert(
        typeof (brandingProposal.payload as any).logoSvgDataUri === "string" &&
          (brandingProposal.payload as any).logoSvgDataUri.startsWith("data:image/svg"),
        "branding proposal carries the monogram SVG data URI",
      );
      assert(typeof (brandingProposal.payload as any).tagline === "string", "branding proposal carries a tagline");

      // ── 3. Approve each card via its onb_approve button ──────────────────
      await approvePendingViaButtons(world, phone, ["waMenu", "useCases", "branding", "integrations"]);

      // ── 4. Tenant created + approved config applied (DB state) ────────────
      const s3 = await onboardingSessionByPhone(phone);
      assert(s3, "session active after approvals");
      assert(typeof s3.tenantId === "string" && s3.tenantId, "tenant provisioned on first apply");
      const tenant = await tenantRowById(world, s3.tenantId!);
      assert(tenant, "tenant row exists");
      assert(tenant.name === "Ada's Fabrics", `tenant named from intake (got ${tenant.name})`);
      const settings = (tenant.settings ?? {}) as Record<string, any>;
      const approvedMenu = s3.proposals.find((p) => p.kind === "waMenu")!.payload as any;
      assert(
        settings.waMenu?.greeting === approvedMenu.greeting,
        `applied waMenu greeting matches the approved proposal (got ${settings.waMenu?.greeting})`,
      );
      assertIncludes(String(settings.waMenu?.greeting ?? ""), "Ada's Fabrics", "menu greeting names the business");
      assert(
        typeof settings.branding?.primaryColor === "string" && settings.branding.primaryColor.startsWith("#"),
        "branding primaryColor applied",
      );
      assert(
        settings.branding?.tagline === (brandingProposal.payload as any).tagline,
        "branding tagline matches the approved proposal",
      );
      assert(typeof settings.branding?.waProfileAbout === "string", "waProfileAbout derived from the tagline");

      // ── 5. whatsapp_business_profile push captured in outbound[] ──────────
      const profilePushes = graphCallsTo(world, "/whatsapp_business_profile");
      assert(profilePushes.length > 0, "whatsapp_business_profile push captured in outbound[]");
      const pushBody = profilePushes[profilePushes.length - 1].body ?? {};
      assert(pushBody.messaging_product === "whatsapp", "profile push uses the whatsapp messaging product");
      assert(
        typeof pushBody.about === "string" && pushBody.about.length > 0,
        "profile push sets the about field from the brand kit",
      );
      assert(
        new URL(profilePushes[profilePushes.length - 1].url).pathname.includes(J39_PHONE_NUMBER_ID),
        "profile push targets the prospect's phone number id",
      );

      // ── 6. Validation fails without tenant creds → targeted question ──────
      assert(s3.state === "configuring", `validation failed → repair loop (got ${s3.state})`);
      const repairQuestion = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(repairQuestion, "WhatsApp access token", "targeted repair question asks for credentials");

      // ── 7. Prospect pastes credentials → validation passes → goLive card ──
      registerGraphObject(J39_PHONE_NUMBER_ID); // harness Graph: the number is real + readable
      await world.onboardingText(phone, `phone number id is ${J39_PHONE_NUMBER_ID} token is ${J39_WA_TOKEN}`);
      const s4 = await onboardingSessionByPhone(phone);
      assert(s4, "session active after credential fix");
      assert(s4.state === "validating", `validation passed → awaiting go-live (got ${s4.state})`);
      const goLive = s4.proposals.find((p) => p.kind === "goLive" && p.status === "pending");
      assert(goLive, "goLive proposal emitted after validation passed");
      const goLiveText = world.outbound.findByBody("go live", phone);
      assert(goLiveText.length > 0, "go-live prompt delivered on the wire");
      const tenantAfterCreds = await tenantRowById(world, s4.tenantId!);
      assert(
        tenantAfterCreds?.whatsappPhoneNumberId === J39_PHONE_NUMBER_ID,
        "pasted phone number id stored on the tenant row",
      );
      assert(
        (tenantAfterCreds?.settings as any)?.whatsapp?.accessToken === J39_WA_TOKEN,
        "pasted access token stored in tenant settings",
      );

      // ── 8. Approve go-live → live + congrats with portal URL ──────────────
      await world.onboardingButtonReply(phone, `onb_approve:${goLive!.id}`, "Approve");
      const s5 = await onboardingSessionById(s4.id);
      assert(s5?.state === "live", `session live after go-live approval (got ${s5?.state})`);
      assert(
        (await onboardingSessionByPhone(phone)) === null,
        "live is terminal — no active session remains for the phone",
      );
      const liveReply = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(liveReply, "Congratulations", "congrats message delivered");
      assertIncludes(liveReply, "your store is live", "live confirmation");
      assertIncludes(liveReply, "/settings/whatsapp", "portal connect URL included");
      const finalTenant = await tenantRowById(world, s4.tenantId!);
      assert(finalTenant?.status === "active", `tenant status active (got ${finalTenant?.status})`);
      assert(
        (finalTenant?.settings as any)?.onboarding?.status === "live",
        "tenant onboarding state persisted as live",
      );
    } finally {
      delete process.env.WAC_WHATSAPP_TOKEN;
      delete process.env.WAC_WHATSAPP_PHONE_ID;
      clearGraphObject(J39_PHONE_NUMBER_ID);
    }
  },
};
