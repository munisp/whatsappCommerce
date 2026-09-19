// === W47 buyer (Coder B) ===
/**
 * J441 — ONB-B-5 + ONB-B-13: proof-of-consent evidence (the inbound wamid of
 * the YES reply) is populated at the grant call site; the consent policy is a
 * REAL versioned registry (current version = latest entry); and hasConsent
 * aligns with the withdrawn check (granted + withdrawnAt → false).
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J441",
  name: "ONB-B-5/B-13 consent proofWamid + policy registry + withdrawn-aware hasConsent",
  feature: "W47 buyer consent evidence",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const consent = await import("../../server/services/consent");

    // 1. Registry is real: current version is the latest entry.
    assert(consent.CONSENT_POLICY_REGISTRY.length >= 1, "policy registry populated");
    const latest = consent.CONSENT_POLICY_REGISTRY[consent.CONSENT_POLICY_REGISTRY.length - 1];
    assert(consent.CONSENT_POLICY_VERSION === latest.version, "current version = latest registry entry");
    assert(latest.summary.length > 10 && latest.effectiveFrom.length >= 8, "registry entries carry audit metadata");

    // 2. Live WA grant threads the inbound wamid into proofWamid.
    const phone = world.newPhone("441");
    const wamid = `wamid.j441-${Date.now()}`;
    await world.text(phone, "hello", { id: `${wamid}-hello` });
    await world.text(phone, "YES", { id: wamid });
    const [row] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone)));
    assert(row?.granted === true, "granted");
    assert(row.proofWamid === wamid, `proofWamid recorded (got ${row.proofWamid})`);
    assert(row.policyVersion === consent.CONSENT_POLICY_VERSION, "current policy version stamped");
    assert(row.proofTemplate === consent.CONSENT_PROOF_TEMPLATE, "proof template stamped");

    // 3. ONB-B-13: hasConsent ignores a withdrawn row even if granted=true.
    const phone2 = world.newPhone("441b");
    await consent.recordConsent(world.db, { tenantId: TENANT_ID, phone: phone2, granted: true });
    assert(await consent.hasConsent(TENANT_ID, phone2) === true, "granted → hasConsent true");
    await world.db.update(schema.consents)
      .set({ withdrawnAt: new Date() })
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone2)));
    assert(await consent.hasConsent(TENANT_ID, phone2) === false, "granted+withdrawn → hasConsent false (aligned)");
  },
};
