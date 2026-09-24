// === W47 merchant ===
/**
 * J433 — ONB-M-7 (one canonical onboarding truth: legacy getProgress and
 * portal onboardingProgress.getProgress both surface settings.onboarding)
 * + ONB-M-11 (/onboarding KYB page no longer hardcodes "demo-tenant-id").
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J433",
  name: "canonical onboarding progress + no demo-tenant-id (ONB-M-7/M-11)",
  feature: "W47 merchant: converged progress trackers, session-resolved tenant",
  async run(world) {
    const admin = await adminCaller();
    const started = await admin.onboarding.start({ name: "J433 Progress Store" });
    const tenantId = started.tenantId;

    // Move the CANONICAL state machine forward, then read both trackers.
    const { setOnboardingStatus } = await import("../../server/services/onboarding");
    await setOnboardingStatus(tenantId, "configuring", { completedSteps: ["whatsapp"] });

    const caller = await tenantCaller(tenantId, { userId: 433, memberships: [tenantId] });
    const legacy = await caller.onboarding.getProgress({ tenantId });
    assert(legacy?.canonical?.status === "configuring", "legacy getProgress surfaces canonical state");
    assert(legacy?.canonical?.completedSteps?.includes("whatsapp"), "canonical completedSteps present");

    // Portal tracker: caller's ctx.user.tenantId drives getProgress.
    const progress = await caller.onboardingProgress.getProgress();
    assert(progress.canonical?.status === "configuring", "onboardingProgress surfaces canonical state");
    assert(progress.tenantId === tenantId, "portal tracker resolves session tenant");

    // ── M-11: no hardcoded demo-tenant-id; tenant resolved from session ──
    const page = await readFile(`${repoRoot}/client/src/pages/TenantOnboarding.tsx`, "utf8");
    assert(!page.includes('tenantId: "demo-tenant-id"'), "no demo-tenant-id mutation input");
    assert(!page.includes('tenantId="demo-tenant-id"'), "no demo-tenant-id prop");
    assertIncludes(page, "user?.tenantId", "tenant resolved from session");
  },
};
