/**
 * J44 — Admin-channel session: the exact service API the portal UI (w9 C4)
 * calls — startSession({channel:'admin', tenantId}) → postMessage intake →
 * proposal cards → decideProposal approvals → configuration applied to the
 * tenant → live validation (seeded creds pass against the harness Graph
 * mock) → goLive proposal → approve → tenant live. Proves the whole copilot
 * pipeline works with no WhatsApp channel involved.
 *
 * The seeded sim tenant's settings are snapshotted and restored at the end
 * so this journey never leaks menu/branding changes into the rest of the
 * suite.
 */
import { eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { graphCallsTo, tenantRowById } from "./helpers";

export const journey: Journey = {
  id: "J44",
  name: "admin channel session",
  feature: "portal API: intake → approve → validate → live",
  async run(world) {
    const copilot = await import("../../server/services/onboardingCopilot");
    const schema = await import("../../drizzle/schema");
    const settingsBefore = await world.tenantSettings();

    try {
      // ── startSession on the admin channel, bound to the seeded tenant ────
      const { sessionId, greeting } = await copilot.startSession({ channel: "admin", tenantId: TENANT_ID });
      assert(greeting.includes("onboarding assistant"), "greeting returned to the portal");
      let session = await copilot.getSession(sessionId);
      assert(session?.channel === "admin" && session.tenantId === TENANT_ID, "admin session bound to the tenant");
      assert(session?.state === "intake", `fresh admin session in intake (got ${session?.state})`);

      // ── Intake message → proposal cards in the reply payload ─────────────
      const intake = await copilot.postMessage({
        sessionId,
        text: "I run Sim Store in Lagos, groceries + fashion, delivery within Lagos, bank transfer",
      });
      assert(intake.state === "approving", `proposals awaiting approval (got ${intake.state})`);
      const cardKinds = intake.replies.filter((r) => r.type === "card").length;
      assert(cardKinds >= 3, `proposal cards returned to the portal (got ${cardKinds})`);
      session = await copilot.getSession(sessionId);
      for (const kind of ["waMenu", "useCases", "branding", "integrations"]) {
        assert(
          session!.proposals.some((p) => p.kind === kind && p.status === "pending"),
          `pending ${kind} proposal in the session`,
        );
      }

      // ── Approve every proposal through decideProposal (what C4 calls) ────
      for (const p of session!.proposals.filter((x) => x.status === "pending")) {
        const decision = await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
        assert(decision.ok, `approval of ${p.kind} accepted`);
      }

      // ── Configuration applied + validation passed → validating ───────────
      session = await copilot.getSession(sessionId);
      assert(session?.state === "validating", `seeded creds pass validation (got ${session?.state})`);
      const goLive = session!.proposals.find((p) => p.kind === "goLive" && p.status === "pending");
      assert(goLive, "goLive proposal emitted after validation");

      const settings = await world.tenantSettings();
      assertIncludes(String(settings.waMenu?.greeting ?? ""), "Sim Store", "approved waMenu greeting applied");
      assert(typeof settings.branding?.tagline === "string", "brand kit tagline applied");
      assert(
        typeof settings.branding?.primaryColor === "string" && settings.branding.primaryColor.startsWith("#"),
        "brand kit primaryColor applied",
      );

      // Brand assets persisted (tenantId was known at proposal time).
      const logos = await world.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.tenantId, TENANT_ID));
      assert(
        logos.some((l: any) => l.kind === "logo" && l.mime === "image/svg+xml" && String(l.dataUri).startsWith("data:image/svg")),
        "monogram SVG persisted to media_assets",
      );

      // whatsapp_business_profile push captured for the tenant's own number.
      const pushes = graphCallsTo(world, "/whatsapp_business_profile");
      assert(pushes.length > 0, "whatsapp_business_profile push captured in outbound[]");
      assert(
        new URL(pushes[pushes.length - 1].url).pathname.includes(PHONE_NUMBER_ID),
        "profile push targets the tenant's phone number id",
      );

      // ── Approve go-live → tenant live ────────────────────────────────────
      const goLiveDecision = await copilot.decideProposal({ sessionId, proposalId: goLive!.id, approve: true });
      assert(goLiveDecision.ok, "go-live approval accepted");
      assert(
        goLiveDecision.replies.some((r) => r.text.includes("LIVE")),
        "live confirmation returned to the portal",
      );
      session = await copilot.getSession(sessionId);
      assert(session?.state === "live", `admin session live (got ${session?.state})`);
      const tenant = await tenantRowById(world, TENANT_ID);
      assert(tenant?.status === "active", `tenant active (got ${tenant?.status})`);
      assert(
        (tenant?.settings as any)?.onboarding?.status === "live",
        "tenant onboarding state persisted as live",
      );
    } finally {
      // Restore the seeded tenant's settings (waMenu/branding/onboarding were
      // mutated above) so the rest of the suite is unaffected.
      await world.db
        .update(schema.tenants)
        .set({ settings: settingsBefore, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID));
    }
  },
};
