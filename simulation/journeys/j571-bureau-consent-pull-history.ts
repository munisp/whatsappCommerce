// === W56 credit ===
/**
 * J571 — Consent → pull → history, provider-agnostic: the sandbox adapter
 * returns a DETERMINISTIC fake report (same subject+consent → same report,
 * no network), the consent artefact is recorded BEFORE the pull, and the
 * pull history preserves provider/rawRef/consent linkage. A failing http
 * provider is fail-OPEN: an 'error' history row + {ok:false}, never a throw.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J571",
  name: "bureau consent → pull → history (deterministic + fail-open)",
  feature: "W56 bureau: pullCreditReport lifecycle",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const bureau = await import("../../server/services/bureau");

    const phone = world.newPhone("571");
    const customerId = `cust-j571-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J571 Buyer",
    }).onConflictDoNothing();

    const savedProvider = process.env.BUREAU_W56_PROVIDER;
    process.env.BUREAU_W56_PROVIDER = "sandbox";
    try {
      // Consent artefact BEFORE any pull.
      const consent = await bureau.recordBureauConsent(world.db as any, {
        tenantId: TENANT_ID, subjectType: "buyer", subjectId: customerId, channel: "whatsapp", locale: "en",
      });
      const consents = await world.db
        .select()
        .from(schema.bureauConsents)
        .where((await import("drizzle-orm")).eq(schema.bureauConsents.subjectId, customerId));
      assert(consents.length === 1 && consents[0].channel === "whatsapp", "consent artefact persisted with channel");

      // Two pulls → deterministic identical reports.
      const p1 = await bureau.pullCreditReport(world.db as any, {
        tenantId: TENANT_ID, subject: { subjectType: "buyer", subjectId: customerId, phone },
      });
      const p2 = await bureau.pullCreditReport(world.db as any, {
        tenantId: TENANT_ID, subject: { subjectType: "buyer", subjectId: customerId, phone },
      });
      assert(p1.ok && p2.ok, "both pulls succeed");
      assert(JSON.stringify(p1.report) === JSON.stringify(p2.report), "sandbox adapter is deterministic");
      assert(p1.report!.rawRef.startsWith("sandbox:"), "sandbox rawRef stamped");
      assert(p1.report!.score! >= 200 && p1.report!.score! <= 850, "sandbox score in the 200-850 band");

      const history = await bureau.listBureauPulls(world.db as any, TENANT_ID, "buyer", customerId);
      assert(history.length === 2, "both pulls in history");
      assert(history.every((h) => h.consentId === consent.id && h.provider === "sandbox"), "history links consent + provider");

      // Fail-open: a live 'crc' provider with a broken transport records an
      // error row and returns ok:false — it NEVER throws.
      const failing = {
        env: { BUREAU_W56_PROVIDER: "crc", CRC_BUREAU_URL: "http://bureau.sim.local/pull", CRC_BUREAU_API_KEY: "k" } as NodeJS.ProcessEnv,
        fetcher: (async () => ({ ok: false, status: 503, data: null })) as any,
      };
      const failed = await bureau.pullCreditReport(world.db as any, {
        tenantId: TENANT_ID, subject: { subjectType: "buyer", subjectId: customerId, phone },
      }, failing);
      assert(failed.ok === false && failed.error, `provider outage fails open (${failed.error})`);
      const after = await bureau.listBureauPulls(world.db as any, TENANT_ID, "buyer", customerId);
      assert(after.length === 3 && after[0].status === "error", "outage recorded as an error history row");
    } finally {
      if (savedProvider === undefined) delete process.env.BUREAU_W56_PROVIDER;
      else process.env.BUREAU_W56_PROVIDER = savedProvider;
    }
  },
};
