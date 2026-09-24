// === W47 merchant ===
/**
 * J430 — ONB-M-5 + ONB-M-8 (P0 regression): lifecycle gate on paid order
 * intake. Draft/trial/pre-live tenants cannot receive commerce traffic;
 * a live tenant whose KYB expired/rejected keeps trading only inside the
 * re-verification grace window, then new orders stop with an HONEST
 * buyer-facing message. Wired on BOTH channels (WA webhook + Telegram
 * dispatchToNlp via services/onboardingLifecycle).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, approveKyb } from "./helpers";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J430",
  name: "lifecycle gate on paid order intake (ONB-M-5 + ONB-M-8)",
  feature: "W47 merchant: draft/pre-KYB tenants get no paid orders; KYB-lapsed live tenant stops intake with honest buyer message",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const lc = await import("../../server/services/onboardingLifecycle");
    const admin = await adminCaller();

    // ── M-5: draft/trial/pre-live tenants blocked (pure evaluation) ──────
    const draft = lc.evaluateLifecycleIntake({ id: "t-draft", status: "trial", settings: {} });
    assert(!draft.allowed && draft.reason === "not_open", "draft/trial tenant blocked");
    assertIncludes(draft.buyerMessage!, "isn't open for orders yet", "honest buyer message for not-open store");
    const activeNotLive = lc.evaluateLifecycleIntake({ id: "t-cfg", status: "active", settings: { onboarding: { status: "configuring" } } });
    assert(!activeNotLive.allowed && activeNotLive.reason === "not_open", "active-but-not-live blocked");

    // ── Live + approved KYB → allowed ────────────────────────────────────
    const started = await admin.onboarding.start({ name: "J430 Intake Store" });
    const tenantId = started.tenantId;
    // Pre-KYB/non-live: blocked against the REAL db.
    let decision = await lc.checkOrderIntakeAllowed(world.db, { id: tenantId, status: "trial", settings: {} });
    assert(!decision.allowed && decision.reason === "not_open", "real-db trial tenant blocked from intake");

    const { setOnboardingStatus, updateTenantSettings, getOnboardingState } = await import("../../server/services/onboarding");
    await setOnboardingStatus(tenantId, "validating", { validationPassed: true });
    await approveKyb(world, tenantId);
    await lc.goLiveTenant(tenantId, { actorId: "1", actorRole: "admin", source: "j430" });
    let [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    decision = await lc.checkOrderIntakeAllowed(world.db, row);
    assert(decision.allowed, "live tenant with approved KYB receives orders");

    // ── M-8: KYB lapses → grace window → intake stops with honest msg ────
    await world.db.update(schema.kycApplications)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(schema.kycApplications.tenantId, tenantId));
    await lc.applyKybRestriction(world.db, tenantId, "expired");
    [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert(typeof (row.settings as any).onboarding.kybRestrictedAt === "string", "grace stamp written");
    decision = await lc.checkOrderIntakeAllowed(world.db, row);
    assert(decision.allowed, "inside grace window intake still flows");

    // Wind the clock past the grace window.
    await updateTenantSettings(tenantId, (s) => {
      (s.onboarding as any).kybRestrictedAt = new Date(Date.now() - (lc.KYB_GRACE_DAYS + 1) * 86_400_000).toISOString();
    });
    [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    decision = await lc.checkOrderIntakeAllowed(world.db, row);
    assert(!decision.allowed && decision.reason === "kyb_lapsed", "past grace: intake blocked");
    assertIncludes(decision.buyerMessage!, "temporarily paused", "honest buyer message for lapsed KYB");
    assertIncludes(decision.buyerMessage!, "no new orders", "buyer told orders are paused");

    // Re-approval clears the restriction → intake resumes. (Distinct id —
    // the helper's first row was flipped to expired above.)
    await world.db.insert(schema.kycApplications).values({
      id: `kyb-reverify-${tenantId}`.replace(/-/g, "").slice(0, 36),
      tenantId, type: "kyb", status: "approved", applicantName: "Sim Owner", businessName: tenantId,
    }).onConflictDoNothing();
    await lc.clearKybRestriction(world.db, tenantId);
    [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert(!(row.settings as any).onboarding.kybRestrictedAt, "restriction cleared on re-verification");
    decision = await lc.checkOrderIntakeAllowed(world.db, row);
    assert(decision.allowed, "intake resumes after re-verification");

    // ── Channel parity: BOTH inbound paths consult the gate ──────────────
    const wa = await readFile(`${repoRoot}/server/_core/index.ts`, "utf8");
    assertIncludes(wa, "checkOrderIntakeAllowed", "WA webhook consults the intake gate");
    assertIncludes(wa, 'notifType: "store_not_open"', "WA buyer auto-reply metered");
    const tg = await readFile(`${repoRoot}/server/services/telegramInbound.ts`, "utf8");
    assertIncludes(tg, "checkOrderIntakeAllowed", "Telegram dispatchToNlp consults the intake gate");
    assertIncludes(tg, "telegramIntakeBlockedCooldown", "Telegram reply cooldown");
  },
};
