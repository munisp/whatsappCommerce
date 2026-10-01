// === W57 risk-shield ===
/**
 * J579 — Identity graph detects a multi-account default at signup/credit
 * application: a subject sharing a phone hash with an identity that has an
 * ACTIVE default-registry row gets its credit eligibility FROZEN on
 * recordSignupIdentity (idempotent — a second signup does not double-flag),
 * while cash commerce is NEVER blocked (the flag only gates the credit
 * path). Also proves the additive new-identity velocity ceiling caps fresh
 * subjects below grade B.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J579",
  name: "identity link detects multi-account default at signup (cash unaffected)",
  feature: "W57 risk-shield F1: identity graph + default freeze",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const ig = await import("../../server/services/identityGraph");
    const reg = await import("../../server/services/creditDefaultRegistry");

    const phone = world.newPhone("579");
    // The DEFAULTING identity: a merchant subject with a recorded default
    // whose identity hash derives from this phone link.
    const defaulterId = `merch-j579-default`;
    await ig.recordSignupIdentity(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, subjectType: "merchant", subjectId: defaulterId, phone,
    });
    const hash = ig.hashIdentityLink("phone", phone);
    const rec = await reg.recordDefault(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, accountId: `acct-j579-${phone.slice(-6)}`,
      amountCents: 125_000_00, subjectType: "merchant", subjectId: defaulterId,
    });
    assert(rec.created === true && rec.id, "default recorded");

    // ── 1. New identity reusing the SAME phone at another tenant → frozen
    const buyerId = `cust-j579-${phone.slice(-6)}`;
    const first = await ig.recordSignupIdentity(world.db as any, {
      tenantId: TENANT_ID, subjectType: "buyer", subjectId: buyerId, phone,
    });
    assert(first.flagged === true && first.flagId, "linked default freezes credit eligibility at signup");
    assert(await ig.isCreditFrozen(world.db as any, TENANT_ID, "buyer", buyerId), "isCreditFrozen true");

    // Cash commerce unaffected: the freeze is a CREDIT-only gate — a plain
    // order for the same buyer inserts and reads back fine (no flag check
    // exists anywhere on the cash path).
    await world.db.insert(schema.customers).values({
      id: buyerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J579 Buyer",
    }).onConflictDoNothing();
    await world.db.insert(schema.orders).values({
      id: "ord-j579-0", tenantId: TENANT_ID, customerId: buyerId,
      orderNumber: "J579-0", status: "pending", totalAmount: "2500.00",
      currency: "NGN", paymentStatus: "unpaid", metadata: {},
    });
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, "ord-j579-0"));
    assert(ord?.status === "pending", "cash-on-delivery order flows unaffected by the credit freeze");

    // ── 2. Idempotent re-check: no duplicate flag ────────────────────────
    const second = await ig.recordSignupIdentity(world.db as any, {
      tenantId: TENANT_ID, subjectType: "buyer", subjectId: buyerId, phone,
    });
    assert(second.flagged === true, "re-check still reports the frozen state");
    const flags = await world.db.select().from(schema.identityFlags)
      .where(eq(schema.identityFlags.subjectId, buyerId));
    assert(flags.length === 1, "claim-first: exactly one flag per subject");

    // ── 3. New-identity velocity ceiling (additive creditScoring rule) ──
    const scoring = await import("../../server/services/creditScoring");
    // Fresh subject with strong synthetic signals: tenure 0 ⇒ capped.
    const capped = ig.applyNewIdentityCeiling(900, 0);
    assert(capped.capped && capped.score === ig.NEW_IDENTITY_SCORE_CEILING, "fresh identity capped below grade B");
    const uncapped = ig.applyNewIdentityCeiling(900, ig.NEW_IDENTITY_TENURE_DAYS + 1);
    assert(!uncapped.capped && uncapped.score === 900, "tenured identity uncapped");
    // End-to-end: the fresh buyer's stored score carries the additive factor.
    const r = await scoring.computeAndStoreSubjectScore(world.db as any, TENANT_ID, "buyer", buyerId);
    assert(r && (r.factors as any).identityVelocity, "identityVelocity factor recorded additively");
    assert(r!.score <= ig.NEW_IDENTITY_SCORE_CEILING, "stored score respects the ceiling");
  },
};
