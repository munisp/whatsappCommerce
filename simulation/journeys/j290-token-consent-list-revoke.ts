/**
 * === W41 Coder A (UC-6) ===
 * J290 — Token save / consent / list / revoke:
 *   1. Saving without explicit consent is refused (fail closed); a PAN-like
 *      value is refused.
 *   2. A consented save stores the token v1:-encrypted (never plaintext)
 *      and list returns only safe fields.
 *   3. Revoke flips active → revoked; charging a revoked token fails closed.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J290",
  name: "customer payment token consent + list + revoke (UC-6)",
  feature: "customerPaymentTokens: consent fail-closed, v1: encryption, masked list, revoke → charge refused",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const tokensSvc = await import("../../server/services/customerPaymentTokens");
    const secrets = await import("../../server/services/crypto/secrets");
    const db = world.db;
    const buyer = "2348000000290";

    // ── 1. Consent gate ──────────────────────────────────────────────────
    let noConsent: any = null;
    try {
      await tokensSvc.saveCustomerToken(db, {
        tenantId: TENANT_ID, buyerPhone: buyer, provider: "fake",
        token: "fake-auth-j290", consentText: "",
      });
    } catch (e: any) { noConsent = e; }
    assert(noConsent, "save without consent must throw");
    assertIncludes(String(noConsent?.message ?? noConsent), "consent", "honest consent message");

    let pan: any = null;
    try {
      await tokensSvc.saveCustomerToken(db, {
        tenantId: TENANT_ID, buyerPhone: buyer, provider: "fake",
        token: "5399830000000008", consentText: tokensSvc.tokenConsentPrompt(null),
      });
    } catch (e: any) { pan = e; }
    assert(pan, "PAN-like value must be refused");

    // ── 2. Consented save → encrypted, safe list ─────────────────────────
    const saved = await tokensSvc.saveCustomerToken(db, {
      tenantId: TENANT_ID, buyerPhone: buyer, provider: "fake",
      token: "fake-auth-j290", displayLabel: "Dev card •••• 0290",
      consentText: tokensSvc.tokenConsentPrompt("Dev card •••• 0290"),
    });
    assert(saved.id, "token saved");
    assert(saved.tokenEnc.startsWith("v1:"), "stored encrypted v1:");
    assert(!saved.tokenEnc.includes("fake-auth-j290"), "never plaintext");
    assert(secrets.decryptSecret(saved.tokenEnc) === "fake-auth-j290", "decrypts to the handle");

    const list = await tokensSvc.listCustomerTokens(db, TENANT_ID, buyer);
    assert(list.length === 1, `one active token listed, got ${list.length}`);
    assert(list[0].displayLabel === "Dev card •••• 0290", "masked label shown");
    assert((list[0] as any).tokenEnc === undefined, "list never exposes the token");

    // Charge works while active (fake rail, dev).
    const charge = await tokensSvc.chargeCustomerToken(db, {
      tenantId: TENANT_ID, tokenId: saved.id, amountCents: 100_00,
      reference: `j290-charge-${Date.now()}`,
    });
    assert(charge.ok === true && charge.status === "success", `active token charges, got ${JSON.stringify(charge)}`);

    // ── 3. Revoke → charge fails closed ──────────────────────────────────
    const revoked = await tokensSvc.revokeCustomerToken(db, { tenantId: TENANT_ID, buyerPhone: buyer, tokenId: saved.id });
    assert(revoked.ok === true, "revoke succeeds");
    const [row] = await db.select().from(schema.customerPaymentTokens)
      .where(eq(schema.customerPaymentTokens.id, saved.id)).limit(1);
    assert(row?.status === "revoked" && row?.revokedAt != null, "status flipped + audit timestamp");
    const afterList = await tokensSvc.listCustomerTokens(db, TENANT_ID, buyer);
    assert(afterList.length === 0, "revoked token no longer listed");
    const chargeAfter = await tokensSvc.chargeCustomerToken(db, {
      tenantId: TENANT_ID, tokenId: saved.id, amountCents: 100_00,
      reference: `j290-charge2-${Date.now()}`,
    });
    assert(chargeAfter.ok === false, "revoked token refuses to charge (fail closed)");
  },
};
