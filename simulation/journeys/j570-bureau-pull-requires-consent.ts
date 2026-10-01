// === W56 credit ===
/**
 * J570 — Bureau pull is BLOCKED without a recorded consent artefact:
 * no consent → { ok:false, error:'consent_required' }, NO provider call,
 * NO pull-history row. Revoking consent blocks subsequent pulls again
 * (NDPR data-subject right).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J570",
  name: "bureau pull requires consent (no consent → blocked)",
  feature: "W56 bureau: consent-gated pulls, fail-closed on consent",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const bureau = await import("../../server/services/bureau");

    const phone = world.newPhone("570");
    const customerId = `cust-j570-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J570 Buyer",
    }).onConflictDoNothing();

    // Force a live provider so ONLY consent can block the pull.
    const savedProvider = process.env.BUREAU_W56_PROVIDER;
    process.env.BUREAU_W56_PROVIDER = "sandbox";
    try {
      // ── 1. No consent → blocked, no provider call, no history row ──────
      const denied = await bureau.pullCreditReport(world.db as any, {
        tenantId: TENANT_ID,
        subject: { subjectType: "buyer", subjectId: customerId, phone },
      });
      assert(denied.ok === false && denied.error === "consent_required", `no consent → blocked (${JSON.stringify(denied)})`);
      assert(denied.pullId === null && denied.report === null, "no artefact created on a blocked pull");
      const noRows = await world.db
        .select()
        .from(schema.bureauPulls)
        .where(eq(schema.bureauPulls.subjectId, customerId));
      assert(noRows.length === 0, "blocked pull leaves NO history row");

      // ── 2. Consent → pull succeeds (deterministic sandbox) ─────────────
      const consent = await bureau.recordBureauConsent(world.db as any, {
        tenantId: TENANT_ID, subjectType: "buyer", subjectId: customerId, channel: "portal", locale: "en",
      });
      assert(consent.id && consent.consentTextVersion === "w14-v1", "consent artefact stamped with the text version");
      assert(consent.consentText.length > 20, "exact consent text snapshotted");

      const ok = await bureau.pullCreditReport(world.db as any, {
        tenantId: TENANT_ID,
        subject: { subjectType: "buyer", subjectId: customerId, phone },
      });
      assert(ok.ok === true && ok.report && ok.provider === "sandbox", "consent → pull succeeds");
      const history = await bureau.listBureauPulls(world.db as any, TENANT_ID, "buyer", customerId);
      assert(history.length === 1 && history[0].status === "ok", "pull recorded in history");
      assert(history[0].consentId === consent.id, "history row references the consent artefact");

      // ── 3. Revoke → pulls blocked again ────────────────────────────────
      const revoked = await bureau.revokeBureauConsent(world.db as any, TENANT_ID, "buyer", customerId);
      assert(revoked === 1, "one live artefact revoked");
      const deniedAgain = await bureau.pullCreditReport(world.db as any, {
        tenantId: TENANT_ID,
        subject: { subjectType: "buyer", subjectId: customerId, phone },
      });
      assert(deniedAgain.ok === false && deniedAgain.error === "consent_required", "revoked consent blocks the pull again");
    } finally {
      if (savedProvider === undefined) delete process.env.BUREAU_W56_PROVIDER;
      else process.env.BUREAU_W56_PROVIDER = savedProvider;
    }
  },
};
