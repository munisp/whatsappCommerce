// === W56 credit ===
/**
 * J573 — WA+TG parity of the credit-intelligence keywords: the SAME
 * deterministic handler serves both channels (channel-stamped consent
 * artefacts prove which channel ran), admin-phone authz gates both, the
 * bureau flow is consent-first on both (BUREAU CHECK shows the consent
 * text and NEVER auto-pulls; BUREAU CONFIRM records + pulls), and the
 * localized catalog covers all 8 locales.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J573",
  name: "WA+TG parity of credit score / bureau keywords",
  feature: "W56 credit chat: admin-gated score + consent-first bureau flow",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const chat = await import("../../server/services/creditIntelligenceChat");
    const i18n = await import("../../server/services/i18n");

    const adminPhone = world.newPhone("573a");
    // Merge, never replace: a raw `set({ settings: { adminPhone } })` drops
    // the seeded whatsapp.accessToken and silently flips every later WA send
    // for sim-tenant into the no-credential SIMULATION branch (J578).
    await world.patchTenantSettings({ adminPhone });

    const phone = world.newPhone("573");
    const customerId = `cust-j573-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J573 Buyer",
    }).onConflictDoNothing();
    await world.db.insert(schema.orders).values({
      id: "ord-j573-0", tenantId: TENANT_ID, customerId,
      orderNumber: "J573-0", status: "delivered", totalAmount: "7000.00",
      currency: "NGN", paymentStatus: "completed", metadata: {},
    });

    const savedProvider = process.env.BUREAU_W56_PROVIDER;
    process.env.BUREAU_W56_PROVIDER = "sandbox";
    try {
      // ── 1. Admin authz gates both channels identically ─────────────────
      for (const channel of ["whatsapp", "telegram"] as const) {
        const stranger = await chat.handleCreditIntelCommand({
          db: world.db as any, tenantId: TENANT_ID, fromPhone: world.newPhone("573x"),
          text: `CREDIT SCORE ${phone}`, channel,
        });
        assert(stranger.handled === false, `non-admin falls through on ${channel}`);
      }

      // ── 2. CREDIT SCORE <phone> parity ─────────────────────────────────
      const wa = await chat.handleCreditIntelCommand({
        db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
        text: `CREDIT SCORE ${phone}`, channel: "whatsapp",
      });
      const tg = await chat.handleCreditIntelCommand({
        db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
        text: `CREDIT SCORE ${phone}`, channel: "telegram",
      });
      assert(wa.handled && tg.handled, "score keyword handled on both channels");
      assert(/\/1000/.test(wa.reply!) && /grade [A-E]/.test(wa.reply!), "WA reply carries score + grade");
      assert(wa.reply === tg.reply, "WA and TG replies are identical (parity)");

      // Unknown subject → honest not-found on both channels.
      const nf = await chat.handleCreditIntelCommand({
        db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
        text: "CREDIT SCORE 2340000000000", channel: "telegram",
      });
      assert(nf.handled && /couldn't find/i.test(nf.reply!), "honest not-found reply");

      // ── 3. Bureau consent-first flow, TG channel ───────────────────────
      const check = await chat.handleCreditIntelCommand({
        db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
        text: `BUREAU CHECK ${phone}`, channel: "telegram",
      });
      assert(check.handled && /consent/i.test(check.reply!), "BUREAU CHECK shows the consent text");
      assert(check.reply!.includes(i18n.BUREAU_CONSENT_TEXT.en.slice(0, 40)), "the exact BUREAU_CONSENT_TEXT is shown");
      const pullsBefore = await world.db
        .select()
        .from(schema.bureauPulls)
        .where(eq(schema.bureauPulls.subjectId, customerId));
      assert(pullsBefore.length === 0, "BUREAU CHECK never auto-pulls");

      const confirm = await chat.handleCreditIntelCommand({
        db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
        text: `BUREAU CONFIRM ${phone}`, channel: "telegram",
      });
      assert(confirm.handled && /Bureau report/.test(confirm.reply!), "BUREAU CONFIRM records consent and pulls");
      const consents = await world.db
        .select()
        .from(schema.bureauConsents)
        .where(eq(schema.bureauConsents.subjectId, customerId));
      assert(consents.length === 1 && consents[0].channel === "telegram", "consent artefact stamped with the TG channel");
      const pullsAfter = await world.db
        .select()
        .from(schema.bureauPulls)
        .where(eq(schema.bureauPulls.subjectId, customerId));
      assert(pullsAfter.length === 1 && pullsAfter[0].provider === "sandbox", "pull recorded via the sandbox adapter");

      // ── 4. With consent on file, BUREAU CHECK pulls directly (WA) ──────
      const checkWa = await chat.handleCreditIntelCommand({
        db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
        text: `BUREAU CHECK ${phone}`, channel: "whatsapp",
      });
      assert(checkWa.handled && /Bureau report/.test(checkWa.reply!), "consented subject → direct pull on WA");
      // Deterministic adapter → same summary figures as the TG pull.
      assert(checkWa.reply === confirm.reply, "WA and TG bureau summaries are identical (deterministic)");

      // ── 5. Catalog covers all 8 locales for the new keys ───────────────
      for (const key of ["creditScoreLine", "creditScoreNotFound", "bureauConsentPrompt", "bureauPullSummary"] as const) {
        for (const locale of i18n.SUPPORTED_LOCALES) {
          const rendered = i18n.t27(locale, key, { subject: "X", score: 1, grade: "A", ref: "r", consentText: "c", provider: "p", facilities: 0, defaults: 0, channel: "whatsapp" });
          assert(rendered.length > 0, `${key} renders in ${locale}`);
        }
      }
    } finally {
      if (savedProvider === undefined) delete process.env.BUREAU_W56_PROVIDER;
      else process.env.BUREAU_W56_PROVIDER = savedProvider;
    }
  },
};
