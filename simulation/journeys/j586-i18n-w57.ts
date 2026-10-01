// === W57 risk-shield ===
/**
 * J586 — i18n ×8 completeness for all W57 strings (MESSAGE_CATALOG): every
 * locale renders each new key with its OWN translation (not the English
 * fallback), variables interpolate via t27, and the identity-hash helper
 * never stores raw BVN/NIN (hash shape + normalization checks).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const W57_KEYS = [
  "creditRiskLine",
  "creditRiskStatusClear",
  "creditRiskStatusDefault",
  "creditRiskStatusFrozen",
  "identityFlagDisputed",
] as const;

export const journey: Journey = {
  id: "J586",
  name: "i18n ×8 completeness for W57 risk-shield strings",
  feature: "W57 risk-shield: MESSAGE_CATALOG coverage",
  async run(world: World) {
    const i18n = await import("../../server/services/i18n");

    // ── 1. Every locale carries every W57 key with its own translation ───
    for (const key of W57_KEYS) {
      const en = (i18n.MESSAGE_CATALOG.en as any)[key];
      assert(typeof en === "string" && en.length > 10, `en ${key} present`);
      for (const loc of i18n.SUPPORTED_LOCALES) {
        const v = (i18n.MESSAGE_CATALOG as any)[loc]?.[key];
        assert(typeof v === "string" && v.length > 5, `${loc} ${key} present`);
        if (loc !== "en") assert(v !== en, `${loc} ${key} is NOT the English fallback`);
        assert(i18n.t27(loc as any, key as any, { subject: "X", score: 1, grade: "C", status: "s", count: 2 }) === v
          .replace("{subject}", "X").replace("{score}", "1").replace("{grade}", "C").replace("{status}", "s").replace("{count}", "2"),
          `${loc} ${key} interpolates via t27`);
      }
    }

    // ── 2. Hashing: raw BVN/NIN never persist; normalization stable ──────
    const ig = await import("../../server/services/identityGraph");
    const h1 = ig.hashIdentityLink("bvn", "22223333444");
    const h2 = ig.hashIdentityLink("bvn", " 2222 3333 444 ");
    assert(h1 === h2, "BVN normalization is stable");
    assert(/^[0-9a-f]{64}$/.test(h1), "hash is HMAC-SHA256 hex");
    assert(!h1.includes("2222"), "raw BVN never appears in the stored hash");
    assert(ig.normalizeLinkValue("email", " A@B.COM ") === "a@b.com", "email normalized lowercase");
    assert(ig.normalizeLinkValue("phone", "+234 803 000") === "+234803000", "phone normalized");

    // ── 3. Recorded links hold hashes only ───────────────────────────────
    const phone = world.newPhone("586");
    const subjectId = `cust-j586-${phone.slice(-6)}`;
    await ig.recordSignupIdentity(world.db as any, {
      tenantId: TENANT_ID, subjectType: "buyer", subjectId, phone, bvn: "22223333444",
    });
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const links = await world.db.select().from(schema.identityLinks)
      .where(eq(schema.identityLinks.subjectId, subjectId));
    assert(links.length === 2, "phone + bvn links recorded");
    for (const l of links) {
      assert(/^[0-9a-f]{64}$/.test(l.linkHash), `${l.linkType} stored as hash only`);
    }
  },
};
