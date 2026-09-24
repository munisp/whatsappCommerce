// === W47 merchant ===
/**
 * J431 — ONB-M-6 (number-conflict precheck on onboarding.updateStep
 * whatsapp) + ONB-M-17 (legacy saveStep mass-assignment closed).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J431",
  name: "updateStep whatsapp conflict precheck + saveStep whitelist (ONB-M-6/M-17)",
  feature: "W47 merchant: number anti-hijack on self-serve path; no mass assignment",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    // ── M-6: phone_number_id conflict → honest CONFLICT (not raw 23505) ──
    const a = await admin.onboarding.start({ name: "J431 Store A" });
    const b = await admin.onboarding.start({ name: "J431 Store B" });
    const callerB = await tenantCaller(b.tenantId, { userId: 431 });
    // Tenant A owns the number (simulate operator-configured creds).
    await world.db.update(schema.tenants)
      .set({ whatsappPhoneNumberId: "pn-j431-owned", updatedAt: new Date() })
      .where(eq(schema.tenants.id, a.tenantId));
    const err = await expectTrpcError(
      callerB.onboarding.updateStep({
        tenantId: b.tenantId,
        step: "whatsapp",
        data: { phoneNumberId: "pn-j431-owned", accessToken: "EAAtoken431" },
      }),
      "CONFLICT",
      "updateStep with another tenant's phone_number_id",
    );
    assert(String(err.message).includes("already connected"), `honest conflict message (got: ${err.message})`);
    const [bRow] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, b.tenantId)).limit(1);
    assert(bRow.whatsappPhoneNumberId !== "pn-j431-owned", "no hijack persisted");
    // Own number reuse is fine.
    const okSave = await callerB.onboarding.updateStep({
      tenantId: b.tenantId,
      step: "whatsapp",
      data: { phoneNumberId: "pn-j431-b", accessToken: "EAAtoken431", wabaId: "waba431" },
    });
    assert(okSave.ok, "own number saves cleanly");
    const [bRow2] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, b.tenantId)).limit(1);
    assert(bRow2.whatsappPhoneNumberId === "pn-j431-b", "phone_number_id persisted");
    assert((bRow2.settings as any)?.whatsapp?.wabaId === "waba431", "wabaId captured (operator-path parity)");

    // ── M-17: legacy saveStep ignores currentStep / unknown keys ─────────
    await callerB.onboarding.saveStep({
      tenantId: b.tenantId,
      step: "business_profile",
      data: { businessType: "Retail", currentStep: "completed", hackerKey: "pwned" } as any,
    });
    const [onb] = await world.db.select().from(schema.tenantOnboarding)
      .where(eq(schema.tenantOnboarding.tenantId, b.tenantId)).limit(1);
    assert(onb.currentStep === "billing_model", `whitelisted currentStep progression (got ${onb.currentStep})`);
    assert(onb.businessType === "Retail", "whitelisted column written");
    assert(!("hackerKey" in onb), "unknown key not persisted");
  },
};
