// === W47 merchant ===
/**
 * J429 — ONB-M-3 (P0): the portal setup wizard is wired to REAL APIs.
 * Source-level pins (the page is React, not executable here): no toast-only
 * WhatsApp verify, no toast-only products/zones, no hardcoded done:true
 * checklist, and go-live calls onboarding.validate + onboarding.activate.
 * Functional: onboarding.getStatus now returns payoutConfigured.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J429",
  name: "portal OnboardingWizard wired to real APIs (ONB-M-3)",
  feature: "W47 merchant: no fake verify / toast-only go-live",
  async run(world) {
    const src = await readFile(`${repoRoot}/client/src/pages/portal/OnboardingWizard.tsx`, "utf8");

    // ── No fake steps remain ─────────────────────────────────────────────
    assert(!src.includes('toast.success("WhatsApp connected!'), "no fake WhatsApp verify toast");
    assert(!src.includes("setCodeSent(true)"), "no fake code-sent state");
    assert(!src.includes("done: true"), "no hardcoded checklist");
    assert(!src.includes('toast.success("You\'re live! Your WhatsApp Commerce store is now active.")'),
      "no toast-only go-live");

    // ── Real mutations wired ─────────────────────────────────────────────
    assertIncludes(src, "trpc.onboarding.updateStep.useMutation", "WhatsApp step persists via updateStep");
    assertIncludes(src, 'step: "whatsapp"', "whatsapp step payload");
    assertIncludes(src, "trpc.product.create.useMutation", "products persist via product.create");
    assertIncludes(src, "trpc.tenantConfig.setCommerceConfig.useMutation", "zones persist via setCommerceConfig");
    assertIncludes(src, "trpc.onboarding.getStatus.useQuery", "checklist derives from getStatus");
    assertIncludes(src, "trpc.onboarding.validate.useMutation", "go-live runs live validation");
    assertIncludes(src, "trpc.onboarding.activate.useMutation", "go-live calls gated activate");
    assertIncludes(src, "toast.error(errMsg(e))", "failures surface honest errors");

    // ── Functional: getStatus exposes payout + canonical progress ────────
    const admin = await adminCaller();
    const started = await admin.onboarding.start({ name: "J429 Status Store" });
    const caller = await tenantCaller(started.tenantId, { userId: 429 });
    const status = await caller.onboarding.getStatus({ tenantId: started.tenantId });
    assert(status.payoutConfigured === false, "payoutConfigured=false before capture");
    assert(status.canonicalProgress === true, "canonical progress marker present");
    assert(status.status === "draft", "fresh tenant in draft");
  },
};
