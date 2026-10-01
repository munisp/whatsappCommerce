// === W57 risk-shield ===
/**
 * J585 — WA+TG parity of the new merchant-facing keyword "CREDIT RISK
 * <customer>": identical deterministic replies on both channels, admin-phone
 * authz on both, frozen/default/clear status strings localized, and the
 * cross-tenant aggregate leaks only bool+count.
 */
import { assert, TENANT_ID, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J585",
  name: "WA+TG parity of 'credit risk <customer>' keyword",
  feature: "W57 risk-shield F1: credit risk keyword parity",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const chat = await import("../../server/services/creditIntelligenceChat");
    const ig = await import("../../server/services/identityGraph");
    const reg = await import("../../server/services/creditDefaultRegistry");

    const adminPhone = world.newPhone("585a");
    await world.patchTenantSettings({ adminPhone });

    const phone = world.newPhone("585");
    const customerId = `cust-j585-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J585 Buyer",
    }).onConflictDoNothing();

    // ── 1. Admin authz gates both channels identically ───────────────────
    for (const channel of ["whatsapp", "telegram"] as const) {
      const stranger = await chat.handleCreditIntelCommand({
        db: world.db as any, tenantId: TENANT_ID, fromPhone: world.newPhone("585x"),
        text: `CREDIT RISK ${phone}`, channel,
      });
      assert(stranger.handled === false, `non-admin falls through on ${channel}`);
    }

    // ── 2. Clear status: identical WA/TG replies ─────────────────────────
    const wa1 = await chat.handleCreditIntelCommand({
      db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
      text: `CREDIT RISK ${phone}`, channel: "whatsapp",
    });
    const tg1 = await chat.handleCreditIntelCommand({
      db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
      text: `CREDIT RISK ${phone}`, channel: "telegram",
    });
    assert(wa1.handled && tg1.handled, "credit risk handled on both channels");
    assert(wa1.reply === tg1.reply, "WA and TG replies identical (parity)");
    assert(/\/1000/.test(wa1.reply!), "reply carries the score");

    // ── 3. Frozen status surfaces identically ────────────────────────────
    await ig.recordSignupIdentity(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, subjectType: "merchant", subjectId: "merch-j585-default", phone,
    });
    await reg.recordDefault(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, accountId: `acct-j585-${phone.slice(-6)}`,
      amountCents: 99_000_00, subjectType: "merchant", subjectId: "merch-j585-default",
    });
    await ig.recordSignupIdentity(world.db as any, {
      tenantId: TENANT_ID, subjectType: "buyer", subjectId: customerId, phone,
    });
    const wa2 = await chat.handleCreditIntelCommand({
      db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
      text: `CREDIT RISK ${phone}`, channel: "whatsapp",
    });
    const tg2 = await chat.handleCreditIntelCommand({
      db: world.db as any, tenantId: TENANT_ID, fromPhone: adminPhone,
      text: `CREDIT RISK ${phone}`, channel: "telegram",
    });
    assert(wa2.reply === tg2.reply, "frozen replies identical on WA+TG");
    assert(/FROZEN/i.test(wa2.reply!), "frozen status surfaced to the merchant");
    assert(!/99,000|9900000/.test(wa2.reply!), "PRIVACY: no default amount leaked in the reply");

    // ── 4. Parser: keyword shape is deterministic ────────────────────────
    const p = chat.parseCreditIntelCommand(`CREDIT RISK ${phone}`);
    assert(p?.cmd === "creditRisk" && p.ref === phone, "parser recognizes CREDIT RISK <ref>");
    assert(chat.parseCreditIntelCommand("CREDIT RISK") == null, "bare CREDIT RISK falls through");
  },
};
