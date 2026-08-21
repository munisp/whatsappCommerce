/**
 * J138 — Merchant credit score determinism from seeded history:
 * a dedicated merchant tenant with a fully controlled 90d history (10
 * delivered ₦5,000 orders, 1 cancelled, 10 completed payments, 200-day
 * tenure) is scored by the REAL getMerchantScore (frozen contract) twice —
 * identical {score, factors} both times, matching the pure scoring core
 * exactly; the cache row persists; and a signed credit certificate issues
 * and verifies (and detects tampering).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedCreditMerchant, CREDIT_MERCHANT_ID } from "./creditSeed";

export const journey: Journey = {
  id: "J138",
  name: "merchant credit score determinism",
  feature: "getMerchantScore (frozen contract) + credit certificate",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { getMerchantScore, computeScoreFromSignals } = await import("../../server/services/creditScore");
    const seed = await seedCreditMerchant(world);

    // ── 1. Score twice via the real db-backed contract → identical ──────
    const a = await getMerchantScore(CREDIT_MERCHANT_ID, CREDIT_MERCHANT_ID, world.db);
    const b = await getMerchantScore(CREDIT_MERCHANT_ID, CREDIT_MERCHANT_ID, world.db);
    assert(a.score === b.score, `score deterministic (${a.score} vs ${b.score})`);
    assert(JSON.stringify(a.factors) === JSON.stringify(b.factors), "factors deterministic");
    assert(a.score >= 0 && a.score <= 1000 && Number.isInteger(a.score), "score is an integer in [0,1000]");

    // ── 2. Exact match with the pure scoring core on the seeded signals ──
    const expected = computeScoreFromSignals({ ...seed.expected });
    assert(
      a.score === expected.score,
      `db-backed score == pure core (${a.score} vs ${expected.score})`,
    );
    assert(
      a.factors.salesVolumeCents90d === seed.expected.salesVolumeCents,
      `90d volume in integer cents (${a.factors.salesVolumeCents90d} vs ${seed.expected.salesVolumeCents})`,
    );
    assert(a.factors.tenure.days >= seed.expected.tenureDays, "tenure honoured");

    // ── 3. Cache row persisted (portable snapshot for other services) ────
    const rows = await world.db
      .select()
      .from(schema.merchantCreditScores)
      .where(eq(schema.merchantCreditScores.merchantId, CREDIT_MERCHANT_ID));
    assert(rows.length === 1, `exactly one cached score row (got ${rows.length})`);
    assert(rows[0].score === a.score, "cached score matches");

    // ── 4. Signed certificate issues + verifies + detects tampering ──────
    const { issueCreditCertificateTx, verifyPayload } = await import("../../server/services/creditCertificate");
    const cert = await issueCreditCertificateTx(world.db, CREDIT_MERCHANT_ID, CREDIT_MERCHANT_ID);
    assert(cert.payload.score === a.score, "certificate carries the score");
    assert(cert.signature.length === 64, "HMAC-SHA256 hex signature");
    assert(cert.html.includes(String(a.score)), "HTML renders the score");
    assert(verifyPayload(cert.payload, cert.signature), "signature verifies");
    assert(
      !verifyPayload({ ...cert.payload, score: cert.payload.score + 1 }, cert.signature),
      "tampered payload fails verification",
    );
    const certs = await world.db
      .select()
      .from(schema.merchantCreditCertificates)
      .where(eq(schema.merchantCreditCertificates.merchantId, CREDIT_MERCHANT_ID));
    assert(certs.length === 1, "certificate persisted (immutable audit row)");

    // ── 5. WhatsApp flow: CREDIT SCORE from the merchant admin phone ─────
    const { handleCreditCommand } = await import("../../server/services/creditWhatsApp");
    const adminPhone = "2348011100002";
    await world.db
      .update(schema.tenants)
      .set({ settings: { adminPhone }, updatedAt: new Date() })
      .where(eq(schema.tenants.id, CREDIT_MERCHANT_ID));
    const wa = await handleCreditCommand({
      db: world.db, tenantId: CREDIT_MERCHANT_ID, waPhoneNumber: adminPhone, text: "CREDIT SCORE",
    });
    assert(wa.handled === true, "admin CREDIT SCORE handled");
    assert(wa.reply!.includes(`${a.score}/1000`), "reply carries the score");
    assert(wa.reply!.includes("Order volume"), "reply carries factor highlights");
    const stranger = await handleCreditCommand({
      db: world.db, tenantId: CREDIT_MERCHANT_ID, waPhoneNumber: "2348099999999", text: "CREDIT SCORE",
    });
    assert(stranger.handled === false, "non-admin phone falls through to the buyer pipeline");
  },
};
